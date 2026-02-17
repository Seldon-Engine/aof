# God File Refactoring Plan (AOF-i27)

## Overview
Six production files violate the 500 LOC limit (total: 6,448 LOC). This doc defines the split strategy for each.

## Priority Order
1. **scheduler.ts** (1633 LOC) — worst offender, critical path
2. **cli/index.ts** (1860 LOC) — maintainability nightmare
3. **task-store.ts** (1024 LOC) — core data layer
4. **aof-tools.ts** (790 LOC) — agent tool interface
5. **protocol/router.ts** (638 LOC) — protocol handling
6. **org/linter.ts** (503 LOC) — just over limit

---

## 1. scheduler.ts (1633 LOC → 5 files)

### Current Structure
- Interfaces: SchedulerConfig, SchedulerAction, PollResult, ThrottleState
- Lease renewal functions (start/stop/cleanup)
- Promotion + escalation logic
- Massive poll() function (1185 LOC!)

### Target Split
```
src/dispatch/
  scheduler.ts          ~250 LOC  Main poll orchestrator, interfaces, stats
  throttle.ts           ~150 LOC  ThrottleState, resetThrottleState, throttle checks
  lease-manager.ts      ~200 LOC  Lease renewal (start/stop/cleanup/isLeaseActive)
  escalation.ts         ~200 LOC  checkPromotionEligibility, escalateGateTimeout
  task-dispatcher.ts    ~300 LOC  Assignment/dispatch logic (sections 4 & 6 from poll)
```

### Dependencies (poll() sections)
- Lines 449-1633 contain the poll() function
- Section 3: Expired leases → **lease-manager.ts**
- Section 3.1: Promotion eligibility → **escalation.ts** (already has checkPromotionEligibility)
- Section 3.9: Gate timeout → **escalation.ts** (already has escalateGateTimeout)
- Section 4: Ready task assignment → **task-dispatcher.ts**
- Section 6: Execute actions (dispatch) → **task-dispatcher.ts**
- Throttle checks throughout → **throttle.ts**

### Refactor Strategy
1. Extract **throttle.ts** first (pure state management, no dependencies)
2. Extract **lease-manager.ts** (used in poll, minimal deps)
3. Extract **escalation.ts** (promotion + gate timeout logic)
4. Extract **task-dispatcher.ts** (assignment + dispatch execution)
5. Slim down **scheduler.ts** to orchestrator only

### Key Interfaces to Share
- `SchedulerConfig` stays in scheduler.ts (main config)
- `SchedulerAction` stays in scheduler.ts (action type)
- `PollResult` stays in scheduler.ts (return type)
- `ThrottleState` moves to throttle.ts

---

## 2. cli/index.ts (1860 LOC → 15 files)

### Current Structure
30+ Commander commands defined inline in one file.

### Target Split
```
src/cli/
  index.ts                    ~150 LOC  Main program, command registration only
  commands/
    init.ts                   ~80 LOC   init command
    project.ts                ~100 LOC  create-project
    integration.ts            ~120 LOC  integrate, eject
    daemon.ts                 [EXISTS]  daemon commands (already extracted)
    lint.ts                   ~80 LOC   lint command
    scan.ts                   ~100 LOC  scan command
    scheduler-cli.ts          ~120 LOC  scheduler run
    task-cli.ts               ~400 LOC  task create/list/edit/cancel/close/dep/block
    org-cli.ts                ~150 LOC  org validate/show/drift
    memory-cli.ts             ~120 LOC  memory generate/audit
    config-cli.ts             ~100 LOC  config get/set/validate
    metrics-cli.ts            ~100 LOC  metrics start/collect
    packaging-cli.ts          ~150 LOC  install/update/channel/self-update
    migration-cli.ts          ~100 LOC  migrate/rollback
```

### Refactor Strategy
1. Extract each command group to its own file (one group at a time)
2. Each command file exports a function that registers commands on a Commander instance
3. index.ts imports all command files and calls registration functions
4. Keep daemon.ts as-is (already extracted)

---

## 3. task-store.ts (1024 LOC → 4 files)

### Current Structure
- Task parsing/serialization functions
- FilesystemTaskStore class (large)
- Many query and mutation methods

### Target Split
```
src/store/
  task-parser.ts       ~150 LOC  parseTaskFile, serializeTask, extractTaskSections, contentHash
  task-store.ts        ~300 LOC  FilesystemTaskStore core (constructor, list, get, create)
  task-queries.ts      ~200 LOC  Complex queries (findByDependency, search, etc)
  task-mutations.ts    ~200 LOC  Mutations (update, delete, archive, etc)
```

### Refactor Strategy
1. Extract **task-parser.ts** (pure functions, no class deps)
2. Split FilesystemTaskStore methods into queries vs mutations
3. Extract **task-queries.ts** (readonly methods)
4. Extract **task-mutations.ts** (state-changing methods)
5. Keep core CRUD in **task-store.ts**

---

## 4. aof-tools.ts (790 LOC → 9 files)

### Current Structure
10 tool functions in one file (aofDispatch, aofTaskUpdate, etc).

### Target Split
```
src/tools/
  aof-tools.ts              ~80 LOC   Common interfaces, ToolContext, exports, registration
  dispatch-tool.ts          ~100 LOC  aofDispatch + input/result types
  task-update-tool.ts       ~80 LOC   aofTaskUpdate
  task-complete-tool.ts     ~120 LOC  aofTaskComplete
  status-report-tool.ts     ~100 LOC  aofStatusReport
  task-edit-tool.ts         ~80 LOC   aofTaskEdit
  task-cancel-tool.ts       ~50 LOC   aofTaskCancel
  task-dep-tool.ts          ~100 LOC  aofTaskDepAdd, aofTaskDepRemove
  task-block-tool.ts        ~80 LOC   aofTaskBlock, aofTaskUnblock
```

### Refactor Strategy
1. Extract each tool function to its own file (one at a time)
2. Each file exports the tool function + input/result types
3. aof-tools.ts re-exports everything + provides common interfaces

---

## 5. protocol/router.ts (638 LOC → 3 files)

### Current Structure
- ProtocolRouter class (large)
- Helper functions for parsing/formatting

### Target Split
```
src/protocol/
  router.ts         ~300 LOC  ProtocolRouter class
  parsers.ts        ~150 LOC  parseProtocolMessage, parseJsonEnvelope, validateEnvelope, safeParseJson
  formatters.ts     ~100 LOC  extractPayload, buildCompletionReason, buildStatusReason, buildWorkLogEntry
```

### Refactor Strategy
1. Extract **parsers.ts** (pure parsing functions)
2. Extract **formatters.ts** (pure formatting functions)
3. Keep **router.ts** with ProtocolRouter class

---

## 6. org/linter.ts (503 LOC → keep as-is for now)

### Assessment
- Just over the 500 LOC limit (503 LOC)
- Single lintOrgChart() function with many checks
- Could split into check modules, but low priority (< 520 LOC threshold)
- **Decision**: Skip for now, revisit if it grows beyond 550 LOC

---

## Implementation Order

### Phase 1: Scheduler (highest priority)
1. AOF-i27-1: Extract throttle.ts
2. AOF-i27-2: Extract lease-manager.ts
3. AOF-i27-3: Extract escalation.ts
4. AOF-i27-4: Extract task-dispatcher.ts
5. AOF-i27-5: Slim down scheduler.ts

### Phase 2: CLI (maintainability)
6. AOF-i27-6: Extract CLI command groups (one task for all)

### Phase 3: Core Infrastructure
7. AOF-i27-7: Split task-store.ts
8. AOF-i27-8: Split aof-tools.ts
9. AOF-i27-9: Split protocol/router.ts

---

## Testing Requirements
- All 1764 tests must pass after EACH refactor
- Run `npx vitest run` after each file split
- One commit per file split, push immediately

## Size Budgets
- Extracted modules: <300 LOC each
- Orchestrator files: <300 LOC
- Hard limit: 500 LOC (refuse to add code if exceeded)
