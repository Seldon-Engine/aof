# Mule AOF Dev + QA Fast Feedback Loop

**Scope:** Mule container only. Prod is read‑only reference. All code changes land in `~/Projects/AOF` on Mule.

## Goals
- **<60s iteration** for most changes (edit → targeted test → feedback).
- **Test‑gated task completion** (no task moves to done without tests).
- **Incremental deploy** to Mule before merge to prod.
- **QA‑integrated flow** with clear handoffs.
- **Checkpoint + rollback discipline** with <30s restore.
- **Isolation**: no SWE work on prod VM.

---

## Roles & Sequential Rule (Non‑Negotiable)
- **swe‑architect**: orchestrates, assigns work, owns checkpoints.
- **swe‑backend**: implements scheduler/dispatch changes, adds tests (TDD).
- **swe‑qa**: runs full/targeted tests, validates task state transitions.
- **test‑agent**: smoke tests only.

**Sequential work only:** one agent writes to the codebase at a time. Use a simple lock file:
```
~/Projects/AOF/.agent-lock
```
Contents: `agent=<id> | task=<id> | started=<timestamp>`
Remove when done.

---

## Fast Loop (Target <60s)
From `~/Projects/AOF` on Mule:
1. Edit code.
2. Run targeted test:
   - `npx vitest path/to/test --run`
3. Fix → re‑run until green.
4. Optional watch:
   - `npx vitest path/to/test --watch`

**Rule:** every behavior change gets a new/updated test first (TDD).

---

## Full Test Gate (Required Before “done”)
- Run full suite:
  - `npm test`
- Only then move task to `done/`.

---

## Deployment to Mule (Incremental)
If developing from another machine:
- **Preferred:** `rsync` (avoid AppleDouble files)
  ```bash
  rsync -avz --exclude node_modules --exclude .git/objects --exclude '._*' \
    ~/Projects/AOF/ mule-openclaw:~/Projects/AOF/
  ```
- **If rsync unavailable:** tar with copyfile disabled
  ```bash
  COPYFILE_DISABLE=1 tar -C ~/Projects/AOF \
    --exclude node_modules --exclude .git/objects --exclude '._*' \
    -czf - . | ssh mule-openclaw "mkdir -p ~/Projects/AOF && tar -xzf - -C ~/Projects/AOF"
  ```
Then on Mule:
```
cd ~/Projects/AOF
npm install
npm test
```

---

## QA Handoff
1. **Backend** finishes change + targeted tests → moves task to `review/` and notifies architect.
2. **Architect** assigns QA run.
3. **QA** runs:
   - targeted tests (`npx vitest <pattern>`) and/or full suite (`npm test`).
4. **QA** reports results (pass/fail + repro notes). Only then task moves to `done/`.

---

## Smoke Test Checklist (AOF Plugin)
1. Confirm AOF task exists:
   - `ls ~/.openclaw/aof/tasks/ready/`
2. Verify scheduler events:
   - `tail -n 50 ~/.openclaw/aof/events/events.jsonl`
3. Dispatch smoke test task to `test-agent` and confirm:
   - `ready → in-progress → done`

If tasks stay in `ready` with `reason: no_executor`, **spawnAgent API is unavailable** → escalate.

---

## Checkpoints (Milestones)
Take a checkpoint after:
- Codebase deploy
- Smoke test pass
- Any risky change or before large refactor

Command (on Mule):
```bash
CHECKPOINT="checkpoint-###-desc"
mkdir -p ~/backups/$CHECKPOINT

tar czf ~/backups/$CHECKPOINT/openclaw-state.tar.gz -C ~ \
  --exclude='.openclaw/sessions' --exclude='.openclaw/cache' --exclude='.openclaw/logs' \
  .openclaw/

tar czf ~/backups/$CHECKPOINT/AOF.tar.gz -C ~/Projects AOF

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) - $CHECKPOINT" >> ~/backups/CHECKPOINT-LOG.txt
```

---

## Rollback (<30s)
```
bash ~/backups/restore.sh ~/backups/<checkpoint-name>
```
Validate with:
```
cd ~/Projects/AOF && npm test
```

---

## Ground Rules
- Mule is the only SWE environment.
- Prod is reference only.
- No parallel agents on the same workspace.
- Tests gate task completion.
- Checkpoints are required for milestones.
