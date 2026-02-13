# TASK-068 Completion Summary

## Objective
Update AOF protocol envelope + router to be project-aware (projectId, taskRelpath) and accept project_id alias for inbound payloads.

## Changes Implemented

### 1. Protocol Schema (`src/schemas/protocol.ts`)
- **Added fields to ProtocolEnvelopeBase:**
  - `projectId: z.string()` (required)
  - `taskRelpath: z.string().optional()` (optional)
- **Implemented `project_id` alias support:**
  - Added `preprocessProjectId()` function that maps `project_id` → `projectId`
  - Wrapped discriminated union with `z.preprocess()` for alias handling

### 2. Protocol Router (`src/protocol/router.ts`)
- **Added project store resolution:**
  - New dependency: `projectStoreResolver?: (projectId: string) => TaskStore | undefined`
  - New method: `resolveProjectStore(projectId)` with fallback to default store
  
- **Updated `route()` method:**
  - Validates project store can be resolved (rejects with `invalid_project_id`)
  - Validates task exists in project store (rejects with `task_not_found`)
  - Passes resolved store to all handlers

- **Updated all handler signatures:**
  - `handleCompletionReport(envelope, store)`
  - `handleStatusUpdate(envelope, store)`
  - `handleHandoffRequest(envelope, store)`
  - `handleHandoffAck(envelope, store)`
  - All private methods that interact with store

### 3. Test Updates
Updated 7 test files with `projectId` in envelopes and `store` parameters:
- `src/schemas/__tests__/protocol.test.ts` - Added tests for projectId requirement, project_id alias, taskRelpath
- `src/protocol/__tests__/router.test.ts` - Added project resolver tests
- `src/protocol/__tests__/completion-status.test.ts`
- `src/protocol/__tests__/protocol-integration.test.ts`
- `src/protocol/__tests__/concurrent-handling.test.ts`
- `src/protocol/__tests__/handoff.test.ts`
- `src/service/__tests__/aof-service.test.ts`

## Acceptance Criteria ✅

- ✅ ProtocolEnvelope validation **requires** projectId
- ✅ `project_id` alias accepted for inbound payloads (via z.preprocess)
- ✅ Router rejects envelopes with invalid projectId (logs `protocol.message.rejected` with reason `invalid_project_id`)
- ✅ Router rejects envelopes when task not found in project (logs `protocol.message.rejected` with reason `task_not_found`)
- ✅ Router resolves task in correct project store (via projectStoreResolver)
- ✅ Unit tests cover accept/reject cases
- ✅ `taskRelpath` is optional (as per design doc)

## Test Results
```
Test Files  108 passed (108)
Tests       1063 passed (1063)
Duration    23.82s
```

All tests passing (increased from 1056 baseline due to new tests added during implementation).

## File Size Compliance
- `src/schemas/protocol.ts`: 137 LOC (✅ within 300 LOC limit)
- `src/protocol/router.ts`: 638 LOC (⚠️ over 300 LOC, but was pre-existing large file)

Three functions exceed 60 LOC but were already over the limit before this task:
- `handleStatusUpdate`: 63 lines (added minimal store parameter passing)
- `handleHandoffRequest`: 91 lines (was already large)
- `notifyTransition`: 108 lines (was already large, no changes made)

## Design Notes

### Project Store Resolution
- Router accepts optional `projectStoreResolver` in dependencies
- When provided, router uses it to resolve project-specific TaskStore instances
- When not provided, router falls back to the default store (backward compatibility)
- This design allows:
  - Multi-project mode: AOFService passes a resolver backed by project registry
  - Single-project mode: Legacy usage continues to work with default store

### Backward Compatibility
- Fallback to default store ensures existing single-store usage continues to work
- Tests can run with or without a resolver
- No breaking changes to existing ProtocolRouter API (resolver is optional)

## Integration Points
For multi-project scheduler implementation (future task):
1. AOFService should create a `projectStoreResolver` using `discoverProjects(vaultRoot)`
2. Pass resolver to ProtocolRouter constructor
3. Resolver can cache TaskStore instances per projectId for efficiency
