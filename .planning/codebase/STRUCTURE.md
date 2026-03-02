# Codebase Structure

**Analysis Date:** 2026-02-25

## Directory Layout

```
/Users/xavier/.openclaw/
├── .planning/                    # GSD planning documents (generated)
├── .claude/                      # Claude session memory and project context
├── agents/                       # Multi-agent workspace directory
│   ├── main/                     # Primary agent instance
│   │   ├── agent/                # Agent-specific config and state
│   │   ├── qmd/                  # QMD metadata cache
│   │   └── sessions/             # Conversation JSONL files (UUID-based)
│   ├── [agent-name]/             # Additional agent instances (swe-ai, researcher, etc.)
│   │   ├── agent/
│   │   ├── qmd/
│   │   └── sessions/
│   └── codebase/                 # Codebase analysis output directory
├── aof/                          # Append-only file store (event sourcing)
│   ├── events/                   # Daily event logs (JSONL)
│   ├── state/                    # State snapshots directory
│   │   └── runs/                 # Run-specific state traces
│   ├── tasks/                    # Task queue with state-based directories
│   │   ├── backlog/              # Unscheduled tasks
│   │   ├── ready/                # Tasks ready for execution
│   │   ├── in-progress/          # Currently executing tasks
│   │   ├── done/                 # Completed tasks
│   │   ├── blocked/              # Tasks waiting on dependencies
│   │   ├── review/               # Tasks awaiting approval
│   │   └── deadletter/           # Failed tasks (retry exhausted)
│   └── memory/                   # Vector database and embeddings
├── memory/                       # Per-agent SQLite conversation databases
│   ├── main.sqlite               # Main agent memory
│   ├── [agent-name].sqlite       # Agent-specific memory stores
│   └── *.sqlite                  # One DB per active agent
├── delivery-queue/               # Pending message/webhook deliveries (UUID-based)
├── cron/                         # Job scheduler configuration
│   ├── jobs.json                 # Job definitions with schedule
│   └── runs/                     # Execution logs per job
├── matrix/                       # Matrix E2EE messaging backend
│   └── accounts/                 # Matrix account credentials
├── extensions/                   # Pluggable extension modules
│   ├── metrics-bridge/           # Event telemetry bridge
│   ├── serena-lsp/               # Language server protocol extension
│   └── [extension-name]/         # Additional extensions
├── services/                     # Specialized backend services
│   └── searxng/                  # Web search service integration
├── skills/                       # Reusable agent skill library
│   ├── aof/                      # AOF-specific skills
│   ├── self-improving-agent/     # Agent self-improvement logic
│   ├── github/                   # GitHub integration skills
│   └── [skill-name]/             # Domain-specific skills
├── skills-cold/                  # Archived/inactive skills
├── workspace/                    # Project/workspace files
│   ├── Projects/                 # User project directories
│   ├── archive/                  # Old artifacts and builds
│   └── scripts/                  # Utility and cron scripts
├── logs/                         # System logs (rotated)
├── identity/                     # User identity and profile configuration
├── security/                     # Security configuration
│   └── yara-rules/               # Malware/code analysis rules
├── devices/                      # Device registration and state
├── credentials/                  # Encrypted credential storage (never read)
├── secrets/                      # Encrypted secrets (never read)
├── checkpoints/                  # State checkpoints for recovery
├── completions/                  # Claude API completion caches
├── browser/                      # Browser automation state
├── canvas/                       # Canvas rendering cache
├── media/                        # Media files and assets
├── extensions-backup/            # Backup of extension state
├── subagents/                    # Sub-agent orchestration
├── bin/                          # Executable binaries and wrappers
│   └── OpCLI.app/                # 1Password CLI wrapper (macOS app bundle)
├── 1password/                    # 1Password integration
├── settings/                     # System settings and preferences
├── node_modules/                 # JavaScript dependencies
├── workspace-[scope]/            # Scoped workspace directories (main, swe-*, etc.)
├── openclaw.json                 # Main gateway configuration file
├── package.json                  # NPM dependencies (minimal, via clawhub)
├── package-lock.json             # Dependency lock file
├── auth-profiles.json            # Global authentication profiles (encrypted)
├── exec-approvals.json           # Approval logs for dangerous operations
├── cron_analysis_state.json      # Cron job analysis state
├── cron_audit_state.json         # Cron job audit state
└── update-check.json             # Version update tracking

```

## Directory Purposes

**agents/**
- Purpose: Contains all agent instances with their isolated configuration, state, and conversation logs
- Contains: Agent subdirectories (main, swe-ai, researcher, etc.), each with agent/, qmd/, sessions/
- Key files: `auth.json` (per-agent auth), `models.json` (agent model config), `sessions/*.jsonl` (conversations)

**aof/**
- Purpose: Append-only file store implementing event sourcing for system state
- Contains: Daily event logs (JSONL), task queue state, memory snapshots
- Key files: `events/[date].jsonl` (event log), `tasks/*/` (state directories), `memory/` (vector index)

**memory/**
- Purpose: Persistent conversation and semantic memory storage per agent
- Contains: SQLite databases with vector embeddings for semantic search
- Key files: `main.sqlite` (30MB), `swe-suite.sqlite` (19MB), per-agent stores

**delivery-queue/**
- Purpose: Queue for pending message deliveries and webhook callbacks (UUID-based)
- Contains: JSON files for each pending delivery with retry metadata
- Key files: UUID-named `.json` files with delivery state

**cron/**
- Purpose: Job scheduling and automation configuration
- Contains: Job definitions and execution logs
- Key files: `jobs.json` (schedule definitions), `runs/[date]/` (execution logs)

**extensions/**
- Purpose: Pluggable extension modules with isolated dependencies
- Contains: Package-based extensions with manifest and configuration
- Key files: `[name]/openclaw.plugin.json` (manifest), `package.json` (dependencies)

**services/**
- Purpose: Specialized backend service integrations
- Contains: Service-specific implementation and credentials
- Key files: `searxng/` (web search), others as added

**skills/**
- Purpose: Reusable agent capability library
- Contains: Domain-specific skill definitions and implementations
- Key files: Skill directories organized by domain (aof/, github/, security-auditor/, etc.)

**workspace/**
- Purpose: User project files and script utilities
- Contains: Project directories, scripts, and archived artifacts
- Key files: `Projects/` (active projects), `scripts/` (utility scripts), `archive/` (historical builds)

## Key File Locations

**Entry Points:**
- `openclaw.json`: Gateway configuration (auth, models, services, diagnostics)
- `package.json`: Runtime dependencies (currently minimal: clawhub)
- `/Users/xavier/.openclaw/bin/spawn-agent.sh`: Agent launcher script

**Configuration:**
- `/Users/xavier/.openclaw/openclaw.json`: Global gateway config (45KB, includes model definitions, auth profiles, provider settings)
- `/Users/xavier/.openclaw/agents/[agent]/agent/auth.json`: Per-agent authentication state
- `/Users/xavier/.openclaw/agents/[agent]/agent/models.json`: Per-agent model configuration
- `/Users/xavier/.openclaw/cron/jobs.json`: Scheduled job definitions

**Core Logic:**
- `/Users/xavier/.openclaw/aof/`: Event sourcing implementation (events JSONL, task state, memory)
- `/Users/xavier/.openclaw/agents/[agent]/sessions/`: Agent conversation logs (JSONL per session UUID)
- `/Users/xavier/.openclaw/memory/*.sqlite`: Agent memory databases with vector indices

**Testing:**
- None detected - system appears to be production runtime only

## Naming Conventions

**Files:**
- Configuration: `*.json` (openclaw.json, auth.json, models.json, jobs.json)
- Data logs: `YYYY-MM-DD.jsonl` (event logs with daily rotation)
- Sessions: `[UUID].jsonl` (e.g., `001cdc9e-072d-4468-add0-9016f58a9a82.jsonl`)
- Databases: `[agent-name].sqlite` (e.g., main.sqlite, swe-suite.sqlite)
- Delivery queue: `[UUID].json` (32-character UUIDs)
- Task IDs: `TASK-YYYY-MM-DD-###` (e.g., TASK-2026-02-24-005)

**Directories:**
- Agents: `[agent-name]` (lowercase, hyphenated: main, swe-ai, swe-architect)
- Workspace scopes: `workspace-[scope]` (e.g., workspace-main, workspace-swe-backend)
- State directories in tasks: Standard names (backlog, ready, in-progress, done, deadletter)
- Date-based: ISO 8601 format (2026-02-25)

## Where to Add New Code

**New Feature/Skill:**
- Skill code: `skills/[domain-name]/` (create subdirectory, implement as module)
- Tests: None required (system is runtime-only)
- Configuration: Add to `/Users/xavier/.openclaw/openclaw.json` under appropriate section

**New Agent:**
- Directory: `/Users/xavier/.openclaw/agents/[agent-name]/`
- Structure: `agent/` (auth.json, models.json), `qmd/` (metadata), `sessions/` (will auto-create)
- Config: Create agent-specific auth.json with provider credentials

**New Extension:**
- Directory: `/Users/xavier/.openclaw/extensions/[extension-name]/`
- Files: `package.json` (dependencies), `openclaw.plugin.json` (manifest with configSchema)
- Pattern: Self-contained package with schema validation

**New Service:**
- Directory: `/Users/xavier/.openclaw/services/[service-name]/`
- Implementation: Service-specific integration code
- Configuration: Reference in `openclaw.json` services section

**Scheduled Jobs:**
- Definition: Add entry to `/Users/xavier/.openclaw/cron/jobs.json`
- Script: Place executable in `/Users/xavier/.openclaw/workspace/scripts/`
- Output: Will be captured and logged in `/Users/xavier/.openclaw/cron/runs/`

## Special Directories

**node_modules/:**
- Purpose: JavaScript dependencies for clawhub framework
- Generated: Yes (npm install)
- Committed: No (listed in .gitignore)

**workspace-[scope]/ (workspace-main, workspace-swe-*, etc.):**
- Purpose: Isolated workspaces per agent/domain with local git repos
- Generated: No (user-created)
- Committed: Yes (separate git repos)

**aof/memory/:**
- Purpose: Vector search index (HNSW) for semantic memory
- Generated: Yes (auto-built from sessions)
- Committed: No (rebuilds on startup)

**.git/:**
- Purpose: Version control for OpenClaw system itself
- Generated: No (initialized once)
- Committed: Yes

**.claude/:**
- Purpose: Claude Code project memory and context
- Generated: Yes (auto-managed)
- Committed: No

**memory-backup-***:**
- Purpose: Timestamped backups of agent memory databases
- Generated: Yes (manual or automatic backups)
- Committed: No

---

*Structure analysis: 2026-02-25*
