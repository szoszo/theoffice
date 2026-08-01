import { spawnSync } from "node:child_process";
import { log } from "../logger.js";

const logger = log("session");

// Hard ceiling on any single tmux invocation. A tmux subcommand (has-session, capture-pane, send-keys,
// new-session -d) normally returns in well under 100ms. But tmux() is spawnSync — SYNCHRONOUS — so a call
// that HANGS (wedged pane whose process is in D-state, an unresponsive tmux server under memory pressure,
// etc.) blocks the entire Node event loop for as long as it hangs, freezing the scheduler, the deliverer,
// session relaunch, AND the Slack keepalive with it. That is exactly the 2026-07-28 incident: one tmux call
// hung ~2h and every timer stopped until it returned. Bounding the call caps the worst-case loop stall: a
// timed-out call is SIGKILLed and returns code -1, which callers already treat as "not ready / no session"
// and retry on the next tick — degraded, not frozen.
const TMUX_TIMEOUT_MS = 10_000;

/**
 * Thin wrapper over `tmux -L <socket> ...`. Every call is pinned to a dedicated
 * server socket (default "theoffice") so this engine's tmux server is physically
 * isolated from any other tmux server on the box — it cannot see, drive, or kill
 * sessions belonging to a different fleet (e.g. a v1 install on the default socket).
 *
 * No shell is used for the tmux process itself (spawnSync with arg array), so
 * session names / targets can't be shell-injected. The agent COMMAND that tmux
 * launches is run by tmux via /bin/sh -c, so that string is composed with
 * explicit single-quote escaping (see shq).
 */

function tmux(socket: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
    timeout: TMUX_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // spawnSync sets `error` (ETIMEDOUT) and leaves status null when the timeout fires. Surface it so a
  // wedged tmux is VISIBLE next time instead of a silent multi-hour freeze; callers see code -1 and retry.
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    logger.warn({ socket, cmd: args[0], timeoutMs: TMUX_TIMEOUT_MS }, "tmux call timed out — killed, treated as failure");
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Single-quote a value for safe inclusion in a /bin/sh command line. */
export function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Session name convention for an agent. The one place this string is built. */
export function sessionNameFor(agentId: string): string {
  return `agent-${agentId}`;
}

export function hasSession(socket: string, name: string): boolean {
  return tmux(socket, ["has-session", "-t", name]).code === 0;
}

export function listSessions(socket: string): string[] {
  const r = tmux(socket, ["list-sessions", "-F", "#{session_name}"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export interface CaptureOpts {
  /** tmux -J: rejoin hard-wrapped lines. Needed when reading a long unbroken string (e.g. an OAuth
   *  URL) out of a pane — without it the value comes back split across rows at the pane width. */
  join?: boolean;
  /** tmux -S: start line, negative = scrollback (e.g. -200 for the last 200 lines incl. history). */
  start?: number;
}

export function capturePane(socket: string, name: string, opts: CaptureOpts = {}): string | null {
  const args = ["capture-pane", "-t", name, "-p"];
  if (opts.join) args.push("-J");
  if (opts.start !== undefined) args.push("-S", String(opts.start));
  const r = tmux(socket, args);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Send literal text (no key interpretation). Returns whether tmux accepted it.
 *
 * The return value is LOAD-BEARING: prompts are typed in chunks, so a caller that discards it will
 * silently punch a hole in the middle of a message and submit the remains (kanban d6ada913 — an
 * inter-agent authorisation was deleted this way on 2026-08-01). A timed-out call returns code -1
 * via the TMUX_TIMEOUT_MS path above, which lands here as `false` rather than as a hang.
 */
export function sendText(socket: string, name: string, text: string): boolean {
  return tmux(socket, ["send-keys", "-t", name, "-l", text]).code === 0;
}

/** Send a named key / chord, e.g. "Enter", "C-u", "Escape". Returns whether tmux accepted it. */
export function sendKey(socket: string, name: string, key: string): boolean {
  return tmux(socket, ["send-keys", "-t", name, key]).code === 0;
}

/** Clear any parked draft in the input box. */
export function clearInput(socket: string, name: string): void {
  sendKey(socket, name, "C-u");
}

export interface NewSessionOpts {
  cwd: string;
  /** the program to run (argv); composed into a single sh -c command */
  command: string[];
  /** command-scoped env (prefixed as `env K=V ...`, never leaked to siblings) */
  env?: Record<string, string>;
  /** pane width/height. A DETACHED session is 80x24 by default no matter what COLUMNS/LINES say, so
   *  set these explicitly when the pane content must not hard-wrap. */
  width?: number;
  height?: number;
}

/**
 * Create a detached session running `command` in `cwd` with command-scoped env.
 * Returns true on success. Idempotent guard: refuses if the session exists.
 */
export function newSession(socket: string, name: string, opts: NewSessionOpts): boolean {
  if (hasSession(socket, name)) return false;
  const envPrefix = opts.env
    ? "env " + Object.entries(opts.env).map(([k, v]) => `${k}=${shq(v)}`).join(" ") + " "
    : "";
  const cmd = envPrefix + opts.command.map(shq).join(" ");
  const size = opts.width && opts.height ? ["-x", String(opts.width), "-y", String(opts.height)] : [];
  const r = tmux(socket, ["new-session", "-d", "-s", name, ...size, "-c", opts.cwd, cmd]);
  return r.code === 0;
}

export function killSession(socket: string, name: string): void {
  tmux(socket, ["kill-session", "-t", name]);
}

/** Ensure the dedicated tmux server is up (no-op if already running). */
export function ensureServer(socket: string): void {
  // starting the server with a throwaway keepalive session is handled by the
  // systemd tmux unit in production; in dev this lazily starts it.
  if (listSessions(socket).length === 0 && !hasSession(socket, "__keepalive")) {
    tmux(socket, ["new-session", "-d", "-s", "__keepalive", "sleep 86400"]);
  }
}
