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

/**
 * Three-way session probe. `hasSession` collapses the last two into `false`, which is the SAFE
 * reading for "should I deliver?" (don't, if unsure) but the WRONG one for any decision that acts
 * on a session being *gone*.
 *
 *   present — tmux confirmed the session exists (exit 0)
 *   absent  — tmux confirmed it does not (exit 1; also covers "no server running", where every
 *             session is genuinely gone)
 *   unknown — we could not ask: the call failed, or was SIGKILLed by TMUX_TIMEOUT_MS (code -1)
 *
 * The distinction is load-bearing for orphan-requeue (kanban aba29f60): treating `unknown` as
 * "dead" would re-deliver a message to an agent that is alive and currently working on it — the
 * automated, fleet-wide version of the duplicate-delivery bug we hit by hand on 2026-08-01.
 * Requeue on `absent` only. Exit codes verified empirically against tmux 3.x on this box.
 */
export type SessionState = "present" | "absent" | "unknown";

export function sessionState(socket: string, name: string): SessionState {
  const code = tmux(socket, ["has-session", "-t", name]).code;
  if (code === 0) return "present";
  if (code === 1) return "absent";
  return "unknown";
}

/** A session's state plus, when present, a stable id for THIS INSTANCE of it. */
export interface SessionInstance {
  state: SessionState;
  /** `$<session_id>:<session_created>`; null unless state === "present". */
  ref: string | null;
}

/**
 * Identify which INSTANCE of a session is running. Orphan-requeue (kanban aba29f60) keys on this
 * rather than on mere existence: after an OOM relaunch the agent is "present" again but is a
 * DIFFERENT instance holding none of the context, which is exactly how owner msg 9766 was lost.
 *
 * Deliberately uses list-sessions, NOT `display-message -p -t <name>`. display-message returns
 * EXIT 0 AND A PLAUSIBLE-LOOKING REF (":") for a session that does not exist — a confidently wrong
 * answer of the same shape as the pgrep traps, and it would have minted a valid-looking instance id
 * for a dead agent. list-sessions can only report sessions that actually exist. Verified against
 * tmux on this box: server absent -> exit 1 (every session genuinely gone), missing name -> no row.
 */
export function sessionInstance(socket: string, name: string): SessionInstance {
  const r = tmux(socket, ["list-sessions", "-F", "#{session_name}\t#{session_id}:#{session_created}"]);
  if (r.code === 1) return { state: "absent", ref: null }; // no server running => all sessions gone
  if (r.code !== 0) return { state: "unknown", ref: null }; // -1 = timed out / could not ask
  for (const line of r.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    if (line.slice(0, tab) !== name) continue;
    const ref = line.slice(tab + 1).trim();
    // Present but no usable ref = we cannot identify the instance; never guess one.
    return ref && ref !== ":" ? { state: "present", ref } : { state: "unknown", ref: null };
  }
  return { state: "absent", ref: null };
}

/** True only when the session is CONFIRMED present. "Cannot tell" reads as false — safe for
 *  gating delivery, unsafe for concluding an agent died. Use sessionState() for the latter. */
export function hasSession(socket: string, name: string): boolean {
  return sessionState(socket, name) === "present";
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
  /** tmux -e: keep the ANSI escape sequences. Required to tell Claude's DIM ghost hint in an empty
   *  composer from real parked text — plain capture renders both as the same characters, which wedged
   *  four agents' inboxes on 2026-08-02. Pair with stripPaneStyling() to get the plain view back. */
  escapes?: boolean;
}

export function capturePane(socket: string, name: string, opts: CaptureOpts = {}): string | null {
  const args = ["capture-pane", "-t", name, "-p"];
  if (opts.join) args.push("-J");
  if (opts.escapes) args.push("-e");
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

/**
 * Clear a parked draft from the input box.
 *
 * C-u clears to the start of the LINE, so ONE press cannot clear a MULTI-LINE draft. That was the
 * 2026-08-01 residue bug (kanban b4802f1d): an aborted delivery left ~12 of 13 lines parked, six
 * aborts stacked six partial copies, and 77 minutes later an unrelated OWNER message typed into the
 * same box and pressed Enter — submitting the whole pile as one prompt.
 *
 * `lines` is how many lines the caller may have left behind; we press C-u once per line plus one.
 * The press count is best-effort — callers MUST verify with detectPaneState rather than trust it.
 */
export function clearInput(socket: string, name: string, lines = 1): void {
  for (let i = 0; i <= Math.max(1, lines); i++) sendKey(socket, name, "C-u");
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
