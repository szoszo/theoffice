# DESIGN: portable install + generic post-update self-onboarding

Goal: (A) kill watchd's hardcoded-path wart so it installs on any tenant, and
(B) a GENERIC framework so any capability that needs setup OFFERS itself to the
tenant's main agent after an update — offer-first, once-only, dismissible. watchd
is merely the first capability to use B. Ships to origin.

## PART A — portable install

**tools/watchd/install.sh** (idempotent, no hand-editing):
1. `REPO_ROOT="$(git rev-parse --show-toplevel)"`; `TENANT="${OFFICE_TENANT_ROOT:-$REPO_ROOT/tenant}"`; `PY="$(command -v python3)"`.
2. Preflight: python3 present; `mkdir -p "$TENANT/store/watches" "$TENANT/store/watches/quarantine" "$TENANT/store/watchd-checks"`.
3. RENDER `watchd.service.template` → `~/.config/systemd/user/watchd.service`, substituting `@REPO_ROOT@`, `@OFFICE_TENANT_ROOT@`, `@PYTHON@` (sed). Never edit a committed file.
4. `systemctl --user daemon-reload`; `systemctl --user enable --now watchd.service`.
5. VERIFY `systemctl --user is-active watchd.service` == active; print status; nonzero exit on failure.
- IDEMPOTENT: re-run re-renders + overwrites the unit, enable --now is a no-op if already enabled, verify re-checks. Safe to run any number of times.

**watchd.service.template** replaces the hardcoded .service (the wart). Tokens:
`Environment=OFFICE_TENANT_ROOT=@OFFICE_TENANT_ROOT@`, `ExecStart=@PYTHON@ @REPO_ROOT@/tools/watchd/watchd.py`. Keeps MemoryHigh/Max caps + Restart=always. The old watchd.service (hardcoded /opt/claude/theoffice) is DELETED.

**watchd.py**: `WATCHD_API_BASE` default → `http://127.0.0.1:3430` (watchd runs on the same box as the dashboard, so loopback is universally correct). Keep the env override. Do NOT ship our LAN IP (192.168.10.162) as a default — our tenant sets it via env only if ever needed (it isn't; the HA-push case that motivated it was dropped). The tenant-specific Kia CHECK script keeps its Traccar IP — it is tenant config, not shipped framework.

## PART B — generic post-update setup notice (the real ask)

### Declaration convention: MANIFEST FILE `tools/<cap>/POST_UPDATE.md` (chosen over a `Setup-Notice:` commit trailer)
Justification: (1) self-describing + co-located with the capability — discoverable, not buried in one commit message; (2) rich markdown the main agent can relay to the owner verbatim (what it is, what install.sh does, the one command); (3) robust to a feature landing over MULTIPLE commits (a trailer must sit on exactly the "completing" commit; a file just has to exist); (4) generic — ANY `tools/*/POST_UPDATE.md` auto-participates, zero per-capability framework code. The commit-trailer's only edge (reuse body parsing) is outweighed; we still USE the applied-commit info, just to detect which manifests changed (below), not to carry the text.

Manifest front-matter (parsed): `capability:` (id), `installed-check:` (a shell test that exits 0 when already set up, e.g. `systemctl --user is-active watchd.service`), `install:` (the command to offer, e.g. `tools/watchd/install.sh`). Body = the human notice.

### Detection (in applyUpdate, BEFORE the restart)
applyUpdate already has `preHead`. After a SUCCESSFUL pull+build, compute `git diff --name-only preHead..HEAD` and select `tools/*/POST_UPDATE.md` that were ADDED/MODIFIED. For each: run its `installed-check`; if NOT already installed AND (no prior marker OR the manifest content hash changed since the marker), append `{capability, notice_hash, notice_text, install_cmd}` to a durable pending file `$TENANT/store/pending-setup-notices.json`. Recording happens pre-restart; injection happens post-restart (survives the bounce).

### Hook A (record): src/web/update.ts `applyUpdate()`, immediately after the `install office-say` step succeeds and BEFORE the `setTimeout(restart)`. One new function `recordSetupNotices(preHead)` — additive, no change to the update/rollback path.

### Hook B (inject): src/index.ts boot, a NEW phase after the deliverer is up (so the queue can accept), e.g. Phase 2c `deliverPendingSetupNotices(cfg)`. It reads pending-setup-notices.json; for each entry whose marker is not already `notified` at that hash, `enqueueInbound({ agentId: cfg.mainAgentId, source: "system", prompt: OFFER_TEXT })`, then writes the marker. Clears the pending file after processing.

### Delivery to mainAgentId: the inbound QUEUE (enqueueInbound), NOT the first-message preamble
Justification: an engine restart leaves agent tmux sessions ALIVE (decoupled cgroup), so `needsPrime`/firstMessagePreamble does NOT fire — the preamble would silently no-op post-update. The inbound queue is the reliable, delivery-confirmed path that already handles a busy main agent (waits for idle). In-process `enqueueInbound` (not an HTTP self-call) since this runs inside the engine at boot. `source:"system"` so it is framed as a framework message, content-as-data on receipt.

OFFER_TEXT (offer-first, the owner-confirmed — never silent auto-install): "Update applied. New capability *<cap>* is available but not installed. It <one-line from manifest>. Want me to set it up? I can run its installer (`<install_cmd>`) and walk you through it. Say yes to install, or dismiss to skip." The main agent asks the OWNER, and on yes runs install.sh; on no, dismisses.

### Once-only + dismissible marker: `$TENANT/store/setup-notices.json`
`{ "<cap>": { "notice_hash": "<sha>", "state": "notified|installed|dismissed", "at": <ts> } }`.
- Inject ONLY if no marker for <cap> OR `marker.notice_hash != current_hash` (a genuinely NEW notice re-offers exactly once). After inject → state `notified`.
- DISMISSIBLE: the main agent (after the owner declines) sets state `dismissed` (a tiny `tools/framework/setup-notice.sh dismiss <cap>` helper or a bearer API `POST /api/setup-notices/<cap> {state}`). Dismissed/installed at a given hash never re-nags; only a changed hash re-offers.
- The `installed-check` is belt-and-suspenders: even if a marker is missing, an already-installed capability is skipped at detection time.

## TEST PLAN
Pure-logic unit tests (red-first, vitest — this is TS framework code):
- notice parser: given an applied file list + manifest contents → correct pending entries (only added/modified POST_UPDATE.md, only not-installed, correct hash).
- once-only marker: no marker → inject+mark; same hash marker → skip; changed hash → inject once; dismissed → skip; installed → skip.
- generic: two capabilities' manifests → two independent notices/markers.
- OFFER_TEXT render from manifest front-matter.
Integration/script tests:
- install.sh in a temp clone with a DIFFERENT REPO_ROOT/OFFICE_TENANT_ROOT → rendered unit has the right paths; idempotent re-run stays active; missing python3 fails clean.
- WATCHD_API_BASE default == 127.0.0.1:3430; env override honored.
- End-to-end (fixture): applyUpdate over a commit adding a POST_UPDATE.md → pending file written → boot phase → mainAgentId gets EXACTLY ONE queued offer → second boot → none; changed manifest → one more.

## Build discipline
worktree + branch, red-first (I want the once-only + generic tests to fail first), self-review, Toby adversarial QA, your Gate-2, merge to main + PUSH TO ORIGIN (so other tenants get portability + self-onboarding together). Doc committed with the code. Doc-first: no build until you approve this.
