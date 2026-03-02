# Architecture

**Analysis Date:** 2026-02-25

## Pattern Overview

**Overall:** Event-sourced multi-agent orchestration platform with append-only file (AOF) storage, pluggable provider architecture, and distributed task scheduling.

**Key Characteristics:**
- Event-driven state management with append-only event logs
- Multi-agent system with isolated workspaces and shared services
- Pluggable authentication and model provider system
- Task-based workflow execution with scheduler-driven state transitions
- Session-based conversation tracking with JSONL storage
- Extension system for composable functionality
- In-memory event processing with periodic state snapshots

## Layers

**Gateway/Core:**
- Purpose: Central orchestration point managing configuration, authentication, and service routing
- Location: `/Users/xavier/.openclaw/` (root configuration via `openclaw.json`)
- Contains: Global configuration, authentication profiles, model definitions, environment variables
- Depends on: Node.js runtime, package manager (clawhub ^0.4.0)
- Used by: All agents, services, and extensions

**Agent Layer:**
- Purpose: Independent Claude-based AI agent instances with local state and conversation history
- Location: `/Users/xavier/.openclaw/agents/[agent-name]/`
- Contains: Agent-specific authentication (`auth.json`, `auth-profiles.json`), models.json, session JSONL files, QMD metadata
- Depends on: Gateway configuration, global authentication, provider APIs
- Used by: Session management, conversation execution, task processing

**Data & State Management:**
- Purpose: Persistent storage of events, tasks, state, and conversation history
- Location: `/Users/xavier/.openclaw/aof/` (append-only file store)
- Contains: Daily JSONL event logs, task queue with state transitions, state snapshots, memory indices
- Depends on: Filesystem, file rotation logic
- Used by: Scheduler, event playback, state recovery

**Services Layer:**
- Purpose: Specialized backend services for specific integrations
- Location: `/Users/xavier/.openclaw/services/`
- Contains: Integration-specific service implementations (e.g., SearXNG for web search)
- Depends on: External APIs, configuration from gateway
- Used by: Agent execution, tool invocation

**Extension System:**
- Purpose: Pluggable functionality modules for metrics, language servers, protocol bridging
- Location: `/Users/xavier/.openclaw/extensions/`
- Contains: Compiled/bundled extension packages with `openclaw.plugin.json` manifests
- Depends on: Plugin specification, gateway configuration
- Used by: Gateway, agents, services

**Storage & Persistence:**
- Purpose: Multi-modal data storage for agent state, memory, and conversation logs
- Location: `/Users/xavier/.openclaw/memory/` (SQLite databases per agent)
- Contains: Vector-searchable memory with HNSW indices, conversation embeddings
- Depends on: SQLite, vector similarity search
- Used by: Agent context window management, semantic memory retrieval

## Data Flow

**Session Execution (Agent Conversation):**

1. User initiates session or receives scheduled task via cron
2. Session JSONL file created with unique UUID (stored in `/Users/xavier/.openclaw/agents/[agent]/sessions/`)
3. Session tracks: model changes, thinking level, messages, tool calls, results
4. Each message/event appended to session JSONL with parent ID references (linked list)
5. Tool execution (via Claude's toolUse capability) returns results
6. Agent responds based on accumulated context
7. Session persists indefinitely for audit and replay

**Task Workflow:**

1. Task created in `/Users/xavier/.openclaw/aof/tasks/backlog/`
2. Scheduler polls AOF state at 30-second intervals (dry-run mode records stats)
3. Ready tasks moved to `/Users/xavier/.openclaw/aof/tasks/ready/`
4. In-progress tasks moved to `/Users/xavier/.openclaw/aof/tasks/in-progress/` with lease tracking
5. Completion moves task to `/Users/xavier/.openclaw/aof/tasks/done/` or `deadletter` on failure
6. Each state transition recorded in daily event JSONL (e.g., `2026-02-25.jsonl`)

**Scheduler Event Loop:**

1. Scheduler polls at fixed interval (30s default)
2. Evaluates task statuses: total, backlog, ready, inProgress, blocked, review, done
3. Plans actions based on task readiness and dependencies
4. Records metrics: tasksEvaluated, tasksReady, actionsPlanned, actionsExecuted, alertsRaised
5. Event appended to `/Users/xavier/.openclaw/aof/events/events.jsonl` (symlinked to current day's file)
6. In dry-run mode, no actions executed but metrics still tracked

**Model Provider Resolution:**

1. Agent specifies provider (anthropic, openai, anthropic-api, openai-api)
2. Gateway config defines provider baseUrl and API type (anthropic-messages, openai-responses)
3. Authentication retrieved from agent's `auth.json` or global profile
4. Token/OAuth refresh handled per provider type
5. Model selection from provider's model list with cost tracking

**State Management:**

- Append-only events recorded in JSONL (immutable log)
- State snapshots (in-memory) computed from event replays
- AOF tasks hold state through subdirectories: `subtasks/`, `work/`, `inputs/`, `outputs/`
- Memory backend (SQLite) maintains conversation vector embeddings
- Delivery queue holds pending message/webhook deliveries

## Key Abstractions

**Event:**
- Purpose: Immutable record of system state change
- Examples: `scheduler.poll`, session message, task state transition, auth refresh
- Pattern: JSONL with eventId, type, timestamp, actor, payload

**Task:**
- Purpose: Represents a unit of work with dependencies and state tracking
- Examples: TASK-2026-02-24-005 (backlog), TASK-2026-02-24-004 (in-progress)
- Pattern: Directory structure with metadata files, state stored as parent directory

**Session:**
- Purpose: Conversation record for a single agent interaction or scheduled run
- Examples: UUID-based JSONL files in `/agents/[agent]/sessions/`
- Pattern: Linked-list via parentId references, immutable append-only log

**Provider:**
- Purpose: Abstraction for different AI model APIs
- Examples: anthropic, openai, anthropic-api, openai-api
- Pattern: Configured in gateway, authentication per provider, model list with costs

**Extension:**
- Purpose: Pluggable module with manifest and configuration schema
- Examples: metrics-bridge (events telemetry), serena-lsp (language server), matrix (E2EE messaging)
- Pattern: Package.json + openclaw.plugin.json, isolated in subdirectory

## Entry Points

**Gateway/CLI:**
- Location: Spawned via `spawn-agent.sh` or direct invocation
- Triggers: User command, scheduled cron job, webhook
- Responsibilities: Parse config, initialize agents, start event loop, manage auth

**Scheduler:**
- Location: Built into core gateway (`aof/` logic)
- Triggers: Polling loop at fixed interval (30s default)
- Responsibilities: Evaluate task readiness, plan actions, execute transitions, log metrics

**Cron Jobs:**
- Location: `/Users/xavier/.openclaw/cron/jobs.json` (defines schedule)
- Triggers: System cron or internal job scheduler
- Responsibilities: Spawn agent session with task input, capture output, escalate alerts

**Session Agent:**
- Location: `/Users/xavier/.openclaw/agents/[agent]/sessions/`
- Triggers: Direct user message, cron task, webhook callback
- Responsibilities: Execute Claude interaction with tool support, record conversation, return output

## Error Handling

**Strategy:** Event-driven error tracking with dead-letter queue fallback

**Patterns:**
- Failed tasks moved to `/Users/xavier/.openclaw/aof/tasks/deadletter/` after retry exhaustion
- Alert events raised in scheduler output when issues detected
- Cron tasks check for "ALERT:" or "CIRCUIT BREAKER:" prefixes and escalate
- Authentication failures captured and re-attempted on token refresh
- Session execution failures recorded in JSONL but don't block subsequent messages

## Cross-Cutting Concerns

**Logging:**
- Event-sourced via JSONL append-only logs in `/Users/xavier/.openclaw/aof/events/`
- Daily file rotation (symlink to current day)
- Redaction rules configurable in `openclaw.json` (`logging.redactSensitive`, `redactPatterns`)
- OpenTelemetry export optional (OTEL disabled in current config)

**Validation:**
- Gateway config field order enforced (port, mode, bind, auth, tailscale)
- Schema validation via JSON schemas in extension manifests
- Auth profile validation per provider type (oauth vs. api_key)

**Authentication:**
- OAuth flow for browser-based providers (OpenAI)
- API key tokens stored encrypted in agent auth.json
- Refresh token handling per provider (OpenAI uses refresh_token, Anthropic uses static keys)
- Token expiration tracked with fallback re-auth on 401

---

*Architecture analysis: 2026-02-25*
