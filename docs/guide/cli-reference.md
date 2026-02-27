<!-- AUTO-GENERATED — do not edit manually. Run: npm run docs:generate -->

# CLI Reference

Complete command reference for the `aof` CLI, auto-generated from the Commander command tree.

## Table of Contents

- [`aof init`](#aof-init)
- [`aof create-project`](#aof-create-project)
- [`aof project-list`](#aof-project-list)
- [`aof project-add-participant`](#aof-project-add-participant)
- [`aof integrate`](#aof-integrate)
  - [`aof integrate openclaw`](#aof-integrate-openclaw)
- [`aof eject`](#aof-eject)
  - [`aof eject openclaw`](#aof-eject-openclaw)
- [`aof migrate-to-projects`](#aof-migrate-to-projects)
- [`aof rollback-migration`](#aof-rollback-migration)
- [`aof daemon`](#aof-daemon)
  - [`aof daemon install`](#aof-daemon-install)
  - [`aof daemon uninstall`](#aof-daemon-uninstall)
  - [`aof daemon start`](#aof-daemon-start)
  - [`aof daemon stop`](#aof-daemon-stop)
  - [`aof daemon status`](#aof-daemon-status)
- [`aof lint`](#aof-lint)
- [`aof scan`](#aof-scan)
- [`aof scheduler`](#aof-scheduler)
  - [`aof scheduler run`](#aof-scheduler-run)
- [`aof task`](#aof-task)
  - [`aof task create`](#aof-task-create)
  - [`aof task list`](#aof-task-list)
  - [`aof task resurrect`](#aof-task-resurrect)
  - [`aof task promote`](#aof-task-promote)
  - [`aof task edit`](#aof-task-edit)
  - [`aof task cancel`](#aof-task-cancel)
  - [`aof task close`](#aof-task-close)
  - [`aof task dep`](#aof-task-dep)
    - [`aof task dep add`](#aof-task-dep-add)
    - [`aof task dep remove`](#aof-task-dep-remove)
  - [`aof task block`](#aof-task-block)
  - [`aof task unblock`](#aof-task-unblock)
- [`aof org`](#aof-org)
  - [`aof org validate`](#aof-org-validate)
  - [`aof org show`](#aof-org-show)
  - [`aof org lint`](#aof-org-lint)
  - [`aof org drift`](#aof-org-drift)
- [`aof runbook`](#aof-runbook)
  - [`aof runbook check`](#aof-runbook-check)
- [`aof board`](#aof-board)
- [`aof watch`](#aof-watch)
- [`aof memory`](#aof-memory)
  - [`aof memory generate`](#aof-memory-generate)
  - [`aof memory audit`](#aof-memory-audit)
  - [`aof memory aggregate`](#aof-memory-aggregate)
  - [`aof memory promote`](#aof-memory-promote)
  - [`aof memory curate`](#aof-memory-curate)
  - [`aof memory import`](#aof-memory-import)
  - [`aof memory health`](#aof-memory-health)
  - [`aof memory rebuild`](#aof-memory-rebuild)
- [`aof config`](#aof-config)
  - [`aof config get`](#aof-config-get)
  - [`aof config set`](#aof-config-set)
  - [`aof config validate`](#aof-config-validate)
- [`aof metrics`](#aof-metrics)
  - [`aof metrics serve`](#aof-metrics-serve)
- [`aof notifications`](#aof-notifications)
  - [`aof notifications test`](#aof-notifications-test)
- [`aof install`](#aof-install)
- [`aof deps`](#aof-deps)
  - [`aof deps update`](#aof-deps-update)
  - [`aof deps list`](#aof-deps-list)
- [`aof channel`](#aof-channel)
  - [`aof channel show`](#aof-channel-show)
  - [`aof channel set`](#aof-channel-set)
  - [`aof channel check`](#aof-channel-check)
  - [`aof channel info`](#aof-channel-info)
- [`aof update`](#aof-update)
- [`aof setup`](#aof-setup)

---
### `aof init`

Set up AOF integration with OpenClaw (plugin registration, memory, skill)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-y, --yes` | Non-interactive mode — accept all defaults | `false` |
| `--skip-openclaw` | Skip OpenClaw integration steps | `false` |

---

### `aof create-project`

Create a new project with standard directory structure

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--title <title>` | Project title (defaults to ID) |  |
| `--type <type>` | Project type (swe\|ops\|research\|admin\|personal\|other) | `"other"` |
| `--team <team>` | Owner team (defaults to 'system') | `"system"` |
| `--lead <lead>` | Owner lead (defaults to 'system') | `"system"` |
| `--parent <id>` | Parent project ID for hierarchical projects |  |
| `--template` | Scaffold with memory directory and README template | `false` |
| `--participants <agents...>` | Initial participant agent IDs |  |

---

### `aof project-list`

List all projects on this AOF instance

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--json` | Output as JSON | `false` |

---

### `aof project-add-participant`

Add an agent to a project's participant list

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `project` | Yes |  |
| `agent` | Yes |  |

---

### `aof integrate`

Integration commands

---

#### `aof integrate openclaw`

Wire AOF plugin into OpenClaw

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Path to OpenClaw config file |  |
| `--health-check` | Run health check after integration | `false` |

---

### `aof eject`

Ejection commands

---

#### `aof eject openclaw`

Remove OpenClaw integration

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Path to OpenClaw config file |  |

---

### `aof migrate-to-projects`

Migrate tasks/ layout to Projects/ layout (v0 to v0.1)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Report planned actions without making changes | `false` |
| `--skip-backup` | Skip pre-migration backup (NOT recommended) | `false` |

---

### `aof rollback-migration`

Rollback Projects v0 migration and restore legacy layout

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Report planned actions without making changes | `false` |
| `--backup <dir>` | Explicit backup directory to restore from (default: latest tasks.backup-*) |  |

---

### `aof daemon`

Daemon lifecycle management (install, uninstall, stop, status)

---

#### `aof daemon install`

Install and start the AOF daemon under OS supervision (launchd/systemd)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--data-dir <path>` | Data directory (default: --root value) |  |

---

#### `aof daemon uninstall`

Stop the daemon, remove the service file, and clean up

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--data-dir <path>` | Data directory (default: --root value) |  |

---

#### `aof daemon start`

Start daemon (use --foreground for development, otherwise redirects to install)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--foreground` | Run daemon in the current process (development mode) | `false` |
| `--data-dir <path>` | Data directory (default: --root value) |  |

---

#### `aof daemon stop`

Stop the running daemon

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--timeout <seconds>` | Shutdown timeout in seconds | `"15"` |
| `--force` | Bypass OS supervisor and send SIGTERM directly |  |

---

#### `aof daemon status`

Check daemon status

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--json` | Output raw JSON from /status endpoint |  |

---

### `aof lint`

Lint all task files for errors

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof scan`

Scan and list all tasks by status

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof scheduler`

Scheduler commands

---

#### `aof scheduler run`

Run one scheduler poll cycle

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Dry-run mode (log only, no mutations) | `false` |
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof task`

Task management

---

#### `aof task create`

Create a new pending task

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `title` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --priority <priority>` | Priority (low\|normal\|high\|critical) | `"normal"` |
| `-t, --team <team>` | Owner team |  |
| `-a, --agent <agent>` | Target agent |  |
| `--tags <tags>` | Comma-separated tags |  |
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task list`

List all tasks (alias for scan)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task resurrect`

Resurrect a task from deadletter status back to ready

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task promote`

Promote task from backlog to ready

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--force` | Bypass eligibility checks | `false` |
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task edit`

Edit task metadata (title, priority, assignee, team, description)

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--title <title>` | Update task title |  |
| `--priority <priority>` | Update priority (low\|normal\|high\|critical) |  |
| `--assignee <agent>` | Update assigned agent |  |
| `--team <team>` | Update owner team |  |
| `--description <description>` | Update task description (body) |  |
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task cancel`

Cancel a task with optional reason

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--reason <reason>` | Cancellation reason |  |
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task close`

Close a task (transition to done)

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--recover-on-failure` | Attempt automatic recovery on failure | `false` |
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task dep`

Manage task dependencies

---

##### `aof task dep add`

Add a dependency (task will be blocked by blocker)

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |
| `blocker-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

##### `aof task dep remove`

Remove a dependency

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |
| `blocker-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task block`

Block a task with a reason

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--reason <text>` | Reason for blocking the task |  |
| `--project <id>` | Project ID | `"_inbox"` |

---

#### `aof task unblock`

Unblock a task

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof org`

Org chart management

---

#### `aof org validate`

Validate org chart schema

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | No |  |

---

#### `aof org show`

Display org chart

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | No |  |

---

#### `aof org lint`

Lint org chart (referential integrity)

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | No |  |

---

#### `aof org drift`

Detect drift between org chart and actual state

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | No |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--source <source>` | Source for agent list: fixture \| live | `"fixture"` |
| `--fixture <path>` | Path to fixture JSON file (for --source=fixture) |  |
| `--vault-root <path>` | Vault root path |  |

---

### `aof runbook`

Runbook management and compliance

---

#### `aof runbook check`

Check runbook compliance for a task

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task-id` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof board`

Display Kanban board

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--swimlane <type>` | Swimlane grouping (priority\|project\|phase) | `"priority"` |
| `--sync` | Regenerate view files before display | `false` |
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof watch`

Watch a view directory for real-time updates

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `viewType` | Yes |  |
| `viewPath` | No |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--format <format>` | Output format (cli\|json\|jsonl) | `"cli"` |
| `--agent <agent>` | Filter by agent (mailbox views only) |  |
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof memory`

Memory V2 commands

---

#### `aof memory generate`

Generate OpenClaw memory config from org chart

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | No |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--out <path>` | Output path for generated config |  |
| `--vault-root <path>` | Vault root for resolving memory pool paths |  |

---

#### `aof memory audit`

Audit OpenClaw memory config against org chart

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | No |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Path to OpenClaw config file |  |
| `--vault-root <path>` | Vault root for resolving memory pool paths |  |

---

#### `aof memory aggregate`

Aggregate cold tier events into warm docs

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Preview changes without writing | `false` |

---

#### `aof memory promote`

Promote warm doc to hot tier (gated review)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--from <path>` | Source warm doc path |  |
| `--to <path>` | Target hot doc path |  |
| `--review` | Show diff and prompt for approval | `true` |
| `--approve` | Auto-approve without review | `false` |

---

#### `aof memory curate`

Generate memory curation tasks based on adaptive thresholds

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--policy <path>` | Path to curation policy file (YAML) |  |
| `--org <path>` | Path to org chart (overrides default) |  |
| `--entries <count>` | Manual entry count override (for lancedb) |  |
| `--project <id>` | Project ID for task store | `"_inbox"` |
| `--dry-run` | Preview tasks without creating | `false` |

---

#### `aof memory import`

Audit and import memories from previous memory provider (memory-core SQLite, etc.)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--source-dir <path>` | Directory containing *.sqlite files | `"/Users/xavier/.openclaw/memory"` |
| `--workspace <path>` | Base workspace for resolving relative file paths | `"/Users/xavier/.openclaw/workspace"` |
| `--dry-run` | Report gaps without writing any files | `false` |
| `--agent <id>` | Restrict to a single agent |  |
| `--no-orphans` | Skip orphan extraction (audit only) | `false` |

---

#### `aof memory health`

Show memory index health metrics

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--json` | Output as JSON | `false` |

---

#### `aof memory rebuild`

Rebuild HNSW index from SQLite

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--yes` | Skip confirmation prompt | `false` |

---

### `aof config`

Configuration management (CLI-gated)

---

#### `aof config get`

Get config value (dot-notation)

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `key` | Yes |  |

---

#### `aof config set`

Set config value (validates + atomic write)

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `key` | Yes |  |
| `value` | Yes |  |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Preview change without applying | `false` |

---

#### `aof config validate`

Validate entire config (schema + integrity)

---

### `aof metrics`

Metrics and observability

---

#### `aof metrics serve`

Start Prometheus metrics HTTP server

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --port <port>` | HTTP port | `"9090"` |
| `--project <id>` | Project ID | `"_inbox"` |

---

### `aof notifications`

Notification system testing and diagnostics

---

#### `aof notifications test`

Dry-run notification routing (no actual messages sent)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--event <type>` | Target a specific event type (e.g. task.transitioned) |  |

---

### `aof install`

Install AOF and dependencies

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--no-lockfile` | Skip lockfile (use npm install instead of npm ci) |  |
| `--strict` | Fail if lockfile is missing | `false` |

---

### `aof deps`

Dependency management commands

---

#### `aof deps update`

Update dependencies

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--preserve <paths...>` | Paths to preserve during update | `["config","data","tasks","events"]` |
| `--no-lockfile` | Skip lockfile (use npm install instead of npm ci) |  |

---

#### `aof deps list`

Show installed package versions

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--prod` | Show only production dependencies | `false` |
| `--dev` | Show only dev dependencies | `false` |

---

### `aof channel`

Update channel management

---

#### `aof channel show`

Show current channel and version

---

#### `aof channel set`

Switch to a different channel (stable/beta/canary)

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes |  |

---

#### `aof channel check`

Check for updates on current channel

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--force` | Force check even if checked recently | `false` |

---

#### `aof channel info`

Show version info for a channel

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes |  |

---

### `aof update`

Update AOF to latest version

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--channel <name>` | Switch channel and update (stable/beta/canary) |  |
| `--rollback` | Rollback to previous version | `false` |
| `--backup <path>` | Backup path for rollback |  |
| `--yes` | Skip confirmation prompt | `false` |

---

### `aof setup`

Run post-installation setup (wizard, migrations, plugin wiring)

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--auto` | Fully automatic mode, no prompts | `false` |
| `--data-dir <path>` | AOF root directory | `"/Users/xavier/.aof"` |
| `--upgrade` | Existing installation detected, run upgrade flow | `false` |
| `--legacy` | Legacy installation detected at ~/.openclaw/aof/ | `false` |
| `--openclaw-path <path>` | Explicit OpenClaw config path |  |
| `--template <template>` | Org chart template (minimal or full) | `"minimal"` |

