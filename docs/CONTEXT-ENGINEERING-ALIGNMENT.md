# Context Engineering Alignment — AOF ↔ Anthropic + Fowler (2026)

**Sources:**
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html  
**Date:** 2026-02-07  
**Status:** Draft (alignment + roadmap)

---

## Executive Summary

AOF already aligns strongly with context engineering principles from **Anthropic (2026)** and **Fowler/Thoughtworks (2026)** through **artifact-first design**, **Memory V2 scoping**, and the **medallion pipeline** (cold → warm → hot). These features reduce token waste, keep context deterministic, and prevent “context rot” by design.

Key gaps remain in **explicit context assembly**, **attention-budget enforcement**, **progressive disclosure**, **context transparency**, and **skills-style lazy loading**. The proposed **Context Engineering Layer (CEL)** introduces a protocol-based, evolutionary system for curating minimal high‑signal context per inference step while keeping AOF eject‑friendly (core only, no OpenClaw dependency).

---

## Principle-by-Principle Alignment

### 1) Context engineering > prompt engineering
**AOF does well**
- Artifact-first tasks carry durable context and protocols (BRD §3, §5).  
- Memory V2 scoping + medallion tiers reduce noise (docs/memory-v2-scoping.md, docs/memory-medallion-pipeline.md).
- Spawn messages are minimal and point to task artifacts (src/openclaw/executor.ts).

**Missing / misaligned**
- No formal **context assembly** pipeline (what to include, in what order, and why).  
- Context passed to agents is mostly “path pointers,” not curated bundles or budgets.

**Enhancement proposals**
- Introduce **Context Engineering Layer**: context manifest + assembler + budgeter (core).
- Standardize minimal “seed context” + explicit “optional context” in task inputs.

---

### 2) Context rot (diminishing recall with large context)
**AOF does well**
- Medallion tiers explicitly address context rot (hot ≤50KB, warm ≤150KB).  
- Cold tier excluded from Memory V2 indexing.

**Missing / misaligned**
- No active bloat detection or shrinking beyond static tiering.  
- No automated “context stewardship” in core implementation (only user stories).

**Enhancement proposals**
- Implement **Context Steward Phase 1** (Story 15): footprint tracking + thresholds + alerts.  
- Add retention policies and archival workflows (Story 16/22) as follow‑on.

---

### 3) Attention budget (tokens are finite)
**AOF does well**
- Memory scoping reduces corpus size (target 30% token reduction).  
- Hot tier hard cap (50KB) enforces low baseline.

**Missing / misaligned**
- No explicit per‑turn or per‑task token budget.  
- No token accounting at context assembly time.

**Enhancement proposals**
- **Context Budget Ledger**: approximate token counts per context bundle.  
- Add org‑chart policy for context budgets (warn/critical thresholds).  
- Emit metrics/events for budget usage and overruns.

---

### 4) Guiding principle: smallest high‑signal token set
**AOF does well**
- Deterministic, curated hot/warm tiers.  
- Task artifacts are canonical and concise by design.

**Missing / misaligned**
- No heuristics to select “smallest sufficient” context within warm tier.  
- No dedupe or signal‑weighting mechanism.

**Enhancement proposals**
- Context manifests with **priority + TTL + recency** metadata.  
- Context assembler chooses smallest set that satisfies a budget.

---

### 5) System prompts in a Goldilocks zone
**AOF does well**
- Protocols and runbooks embed behavioral guidance in tasks.  
- Hot tier `_Core/` docs centralize durable rules.

**Missing / misaligned**
- No formal “briefing template” or mid‑level guidance for tasks.  
- Spawn message does not include calibrated behavioral guardrails.

**Enhancement proposals**
- Add **briefing templates** (role‑based) stored in core and referenced by context manifests.  
- Keep templates small and explicit; avoid hardcoding brittle rules.

---

### 6) Tools: self‑contained, minimal overlap, token‑efficient
**AOF does well**
- Tool set is small and non‑overlapping (`aof_task_update`, `aof_task_complete`, `aof_status_report`).  
- Deterministic outputs (no LLM work in control plane).

**Missing / misaligned**
- Tool outputs can be verbose (status_report returns full task list).  
- No standard response envelope for compact vs full output.

**Enhancement proposals**
- Add **compact response mode** + `limit`/`fields` options.  
- Standardize tool response envelope (`summary`, `detailsRef`, `warnings`).

---

### 7) Just‑in‑time context
**AOF does well**
- Spawn message points to task artifact path (JIT by design).  
- Inputs/outputs directories exist for task‑specific context.

**Missing / misaligned**
- No canonical context manifest to describe what to load on demand.  
- No “context loader” tool that resolves identifiers into artifacts.

**Enhancement proposals**
- Introduce **Context Manifest** (`inputs/context-manifest.json`).  
- Provide `aof_context_load` tool to fetch specific context items on demand.

---

### 8) Progressive disclosure
**AOF does well**
- Agents can discover context by opening task artifacts and linked docs.  
- Warm tier is role‑scoped (pre‑filtered).

**Missing / misaligned**
- No standard layering of context (seed → optional → deep).  
- No protocol for incremental disclosure.

**Enhancement proposals**
- Add **context layers** in manifest (seed / optional / deep).  
- Context assembler includes only seed by default; agents request more.

---

### 9) Hybrid strategy (pre‑load + explore)
**AOF does well**
- Hot tier preloaded for all agents; warm tier per role.  
- Cold tier is explicit on‑demand only.

**Missing / misaligned**
- Hybrid strategy not codified in a formal protocol or config.  
- No “default context” per role beyond memory pools.

**Enhancement proposals**
- Add **role‑default context seeds** in org chart (lightweight pointers).  
- Context assembler merges defaults + task‑specific inputs.

---

### 10) Long‑horizon techniques (compaction, notes, sub‑agents)
**AOF does well**
- Task artifacts + inputs/outputs = structured note‑taking.  
- Resume protocol + event log supports continuity.  
- Dispatch layer supports sub‑agent orchestration.

**Missing / misaligned**
- Compaction awareness exists only as a poll fallback (no handoff notes).  
- No standard “sub‑agent summary” protocol for condensed returns.

**Enhancement proposals**
- Add **compaction handoff notes** written to task outputs.  
- Add **sub‑agent summary template** (1–2K tokens) to standardize returns.

---

## Additional Alignment — Fowler/Thoughtworks (Coding Agents)

### A) Instructions vs Guidance (two prompt types)
**AOF does well**
- Task cards and runbooks already mix “what to do” with conventions and rules.

**Missing / misaligned**
- No explicit distinction between **instructions** (do X) and **guidance** (conventions/rules).
- No linting to ensure both are present where needed.

**Enhancement proposals**
- Add **task template sections** (`## Instructions`, `## Guidance`).
- Optional frontmatter pointers (`instructionsRef`, `guidanceRef`) for reuse.
- Linter rule: tasks with runbooks must include guidance section.

---

### B) Context interfaces (tools, MCP, skills)
**AOF does well**
- Core tools are minimal and deterministic.
- MCP is already on roadmap (`ROADMAP-REQUEST-mcp-integration.md`).

**Missing / misaligned**
- No **context interface registry** describing how to fetch more context.
- Skills (lazy‑loadable bundles) are not defined.

**Enhancement proposals**
- Add a **Context Interface Registry** in core (tools, MCP servers, skills).
- Define skills as manifest‑backed bundles of docs/scripts/rules.

---

### C) Who decides to load context (LLM vs human vs agent software)
**AOF does well**
- Scheduler and hooks provide deterministic lifecycle points for loading seed context.

**Missing / misaligned**
- No explicit policy on **who** triggers additional context loads — **critical for dispatcher design**.

**Enhancement proposals**
- Add org‑chart **context loading policy**:
  - `seed`: agent software (deterministic)
  - `optional`: LLM via `aof_context_load`
  - `pinned`: human/operator via CLI
- Dispatcher should enforce policy and log all loads to the ledger.

---

### D) Skills as lazy‑loaded bundles
**AOF does well**
- Task `inputs/` directories are natural carriers for bundles.

**Missing / misaligned**
- No skill manifests or lazy‑load semantics.

**Enhancement proposals**
- Add `skills/` directory with manifests (`skills/<id>/skill.json`).
- Context manifest can reference skills by ID; assembler loads on demand.

---

### E) Sub‑agents and clean context windows
**AOF does well**
- Dispatch executor and scheduler already support sub‑agent spawning.

**Missing / misaligned**
- No standard summary/return protocol for sub‑agents.

**Enhancement proposals**
- Sub‑agent summary template (CTX‑004).

---

### F) Context transparency (what’s using space)
**AOF does well**
- Metrics subsystem exists; Memory V2 scoping reduces noise.

**Missing / misaligned**
- No explicit transparency reports or per‑agent footprint metrics.

**Enhancement proposals**
- Context Steward Phase 1 (CTX‑005) + CLI report (`aof context report`).

---

### G) Build up gradually (don’t over‑engineer)
**AOF does well**
- Phased roadmap enables incremental adoption.

**Enhancement proposals**
- Roll out CEL behind feature flags (seed‑only → progressive disclosure → skills).

---

### H) Probability, not certainty (graceful degradation)
**AOF does well**
- Deterministic control plane + degrade‑safely on drift.

**Enhancement proposals**
- Explicitly document: CEL improves **probability**, not guarantees.
- All context features must fail safe (fallback to task artifact path + minimal seed).

---

### I) Claude Code context stack — AOF mapping
| Claude Code Layer | AOF Equivalent |
|---|---|
| CLAUDE.md (always loaded) | `_Core/` hot tier |
| Path‑scoped rules | Runbooks / policies scoped via Memory V2 |
| Skills (lazy) | Proposed `skills/` bundles (CTX‑007) |
| Subagents | Dispatch + sub‑agent summary protocol |
| MCP (structured access) | MCP integration roadmap (Phase 4.5) |
| Hooks (deterministic lifecycle) | Scheduler hooks + `api.on()` |
| Plugins (distribution) | AOF packaging / plugin adapter |

---

## Context Engineering Layer (CEL) — Proposal

### Goals
- **Smallest high‑signal context** per inference step.  
- **Explicit budgets** with graceful degradation.  
- **Just‑in‑time** context loading with progressive disclosure.  
- **Portable core** (no OpenClaw dependency).

### Core Concepts

**1) Context Manifest (per task)**
- Stored in `tasks/<status>/<TASK-ID>/inputs/context-manifest.json`.
- Contains **lightweight identifiers** (paths, URLs, pool ids, queries) and metadata (priority, TTL, layer).

Example:
```json
{
  "version": 1,
  "seed": [
    {"type": "path", "value": "docs/BRD.md", "priority": "high"},
    {"type": "runbook", "value": "runbooks/swe/Review.md"}
  ],
  "optional": [
    {"type": "path", "value": "docs/ADR-001.md", "priority": "medium"}
  ],
  "deep": [
    {"type": "query", "value": "decisions auth"}
  ]
}
```

**2) Context Assembler (core service)**
- Resolves manifest items via **pluggable resolvers** (filesystem, memory pool, URL).  
- Applies **budget policy** (seed‑first, then optional until budget is hit).  
- Emits a **Context Bundle** (small summary + references).

**3) Context Interfaces + Skills**
- Registry of **context interfaces** (tools, MCP, skills).  
- Skills are **lazy‑loadable bundles** with manifests (docs/scripts/rules).

**4) Load Decision Policy**
- Explicit policy for **who loads context**: agent software (seed), LLM (optional), human (pinned).  
- All loads are logged to the ledger for auditability.

**5) Context Budgeter**
- Simple token estimation (char‑based) + thresholds from org chart.  
- Logs budget usage in event log and metrics.

**6) Context Ledger**
- Records: what was loaded, size, why (seed/optional), and when.  
- Enables Context Steward and compaction workflows.

**7) Context Protocols (evolutionary)**
- **Progressive disclosure** is a protocol, not a hardcoded rule.  
- Policies can evolve (e.g., “recall‑first” vs “budget‑first”).  
- New resolvers and budget strategies can be added without schema breakage.

### Integration Flow (high level)
```
Task created → Context manifest created → Scheduler dispatches task
  → Context assembler builds seed bundle (budgeted, deterministic)
  → Spawn message includes: task path + bundle summary + manifest path
  → Optional loads triggered by:
      - LLM via aof_context_load
      - Human via CLI pin/unpin
      - Agent software hooks at lifecycle points
  → Context ledger updated
```

### Eject‑Friendly by Design
- All CEL components live in **AOF core**.  
- OpenClaw adapter only wires tool registration and event hooks.  
- Standalone mode uses the same context assembly system.

---

## Task Cards Created (Backlog)

- **CTX-001** — Context Engineering Layer (manifest + assembler, core)  
- **CTX-002** — Context Budget Ledger + org‑chart budgets + metrics  
- **CTX-003** — Tool response optimization (compact mode + envelope)  
- **CTX-004** — Compaction handoff notes + sub‑agent summary protocol  
- **CTX-005** — Context Steward Phase 1 (footprint tracking + transparency + alerts)  
- **CTX-006** — Instructions vs Guidance split in task templates + lint  
- **CTX-007** — Skills bundles + context interface registry

**Existing related backlog:** `ROADMAP-REQUEST-context-bundling.md` (inputs/outputs as context carriers).

---

## Notes / Constraints
- CEL must remain **flexible and evolutionary**; avoid hardcoding model‑specific heuristics.  
- Build iteratively (seed → progressive disclosure → skills); avoid over‑engineering.  
- Context engineering improves **probability**, not certainty — design for graceful degradation.  
- No new dependencies unless approved by swe‑security (policy).  
- All context engineering features belong to the **core library** to preserve ejectability.
