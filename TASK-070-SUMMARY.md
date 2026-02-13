# TASK-070 Summary: CLI/tools/views Project-Aware

## Objective
Make CLI/tools/views project-aware. CLI commands accept `--project <id>` (default `_inbox`). Views written to `Projects/<id>/views/`.

## Implementation

### 1. Project Resolution Utilities

**File**: `src/projects/resolver.ts` (58 LOC)
- `resolveProject(projectId, vaultRoot)` - Resolves project ID to project root
- `projectExists(projectRoot)` - Checks if project directory exists
- Supports default `_inbox` project
- Reads vaultRoot from parameter, `AOF_ROOT` env, or defaults to `~/Projects/AOF`

**File**: `src/cli/project-utils.ts` (73 LOC)
- `createProjectStore(opts)` - Creates TaskStore for project scope
- `getViewsDir(projectRoot)` - Returns `${projectRoot}/views`
- `getMailboxViewsDir(projectRoot)` - Returns `${projectRoot}/views/mailbox`
- `getKanbanViewsDir(projectRoot)` - Returns `${projectRoot}/views/kanban`

### 2. CLI Commands Updated

**File**: `src/cli/index.ts` (modified)

Added `--project <id>` flag (default `_inbox`) to:
- ✅ `aof lint` - Lint tasks in project scope
- ✅ `aof scan` - List tasks in project scope
- ✅ `aof scheduler run` - Run scheduler for project
- ✅ `aof task create` - Create task in project
- ✅ `aof board` - Display project kanban board
- ✅ `aof metrics serve` - Serve metrics for project
- ✅ `aof watch` - Watch project views

### 3. View Path Changes

**Mailbox View** (`src/views/mailbox.ts`):
- Added `viewsDir` option to `MailboxViewOptions`
- Default path changed from `dataDir/Agents` to `dataDir/views/mailbox`
- Kept backward compatibility with `agentsDir` option

**Kanban View** (`src/views/kanban.ts`):
- Already had `viewsDir` option
- Now properly used by CLI with project-scoped paths

### 4. Path Structure

#### Before:
```
${AOF_ROOT}/
├── Agents/
│   └── <agentId>/
│       ├── inbox/
│       ├── processing/
│       └── outbox/
└── views/
    └── kanban/
        └── <swimlane>/
            └── <status>/
```

#### After:
```
${AOF_ROOT}/
└── Projects/
    └── <projectId>/
        └── views/
            ├── mailbox/
            │   └── <agentId>/
            │       ├── inbox/
            │       ├── processing/
            │       └── outbox/
            └── kanban/
                └── <swimlane>/
                    └── <status>/
```

### 5. Tests

**New Tests**:
- `src/projects/__tests__/resolver.test.ts` (5 tests) - Project resolution
- `src/cli/__tests__/project-utils.test.ts` (5 tests) - CLI utilities

**Updated Tests**:
- `src/views/__tests__/mailbox.test.ts` - Updated paths to `views/mailbox`
- `tests/e2e/suites/05-view-updates.test.ts` - Updated E2E test paths

**Test Results**: 1079 tests passing (10 new tests added)

## Usage Examples

```bash
# Default project (_inbox)
aof lint
aof scan
aof board

# Specific project
aof lint --project my-project
aof scan --project alpha-team
aof board --project beta-release

# Create task in specific project
aof task create "Fix bug" --project hotfixes --priority high

# Run scheduler for specific project
aof scheduler run --active --project production

# Watch project views
aof watch kanban --project my-project
aof watch mailbox --agent swe-backend --project alpha
```

## Backward Compatibility

✅ **MCP Resources**: No changes needed (read from TaskStore, not file paths)
✅ **Tools**: No changes needed (receive TaskStore via context)
✅ **View Functions**: Support both old `agentsDir` and new `viewsDir` options
✅ **Existing Code**: All existing code continues to work with default `_inbox` project

## Size Constraints

All files meet size constraints:
- `src/projects/resolver.ts`: 58 LOC
- `src/cli/project-utils.ts`: 73 LOC
- Largest function: `createProjectStore()` at 22 LOC

## Design Decisions

1. **Default Project**: `_inbox` as default ensures backward compatibility
2. **Path Structure**: `Projects/<id>/views/` follows project-scoped structure
3. **Backward Compatibility**: Kept `agentsDir` option for mailbox views
4. **Minimal Changes**: Only CLI and view paths updated; tools/MCP unchanged
5. **Table-Driven**: No branching added; uses existing project resolution logic

## Future Work

- MCP server could be made project-aware (currently uses single TaskStore)
- Tools could accept project context in MCP requests
- Cross-project queries/reports could be added
