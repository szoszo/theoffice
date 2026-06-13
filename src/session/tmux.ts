import { spawnSync } from "node:child_process";

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
  const r = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
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

export function capturePane(socket: string, name: string): string | null {
  const r = tmux(socket, ["capture-pane", "-t", name, "-p"]);
  return r.code === 0 ? r.stdout : null;
}

/** Send literal text (no key interpretation). */
export function sendText(socket: string, name: string, text: string): void {
  tmux(socket, ["send-keys", "-t", name, "-l", text]);
}

/** Send a named key / chord, e.g. "Enter", "C-u", "Escape". */
export function sendKey(socket: string, name: string, key: string): void {
  tmux(socket, ["send-keys", "-t", name, key]);
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
  const r = tmux(socket, ["new-session", "-d", "-s", name, "-c", opts.cwd, cmd]);
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
