#!/usr/bin/env node
/**
 * Guarded re-embed driver — capacity guard around the EXISTING backfillEmbeddings().
 *
 * WHY THIS EXISTS. On 2026-08-03 this LXC filled the Proxmox host's 4GB swap and Szoszo had to
 * MANUALLY REBOOT the whole server; his camera system (frigate, on the host) starved. The root
 * cause was the embedding model going 274MB -> 1.2GB with no capacity review. Re-embedding 3046
 * rows is a sustained burst of exactly that workload, so this guard is the thing standing between
 * him and a second manual reboot. It is not paperwork.
 *
 * WHAT THIS IS NOT. It does NOT reimplement the embed loop. backfillEmbeddings() is already
 * resumable, idempotent and atomic per row: it selects `WHERE embedding IS NULL OR
 * json_array_length(embedding) != EXPECTED_DIM`, and attachEmbedding() is a single atomic UPDATE
 * that never throws. A rewrite would have to re-prove all three. So we only wrap it.
 *
 * THE FAILURE THIS PRIMARILY GUARDS AGAINST (Toby's item 7, and it is NOT hypothetical —
 * ollama was OOM-killed 3x at 02:01-02:02 tonight under ordinary load, before any burst):
 * embed-cli breaks its loop when a batch returns written===0 and reports as if finished. A
 * transient ollama OOM therefore looks identical to "drained" and would SILENTLY HALT the run at
 * e.g. row 1200 while claiming done. We discriminate instead:
 *     attempted === 0                  -> genuinely drained -> DONE
 *     attempted > 0 && written === 0   -> embedder trouble  -> PAUSE, back off, RETRY (never halt)
 * The rows are safe either way: an un-embedded row stays wrong-dimension and is re-selected. So
 * retrying is free correctness, and halting is the only outcome that actually loses anything.
 */
import { backfillEmbeddings, countEmbeddings } from "../../dist/memory/store.js";
import { loadConfig } from "../../dist/config.js";
import { openDb, closeDb } from "../../dist/db/index.js";
import { readFileSync } from "node:fs";

// Same bootstrap embed-cli does. Without it getDb() throws "db not opened — call openDb() first".
const cfg = loadConfig();
openDb(cfg.paths.dbFile);

const MiB = 1024 * 1024;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const flag = (n) => process.argv.includes(n);

// --- knobs -------------------------------------------------------------------------------------
// BATCH is the CHECK CADENCE, not just a DB page size. Toby: swap is a GAUGE, so a check only at
// batch boundaries is blind for the whole batch — which is exactly the sampler blindness that
// rebooted the box. BATCH=1 makes the blind window one embed (~1.4s) regardless of anything else.
// Szoszo chose 100 as the *progress* unit and later approved smaller batches; we honour both by
// checking every row and REPORTING every PROGRESS_EVERY rows.
const BATCH_REQ = arg("--batch", 1);
// F4 (Toby + Darryl): BATCH *IS* the check cadence, so a well-meaning "speed it up" flag would
// silently disable the safety property. backfillEmbeddings(N) embeds N rows internally with NO
// health check between them, so --batch 50 blinds the guard for ~3 minutes — the exact sampler
// blindness that rebooted the box. Refuse it unless the caller states the consequence out loud.
const BATCH = (BATCH_REQ > 1 && !process.argv.includes("--i-know-this-blinds-the-guard")) ? 1 : BATCH_REQ;
if (BATCH_REQ > 1 && BATCH === 1) console.log(`[guard] REFUSED --batch ${BATCH_REQ}: it blinds the per-row health check. Forcing 1.`);
const PROGRESS_EVERY = arg("--progress-every", 100);
const PAUSE_MS = arg("--pause", 250);

// Thresholds are PLACEHOLDERS until the pilot measures them. Do not treat them as derived.
// Ceiling sits BELOW oomwatch's 2048 MiB notify so we back off before oomwatch sheds ollama out
// from under us — two guards with different thresholds is how you get shed/reload thrash.
const SWAP_PAUSE = arg("--swap-pause", 1800);
const SWAP_RESUME = arg("--swap-resume", 1500);
// DERIVED, not a placeholder (Toby's ordering point + the 60-row pilot numbers). Measured pilot
// peak was 1146 MiB against a 1145 baseline, i.e. the job contributes ~1 MiB. 2600 was WRONG
// because it sat ABOVE oomwatch's 2048 shed point, so the ordering was: we pause at 1800, oomwatch
// SHEDS bge-m3 out from under a still-running job at 2048, and only then do we abort at 2600 —
// guaranteeing model-reload churn between two guards. Correct ordering is guard-pauses,
// guard-aborts, and oomwatch never has to act: 1800 < 2000 < 2048.
const SWAP_ABORT = arg("--swap-abort", 2000);
const MIN_AVAIL_PCT = arg("--min-avail-pct", 12);
const MAX_CONSEC_EMBED_FAIL = arg("--max-embed-fail", 12);
const MAX_PAUSE_MS_TOTAL = arg("--max-pause-total", 20 * 60 * 1000); // reporting only
const MAX_STUCK_MS = arg("--max-stuck", 20 * 60 * 1000);   // CONSECUTIVE no-progress -> abort
const PILOT = arg("--pilot", 0); // stop after N rows, for the measured pilot

// HARD WALL-CLOCK DEADLINE. The morning briefing does NOT fire at a fixed hour: morning-briefing-arm
// runs at 06:00, reads Szoszo's next phone alarm from HA, and rewrites the briefing cron to
// alarm+30min (sanity floor 06:30, fallback 07:30). So the briefing can land as early as 06:30 and
// we cannot know when until 06:00. If this job is still saturating ollama then, briefing recalls
// queue behind our embeds and the hybrid path silently degrades to keyword-only — a quietly worse
// briefing, which is exactly the kind of damage nobody would notice. So we stop cleanly BEFORE the
// arm even runs. Stopping early is free: the job is resumable and the remaining rows stay
// wrong-dimension until the next run. --deadline HH:MM local, empty string disables.
const DEADLINE = (() => {
  const i = process.argv.indexOf("--deadline");
  const v = i > -1 ? process.argv[i + 1] : "06:00";
  if (!v) return null;
  const [hh, mm] = v.split(":").map(Number);
  const d = new Date(); d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
})();

const rd = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const num = (p) => { const v = parseInt(rd(p).trim(), 10); return Number.isFinite(v) ? v : null; };
const oomKills = () => { const m = rd("/sys/fs/cgroup/memory.events").match(/^oom_kill (\d+)/m); return m ? +m[1] : null; };
const availPct = () => {
  const mi = rd("/proc/meminfo");                    // read ONCE, match both (Darryl nit)
  const t = mi.match(/MemTotal:\s+(\d+)/), a = mi.match(/MemAvailable:\s+(\d+)/);
  return t && a ? (+a[1] / +t[1]) * 100 : null;
};
// FAIL CLOSED. Previously `?? 0` on the swap gauges: an UNREADABLE gauge (perm change, cgroup
// recreate, moved mount) read as 0 = "swap is fine" and the guard went permanently to sleep
// reading all-clear. That is the exact sampler-blindness that rebooted the box on 08-03, rebuilt
// inside the guard meant to prevent it. Toby (F3) and Darryl (C1) found this independently, which
// is how much it deserved finding. An unreadable gauge is now a HEALTH-UNREADABLE condition that
// pauses, never a healthy reading.
const health = () => {
  const swapRaw = num("/sys/fs/cgroup/memory.swap.current");
  const ollRaw = num("/sys/fs/cgroup/system.slice/ollama.service/memory.swap.current");
  const av = availPct();
  return {
    swapMiB: swapRaw === null ? null : Math.round(swapRaw / MiB),
    ollamaSwapMiB: ollRaw === null ? null : Math.round(ollRaw / MiB),
    availPct: av,
    oom: oomKills(),
    readable: swapRaw !== null && ollRaw !== null && av !== null,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);

async function bus(content) {
  try {
    const root = process.env.OFFICE_TENANT_ROOT ?? "/opt/claude/theoffice/tenant";
    const token = readFileSync(`${root}/store/.dashboard-token`, "utf8").trim();
    // F2 (Toby): HARD TIMEOUT. On an ABORT the box is thrashing — that is WHY we are aborting —
    // and the dashboard is under the same pressure, so an untimed fetch can block at exactly the
    // moment this process must DIE to release its memory. Releasing memory must never be gated on
    // a network call to a box that is out of memory. oomwatch's bus POST uses timeout=15; this is
    // tighter because the abort path is the one that matters.
    await fetch("http://127.0.0.1:3430/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ from: "reembed", to: "marveen", content }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) { log(`bus notify failed (non-fatal): ${e}`); }
}

const start = Date.now();
const c0 = countEmbeddings();
let done = 0, pausedMs = 0, consecEmbedFail = 0, pauses = 0;
// stuckMs = time since the last SUCCESSFUL embed. Resets on any progress. pausedMs stays as a
// cumulative REPORTING figure only. Previously one cumulative counter drove the abort, so many
// short ollama-restart backoffs during a healthy 2.5h run could sum to the 20min cap and abort a
// job that was making steady progress — which directly contradicts G1/G2 (an ollama restart storm
// must NEVER stop the run). Abort now keys on being genuinely STUCK, not on being slow.
let stuckMs = 0;
const oom0 = oomKills();
let peakSwap = health().swapMiB;

log(`start: ${c0.usable}/${c0.total} usable, ${c0.wrongDim} wrong-dim to convert` + (PILOT ? ` (PILOT ${PILOT} rows)` : ""));
log(`deadline: ${DEADLINE ? DEADLINE.toString().slice(0, 24) : "none"} (stops clean before the dynamic briefing)`);
log(`guard: batch=${BATCH} pause>=${SWAP_PAUSE}MiB resume<=${SWAP_RESUME}MiB abort>=${SWAP_ABORT}MiB minAvail=${MIN_AVAIL_PCT}%`);

async function finish(kind, why) {
  const c = countEmbeddings();
  const mins = ((Date.now() - start) / 60000).toFixed(1);
  const oomDelta = (oomKills() ?? 0) - (oom0 ?? 0);
  const line =
    `RE-EMBED ${kind}: ${why}\n` +
    `rows converted this run: ${done}\n` +
    `coverage now: ${c.usable}/${c.total} usable, ${c.wrongDim} still wrong-dim\n` +
    `elapsed ${mins} min, paused ${(pausedMs / 60000).toFixed(1)} min over ${pauses} pause(s)\n` +
    `peak container swap ${peakSwap} MiB, ollama swap ${health().ollamaSwapMiB} MiB, oom_kill delta ${oomDelta}`;
  log(line.replace(/\n/g, " | "));
  await bus(line);
  process.exit(kind === "ABORTED" ? 1 : 0);
}

process.on("SIGTERM", () => void finish("STOPPED", "SIGTERM — safe to resume, finished rows are committed"));
process.on("SIGINT", () => void finish("STOPPED", "SIGINT — safe to resume, finished rows are committed"));

for (;;) {
  // ---- health gate BEFORE every batch. PAUSE issues ZERO ollama calls while paused: a "paused"
  // job that still embeds keeps bge-m3 hot and fights oomwatch's keep_alive:0 shed, producing
  // 1.2GB load/unload churn that is worse than either alone.
  if (DEADLINE && Date.now() >= DEADLINE.getTime()) {
    await finish("STOPPED-AT-DEADLINE", `reached ${DEADLINE.toTimeString().slice(0, 5)} — stopping so the morning briefing has a clear box; resumable, remaining rows are untouched`);
  }
  let h = health();
  if (!h.readable) {
    // FAIL CLOSED: we cannot see the box, so we do not embed. Waiting blind is safe; proceeding
    // blind is exactly how the host got taken down.
    stuckMs += 5000; pausedMs += 5000; pauses++;
    log(`HEALTH UNREADABLE (swap=${h.swapMiB} ollamaSwap=${h.ollamaSwapMiB} avail=${h.availPct}) — pausing, refusing to embed blind`);
    if (stuckMs > MAX_STUCK_MS) await finish("ABORTED", "health gauges unreadable and stayed unreadable — refusing to run blind");
    await sleep(5000);
    continue;
  }
  if (h.swapMiB > peakSwap) peakSwap = h.swapMiB;

  if (h.swapMiB >= SWAP_ABORT) await finish("ABORTED", `container swap ${h.swapMiB} MiB >= abort ${SWAP_ABORT}`);
  if (h.availPct !== null && h.availPct < MIN_AVAIL_PCT) await finish("ABORTED", `available RAM ${h.availPct.toFixed(1)}% < ${MIN_AVAIL_PCT}%`);
  if (h.ollamaSwapMiB > 0) await finish("ABORTED", `ollama swap is ${h.ollamaSwapMiB} MiB, expected 0 — the cap is not holding`);

  if (h.swapMiB >= SWAP_PAUSE) {
    pauses++;
    log(`PAUSE: swap ${h.swapMiB} MiB >= ${SWAP_PAUSE}. Zero embed calls until it drops to ${SWAP_RESUME}.`);
    while (h.swapMiB === null || h.swapMiB > SWAP_RESUME) {
      await sleep(5000); pausedMs += 5000; stuckMs += 5000;
      if (stuckMs > MAX_STUCK_MS) await finish("ABORTED", `no successful embed for ${(stuckMs / 60000).toFixed(1)} min, swap never recovered`);
      h = health();
      if (h.swapMiB !== null && h.swapMiB >= SWAP_ABORT) await finish("ABORTED", `swap climbed to ${h.swapMiB} MiB while paused`);
    }
    log(`RESUME: swap back to ${h.swapMiB} MiB`);
  }

  // ---- one guarded increment
  const r = await backfillEmbeddings(BATCH);

  // DONE IS PROVEN BY THE COVERAGE NUMBER, NOT BY THE LOOP EXITING (Toby). An empty batch is the
  // loop's opinion; countEmbeddings() is the ground truth. If the select returns nothing but rows
  // are still wrong-dimension, something is wrong with the predicate or the DB, and reporting
  // COMPLETE there would be exactly the silent-partial-success this whole guard exists to prevent.
  if (r.attempted === 0) {
    const c = countEmbeddings();
    if (c.wrongDim === 0) await finish("COMPLETE", "coverage verified clean: zero wrong-dimension rows remain");
    await finish("ABORTED", `backfill returned no rows to attempt, but ${c.wrongDim} rows are STILL wrong-dimension — refusing to report done`);
  }

  if (r.written === 0) {
    // NOT drained (attempted > 0) but nothing written => the embedder is unhappy, almost certainly
    // an ollama OOM + cold reload. This is the case embed-cli treats as "stop, report done".
    consecEmbedFail++;
    if (consecEmbedFail >= MAX_CONSEC_EMBED_FAIL) {
      await finish("ABORTED", `${consecEmbedFail} consecutive batches attempted rows but embedded none — embedder down, not transient`);
    }
    const back = Math.min(30000, 1000 * 2 ** Math.min(consecEmbedFail, 5));
    log(`embedder returned nothing for ${r.attempted} row(s) (attempt ${consecEmbedFail}/${MAX_CONSEC_EMBED_FAIL}) — ollama likely restarting. Backing off ${back}ms, NOT halting.`);
    await sleep(back); pausedMs += back; stuckMs += back;
    if (stuckMs > MAX_STUCK_MS) await finish("ABORTED", `no successful embed for ${(stuckMs / 60000).toFixed(1)} min — embedder not recovering`);
    continue;
  }

  consecEmbedFail = 0;
  stuckMs = 0;            // REAL PROGRESS: a restart storm can never accumulate its way to an abort
  done += r.written;
  if (done % PROGRESS_EVERY < BATCH) {
    const h2 = health();
    log(`progress ${done}/${c0.wrongDim} | swap ${h2.swapMiB}MiB (peak ${peakSwap}) | avail ${h2.availPct?.toFixed(0)}% | oomΔ ${(h2.oom ?? 0) - (oom0 ?? 0)}`);
  }
  if (PILOT && done >= PILOT) await finish("PILOT-COMPLETE", `pilot of ${done} rows finished — use the peak numbers above to derive the real thresholds`);
  if (PAUSE_MS) await sleep(PAUSE_MS);
}
