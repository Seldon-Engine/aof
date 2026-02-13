# Context Engineering for AOF — AI/ML Expert Analysis

**Author:** swe-ai  
**Date:** 2026-02-07  
**Status:** Technical Recommendation  
**Related:**
- Anthropic "Effective Context Engineering for AI Agents" (2026)
- Martin Fowler/Thoughtworks "Context Engineering for Coding Agents" (2026)

---

## Executive Summary

This document analyzes **two foundational context engineering research articles** and provides **concrete, actionable recommendations** for how AOF should implement context budget optimization, retrieval strategies, compaction, progressive disclosure, memory tier optimization, and evolutionary architecture patterns.

**Primary sources:**
1. **Anthropic** — Theoretical principles (attention budget, context rot, just-in-time loading)
2. **Fowler/Thoughtworks** — Practical patterns (Skills, context interfaces, decision modes, Claude Code's stack)

This analysis synthesizes both perspectives into a unified implementation roadmap for AOF.

**Core thesis:** AOF's filesystem-as-API design and medallion pipeline are **already well-aligned** with both research frameworks. Anthropic provides the theoretical foundation (attention budget, context rot, compaction); Fowler provides practical patterns (Skills, decision modes, transparency). The recommendations focus on **making the implicit explicit** — instrumenting, measuring, and iteratively optimizing what's already working.

**Key recommendations (synthesized from both sources):**

**From Anthropic (theory):**
1. **Context budget modeling:** Quality-weighted token accounting with signal density scoring
2. **Compaction optimization:** Metadata-driven hints + re-retrieval paths + tool result clearing (30-50% savings)
3. **Memory tier optimization:** Align medallion tiers with signal density, not just size
4. **Evolutionary architecture:** Plugin pattern for curation strategies + A/B testing framework

**From Fowler (practice):**
5. **Skills pattern:** Lazy-loaded context bundles (warm tier → opt-in, 40-60% savings)
6. **Decision mode tracking:** Instrument autonomous vs manual vs deterministic context loading
7. **Context transparency:** Real-time budget dashboard (`aof context status`)
8. **Probabilistic thinking:** Graceful degradation over rigid enforcement

**Unified strategy:**
9. **Hybrid retrieval:** Hot (deterministic) + Skills (autonomous) + Cold (on-demand)
10. **Progressive disclosure:** Task card as context index; lazy artifact loading; tool-driven exploration

**Implementation philosophy:** Start simple (heuristic rules), measure everything (token + decision mode tracking), think probabilistically (graceful degradation), build up gradually (Phase 1 → 2 → 3), and iterate empirically (A/B testing). Context engineering is evolving research — AOF's architecture must evolve with it.

---

## 0. Context Interfaces & Decision Modes (Fowler/Thoughtworks Framework)

Before diving into budget modeling, we must establish **how agents acquire context** and **who decides what to load**. The Fowler/Thoughtworks article identifies this as the foundational architectural question.

### 0.1 Context Interface Taxonomy

**Three primary mechanisms for context acquisition:**

| Interface | Description | Token Cost | Who Decides | AOF Mapping |
|-----------|-------------|------------|-------------|-------------|
| **Tools** | Imperative context retrieval (exec, read, web_fetch) | Per-call | LLM (autonomous) | OpenClaw tools |
| **MCP Servers** | Protocol-based context providers (filesystem, database) | Per-query | LLM (autonomous) | Future integration |
| **Skills** | Lazy-loaded context bundles (rules, patterns, templates) | Pre-computed | LLM (by description) | Memory V2 warm pools |

**Key insight from Fowler:** These are **not just features** — they are **first-class context sources** that must be tracked, budgeted, and optimized.

---

### 0.2 Decision Mode Matrix: "Who Decides to Load Context?"

The Fowler article identifies **three decision modes** for context loading:

#### 0.2.1 Autonomous (LLM-Decided)

**Definition:** The LLM itself decides what context to load, based on task requirements and available tools/skills.

**Example:**
```typescript
// LLM reasoning:
// "I need to understand the payment processor code."
// → Tool call: read("src/payment/processor.ts")

// "I should check recent deploy patterns."
// → Skill match: "deploy-patterns" → load warm/runbooks/deploy-backend.md
```

**Characteristics:**
- **Latency:** Medium (tool call roundtrip)
- **Relevance:** High (LLM knows what it needs)
- **Cost:** Variable (tool calls + context tokens)
- **Risk:** Overconsumption (LLM may load too much)

**AOF implications:**
- Tools must be **token-efficient** (return summaries, not full files)
- Skills must have **clear descriptions** (enable accurate matching)
- Budget tracking must account for **dynamic loading patterns**

---

#### 0.2.2 Manual (Human-Decided)

**Definition:** Human operator explicitly specifies context to load (via task card, config, or runtime directive).

**Example:**
```yaml
# Task card with explicit context directives
---
id: TASK-2026-02-07-042
metadata:
  contextHints:
    - "payment-processor"        # Human specifies relevant skill
    - "incident-2026-02-05"      # Human specifies relevant log
  requiredArtifacts:
    - "artifacts/incident-report.md"  # Human mandates this context
---
```

**Characteristics:**
- **Latency:** None (preloaded)
- **Relevance:** Variable (depends on human judgment)
- **Cost:** Fixed (known upfront)
- **Risk:** Over-specification (human loads too much "just in case")

**AOF implications:**
- Task schema must support **explicit context hints** (Section 4.2.1)
- Humans should see **token cost preview** before submitting task
- Audit trail: log human-specified context vs actually-used context

---

#### 0.2.3 Deterministic (Agent Software-Decided)

**Definition:** AOF's orchestration layer decides what context to load based on **routing rules, task type, and agent role**.

**Example:**
```typescript
// AOF scheduler logic:
const agent = resolveAgent(task.frontmatter.routing.role); // "swe-backend"

// Deterministic context loading:
const context = {
  systemPrompt: loadSystemPrompt(agent),
  tools: loadTools(agent.capabilities),
  memoryHot: loadHotTier(),  // Always
  memoryWarm: loadWarmTier(agent.role), // Role-based
  taskCard: loadTaskCard(task.frontmatter.id),
};

// No LLM involvement in context selection
```

**Characteristics:**
- **Latency:** Low (precomputed)
- **Relevance:** Medium (rule-based heuristics)
- **Cost:** Predictable (same pattern per agent role)
- **Risk:** Over-provisioning (rules may be stale)

**AOF implications:**
- Memory V2 org chart mappings are **deterministic decisions**
- Routing rules should be **empirically tuned** (track success rates)
- Optimization: migrate from deterministic → autonomous as LLM improves

---

### 0.3 Unified Decision Model for AOF

**Recommendation:** AOF should support **all three modes** with explicit tracking.

```typescript
interface ContextSource {
  id: string;
  type: "tool" | "skill" | "memory_pool" | "artifact";
  tokens: number;
  decisionMode: "autonomous" | "manual" | "deterministic";
  decidedBy: string; // "llm" | "human:<userId>" | "aof:<rule>"
  loadedAt: Date;
  used: boolean; // Did LLM actually attend to this?
}

interface ContextLoadEvent extends BaseEvent {
  type: "context.loaded";
  taskId: string;
  agentId: string;
  payload: {
    source: ContextSource;
  };
}
```

**Metrics to track:**
- **Utilization by decision mode:** Which mode loads most relevant context?
- **Waste by decision mode:** Which mode loads unused context?
- **Cost by decision mode:** Which mode is most token-efficient?

**Visualization:**
```bash
aof context decisions --task TASK-2026-02-07-042

Context Decision Analysis
=========================
Autonomous (LLM):
  Loaded: 5 sources (34,567 tokens)
  Used: 4 sources (31,234 tokens)
  Waste: 3,333 tokens (9.6%)
  Examples:
    ✓ Tool: read(payment-processor.ts) → used
    ✓ Skill: deploy-patterns.md → used
    ✗ Tool: read(config.json) → unused

Manual (Human):
  Loaded: 3 sources (18,234 tokens)
  Used: 2 sources (8,123 tokens)
  Waste: 10,111 tokens (55.4% ⚠️)
  Examples:
    ✓ Artifact: incident-report.md → used
    ✗ Artifact: payment-logs.jsonl → unused (too large, not needed)

Deterministic (AOF):
  Loaded: 6 sources (45,678 tokens)
  Used: 5 sources (42,345 tokens)
  Waste: 3,333 tokens (7.3%)
  Examples:
    ✓ Memory hot: _Core/ → used
    ✓ Memory warm: runbooks/swe/ → used
    ✗ Memory warm: decisions/ → unused (not relevant to this task)

Recommendation: Manual mode has 55% waste — consider reducing requiredArtifacts
```

**Key insight:** Tracking decision modes enables **empirical optimization** — AOF can learn which mode produces best results per task type.

---

### 0.4 Skills as Lazy-Loaded Context Bundles (Practical Implementation)

The Fowler article highlights **Skills** as the practical implementation of just-in-time + progressive disclosure.

**Definition:** A Skill is a **self-describing context bundle** loaded by the LLM when description matches task requirements.

**Claude Code example:**
```yaml
# skills/deploy-backend.yaml
name: deploy-backend
description: "Deployment patterns and rollback procedures for backend services"
keywords: ["deploy", "release", "rollback", "production"]
format: markdown
size: 12KB
content: |
  # Backend Deployment Patterns
  
  ## Prerequisites
  - AWS credentials configured
  - Docker image built and tagged
  ...
```

**LLM interaction:**
```
Task: "Deploy the payment processor to production"

LLM reasoning:
- "I need deployment guidance."
- Available skills: [deploy-backend, deploy-frontend, incident-response, ...]
- Best match: "deploy-backend" (keywords: deploy, production)
- Load skill → 12KB added to context

LLM: "Following the deploy-backend skill, first I'll verify prerequisites..."
```

---

#### 0.4.1 Skills vs Memory V2 Warm Pools

**Mapping to AOF:**

| Fowler Concept | AOF Equivalent | Current State | Needed Enhancement |
|----------------|----------------|---------------|-------------------|
| **Skill** | Warm pool document | Preloaded (all docs in pool) | Add **lazy loading by description** |
| **Skill description** | File metadata / frontmatter | Not present | Add **skill manifest** |
| **Skill matching** | Manual contextHints in task | Human-specified | Add **LLM-autonomous matching** |

**Proposed AOF implementation:**

```typescript
// Skill manifest (frontmatter in warm docs)
---
skill:
  name: deploy-backend
  description: "Deployment patterns for backend services"
  keywords: ["deploy", "release", "rollback", "production", "backend"]
  estimatedTokens: 12000
  prerequisites: ["aws-credentials", "docker"]
  relatedSkills: ["incident-response", "rollback-procedures"]
---

# Backend Deployment Patterns
...
```

**Lazy loading protocol:**

```typescript
// Tool: list available skills
interface ListSkillsTool {
  name: "list_skills";
  description: "List available skills (context bundles) for current agent";
  parameters: {
    query?: string; // Optional keyword filter
  };
  returns: {
    skills: Array<{
      name: string;
      description: string;
      keywords: string[];
      estimatedTokens: number;
    }>;
  };
}

// Tool: load skill
interface LoadSkillTool {
  name: "load_skill";
  description: "Load a skill (context bundle) into working context";
  parameters: {
    name: string;
  };
  returns: {
    content: string;
    tokensAdded: number;
  };
}

// LLM autonomous flow:
// 1. LLM: list_skills(query="deploy") → sees deploy-backend (12KB)
// 2. LLM: load_skill("deploy-backend") → 12KB loaded
// 3. LLM: uses deploy-backend patterns to execute task
```

**Benefit:** Warm tier docs become **opt-in** instead of **always-loaded** — significant token savings.

---

#### 0.4.2 Skills + Budget Allocation

Skills integrate with Section 1's budget model:

```typescript
interface ContextBudget {
  // ... existing fields ...
  
  skillsAvailable: number;      // How many skills agent can access
  skillsLoaded: number;         // How many skills currently loaded
  skillsBudget: number;         // Max tokens for skills
  skillsConsumed: number;       // Actual tokens used by loaded skills
}

function allocateSkillsBudget(
  task: Task,
  agent: AgentConfig,
  policy: ContextBudgetPolicy
): number {
  // Reserve 20% of budget for on-demand skill loading
  const totalBudget = policy.targetEffectiveTokens;
  return totalBudget * 0.20;
}
```

**Dynamic skill loading:**
```typescript
async function loadSkill(
  skillName: string,
  currentBudget: ContextBudget
): Promise<{ content: string; success: boolean }> {
  const skill = await getSkill(skillName);
  
  // Check budget before loading
  if (currentBudget.skillsConsumed + skill.estimatedTokens > currentBudget.skillsBudget) {
    // Budget exceeded — offer summary or deny
    return {
      content: await summarizeSkill(skill),
      success: false
    };
  }
  
  // Load full skill
  currentBudget.skillsLoaded += 1;
  currentBudget.skillsConsumed += skill.estimatedTokens;
  
  return {
    content: skill.content,
    success: true
  };
}
```

---

### 0.5 Claude Code's Context Stack (Reference Architecture)

Fowler/Thoughtworks provides Claude Code's context stack as a reference:

```
CLAUDE.md (always present, ~1KB)
  ↓
Rules (path-scoped, ~5KB per directory)
  ↓
Skills (lazy-loaded, ~10KB per skill, LLM-decided)
  ↓
Subagents (own isolated context, returns summary)
  ↓
MCP Servers (protocol-based context retrieval)
  ↓
Hooks (event-driven context injection)
  ↓
Plugins (user-extensible context providers)
```

**Comparison to AOF's proposed stack:**

| Claude Code Layer | AOF Equivalent | Implementation Status | Gap Analysis |
|-------------------|----------------|----------------------|--------------|
| **CLAUDE.md** | Hot tier (_Core/) | ✅ Implemented (Memory V2) | None |
| **Rules** | Path-scoped warm docs | 🟡 Partial (warm pools, not path-scoped) | Add path-scoped rules |
| **Skills** | Warm docs (to be lazy-loaded) | ❌ Not implemented | Add skill manifest + lazy loading |
| **Subagents** | Sub-agent spawning | ✅ Implemented (existing) | Enhance summary protocol |
| **MCP Servers** | Future integration | ❌ Not implemented | Phase 2+ |
| **Hooks** | Event-driven context | 🟡 Partial (event logger exists) | Add context injection on events |
| **Plugins** | Strategy plugins (Section 6) | ❌ Not implemented | Add plugin registry |

**Key gaps to address:**

1. **Path-scoped rules:** Warm docs scoped to specific directories (e.g., `src/payment/` rules only apply in that subtree)
2. **Lazy-loaded skills:** Current warm pools are preloaded; should be opt-in
3. **MCP integration:** Protocol-based context retrieval (future Phase 2+)
4. **Event-driven hooks:** Context injected based on task lifecycle events

---

### 0.6 Context Transparency (Critical UX Requirement)

Fowler emphasizes: **"Knowing how full context is, what takes up space, is CRUCIAL."**

**AOF's Context Steward must provide:**

1. **Real-time budget visibility**
   ```bash
   aof context status
   
   Context Budget: 87,234 / 120,000 tokens (73% capacity)
   
   Breakdown:
     System prompt    12,456 tokens (14%) ███████░░░░
     Tools            13,789 tokens (16%) ████████░░░
     Task card        18,234 tokens (21%) ██████████░
     Memory hot       21,567 tokens (25%) ████████████
     Memory warm      15,432 tokens (18%) █████████░░
     Skills (loaded)   2,890 tokens ( 3%) █░░░░░░░░░░
     History           5,756 tokens ( 7%) ███░░░░░░░░
   
   Available skills (not loaded): 12 (est. 145KB)
   Budget remaining: 32,766 tokens (27%)
   ```

2. **Per-component attribution**
   ```typescript
   interface ContextAttribution {
     component: string;
     path?: string;
     tokens: number;
     percentOfTotal: number;
     loaded: "preloaded" | "autonomous" | "manual" | "deterministic";
     used: boolean;
   }
   ```

3. **Predictive warnings**
   ```
   ⚠️  Context budget at 85% — consider:
     - Compacting history (save 5,756 tokens)
     - Unloading unused skills: "incident-response" (12KB, not accessed)
     - Pruning warm docs: 3 docs not accessed in this task
   ```

4. **Post-task analysis**
   ```bash
   aof context analyze --task TASK-2026-02-07-042
   
   Context Efficiency Report
   =========================
   Total loaded: 87,234 tokens
   Actually used: 64,123 tokens (73.5%)
   Wasted: 23,111 tokens (26.5%)
   
   Wasted context breakdown:
     - incident-response skill (12KB) — never accessed
     - decisions/ warm pool (8KB) — no relevant docs
     - payment-logs.jsonl (3KB) — loaded but unused
   
   Recommendations:
     - Remove incident-response from default skills for swe-backend
     - Add contextHint filter for decisions/ warm pool
     - Make payment-logs.jsonl optional artifact
   ```

---

### 0.7 Probabilistic Thinking: "Illusion of Control"

Fowler warns: **"Think in probabilities, not certainties."**

**Key principle:** Context loading is **non-deterministic** (especially in autonomous mode). AOF must embrace graceful degradation over rigid enforcement.

#### 0.7.1 Failure Modes & Graceful Degradation

| Failure Scenario | Rigid Approach (Bad) | Graceful Degradation (Good) |
|------------------|---------------------|----------------------------|
| **Skill not found** | Task fails | Load summary or similar skill |
| **Budget exceeded** | Block skill loading | Offer compressed summary |
| **MCP server timeout** | Task fails | Continue with cached context |
| **Tool call error** | Task fails | Return error + suggest alternatives |
| **Context rot detected** | Force compaction | Suggest compaction, continue |

**Implementation:**

```typescript
async function loadSkillWithFallback(
  skillName: string,
  budget: ContextBudget
): Promise<{ content: string; mode: "full" | "summary" | "fallback" }> {
  try {
    // Attempt full load
    const skill = await getSkill(skillName);
    
    if (budget.skillsConsumed + skill.estimatedTokens > budget.skillsBudget) {
      // Budget exceeded → offer summary
      return {
        content: await summarizeSkill(skill, budget.skillsBudget - budget.skillsConsumed),
        mode: "summary"
      };
    }
    
    return { content: skill.content, mode: "full" };
    
  } catch (err) {
    // Skill not found → search for similar
    const similar = await findSimilarSkills(skillName);
    if (similar.length > 0) {
      return {
        content: `Skill "${skillName}" not found. Similar: ${similar.map(s => s.name).join(", ")}`,
        mode: "fallback"
      };
    }
    
    // No fallback → return empty (don't fail task)
    return {
      content: `Skill "${skillName}" not available.`,
      mode: "fallback"
    };
  }
}
```

---

#### 0.7.2 Confidence Scoring for Context Decisions

Track **confidence** in context curation decisions:

```typescript
interface ContextDecision {
  component: string;
  decision: "include" | "exclude" | "summarize";
  confidence: number; // 0.0–1.0
  reasoning: string;
}

// Example:
const decisions: ContextDecision[] = [
  {
    component: "deploy-backend skill",
    decision: "include",
    confidence: 0.95,
    reasoning: "Task contains 'deploy' + 'production' keywords"
  },
  {
    component: "incident-response skill",
    decision: "exclude",
    confidence: 0.60,
    reasoning: "No incident-related keywords, but task is high-priority"
  }
];
```

**Usage:** Low-confidence decisions → suggest human review.

---

### 0.8 Build Up Gradually (Evolutionary Principle)

Fowler: **"Don't overengineer context upfront."**

**AOF implementation strategy:**

**Phase 1 (Simple):**
- Hot tier (always loaded)
- Warm tier (preloaded by role)
- Tool-based context (autonomous)
- Manual task hints

**Phase 2 (Optimization):**
- Skills pattern (lazy warm loading)
- Budget tracking + warnings
- Signal density scoring

**Phase 3 (Advanced):**
- MCP server integration
- Path-scoped rules
- Event-driven hooks
- Learned relevance models

**Phase 4 (Autonomous):**
- LLM-decided context loading (full autonomy)
- Real-time budget optimization
- Adaptive skill recommendations

**Key principle:** Each phase **builds on empirical data** from the previous phase. Don't jump to Phase 4 without validating Phase 1–2.

---

## 1. Context Budget Modeling

### 1.1 Problem Statement

Anthropic's research shows that attention is a **finite, depleting resource** with n² pairwise attention complexity. As context grows, recall accuracy decreases due to **context rot** — diminishing marginal returns per token.

AOF's multi-agent task orchestration exacerbates this:
- Each agent spawned with full system prompt + tools + routing logic
- Task cards can include large input artifacts (design docs, logs, data)
- Memory V2 pools pre-load entire directories (hot + warm tiers)
- Sub-agent spawning duplicates overlapping context

**Target:** Model and optimize attention budget allocation per agent lifecycle.

---

### 1.2 Proposed Solution: Quality-Weighted Token Budget

Don't just count tokens — **score them by signal density**.

#### 1.2.1 Budget Model Architecture

```typescript
interface ContextBudget {
  totalTokens: number;           // Raw token count
  qualityScore: number;           // 0.0–1.0 weighted by signal density
  effectiveTokens: number;        // totalTokens * qualityScore
  components: ContextComponent[]; // Breakdown by source
}

interface ContextComponent {
  source: "system_prompt" | "tools" | "task_card" | "memory_hot" 
        | "memory_warm" | "memory_cold" | "history" | "artifacts";
  tokenCount: number;
  signalDensity: number;          // 0.0–1.0 (higher = more relevant)
  recency: Date;                  // Temporal decay factor
  retrievalFrequency: number;     // How often LLM actually attended to this
}

interface ContextBudgetPolicy {
  maxTotalTokens: number;         // Hard limit (e.g., 150k for Sonnet 4.5)
  targetEffectiveTokens: number;  // Soft target (e.g., 80k)
  minSignalDensity: number;       // Prune components below this (e.g., 0.2)
  componentLimits: Record<ContextComponent["source"], number>;
}
```

#### 1.2.2 Signal Density Scoring

**Heuristic formula (v1):**
```typescript
signalDensity = 
  (relevanceScore * 0.5) +       // Task-specific relevance
  (recencyFactor * 0.2) +        // Temporal decay
  (retrievalFrequency * 0.2) +   // Empirical attention
  (structureFactor * 0.1);       // Well-formatted content

// Relevance scoring (TF-IDF-like)
relevanceScore = cosineSimilarity(
  taskEmbedding,
  componentEmbedding
);

// Recency decay (exponential)
recencyFactor = Math.exp(-ageDays / 30);

// Retrieval frequency (empirical)
retrievalFrequency = attentionCount / totalQueries;

// Structure factor (heuristic)
structureFactor = hasHeaders ? 1.0 : hasParagraphs ? 0.7 : 0.5;
```

**Rationale:**
- **Relevance** (50%): Not all tokens are equal — task-specific content scores higher
- **Recency** (20%): Recent context is more likely to be relevant (temporal locality)
- **Retrieval frequency** (20%): If the LLM never attends to it, prune it
- **Structure** (10%): Well-formatted Markdown > wall-of-text logs

**Evolution path:**
- **v1:** Heuristic formula (no LLM calls)
- **v2:** Learned model (train on task success + context usage patterns)
- **v3:** Real-time attention tracking (if OpenClaw exposes attention weights)

---

#### 1.2.3 Dynamic Budget Allocation (With Decision Mode Integration)

Allocate budget based on **task complexity**, **agent capabilities**, and **decision mode** (Section 0.2).

```typescript
interface TaskComplexityEstimate {
  estimatedSteps: number;        // From task card or heuristic
  requiredCapabilities: string[]; // e.g., ["filesystem", "exec", "web"]
  historicalTokenUsage: number;  // Similar past tasks
  priority: TaskPriority;        // Affects budget allocation
  autonomyLevel: "low" | "medium" | "high"; // How much LLM autonomy
}

interface BudgetAllocation {
  system_prompt: number;
  tools: number;
  task_card: number;
  memory_hot: number;          // Deterministic (always loaded)
  memory_warm: number;         // Deterministic (role-based)
  skills: number;              // Autonomous (LLM-decided)
  artifacts: number;           // Manual (human-specified)
  history: number;
  reserve: number;             // Buffer for dynamic retrieval
}

function allocateBudget(
  task: Task,
  agent: AgentConfig,
  policy: ContextBudgetPolicy
): BudgetAllocation {
  const complexity = estimateComplexity(task);
  
  // Base budget + priority multiplier
  const baseBudget = policy.targetEffectiveTokens;
  const priorityMultiplier = {
    critical: 1.5,
    high: 1.2,
    normal: 1.0,
    low: 0.8,
  }[task.frontmatter.priority];
  
  const allocatedBudget = baseBudget * priorityMultiplier;
  
  // Adjust allocation based on autonomy level
  const autonomyLevel = estimateAutonomyLevel(task, complexity);
  
  // Higher autonomy → more budget for skills/reserve (LLM decides)
  // Lower autonomy → more budget for warm/artifacts (predetermined)
  const autonomyMultipliers = {
    low: { warm: 0.25, skills: 0.10, reserve: 0.05 },
    medium: { warm: 0.15, skills: 0.20, reserve: 0.10 },
    high: { warm: 0.10, skills: 0.25, reserve: 0.15 },
  }[autonomyLevel];
  
  return {
    system_prompt: allocatedBudget * 0.10,   // 10% (fixed)
    tools: allocatedBudget * 0.10,           // 10% (fixed)
    task_card: allocatedBudget * 0.15,       // 15% (fixed)
    memory_hot: allocatedBudget * 0.20,      // 20% (deterministic)
    memory_warm: allocatedBudget * autonomyMultipliers.warm,
    skills: allocatedBudget * autonomyMultipliers.skills,
    artifacts: allocatedBudget * 0.10,       // 10% (manual)
    history: allocatedBudget * 0.05,         // 5% (minimal)
    reserve: allocatedBudget * autonomyMultipliers.reserve,
  };
}

function estimateAutonomyLevel(
  task: Task,
  complexity: TaskComplexityEstimate
): "low" | "medium" | "high" {
  // High autonomy: Exploratory tasks, unclear requirements
  if (complexity.estimatedSteps > 10 || task.frontmatter.metadata.exploratory) {
    return "high";
  }
  
  // Low autonomy: Well-defined tasks, explicit artifacts
  if (task.frontmatter.artifacts?.inputs.length > 0) {
    return "low";
  }
  
  // Default: medium
  return "medium";
}
```

**Key insights:**
1. **Decision mode affects budget allocation** — autonomous tasks reserve more for skills/reserve
2. **High autonomy tasks** (exploratory) → more LLM-decided context loading
3. **Low autonomy tasks** (well-defined) → more predetermined context
4. **Reserve buffer** (5-15%) for unexpected dynamic retrieval

**Example budget by autonomy level:**

| Component | Low Autonomy | Medium Autonomy | High Autonomy |
|-----------|--------------|-----------------|---------------|
| Deterministic (hot+warm) | 45% | 35% | 30% |
| Autonomous (skills) | 10% | 20% | 25% |
| Manual (artifacts) | 10% | 10% | 10% |
| Reserve (dynamic) | 5% | 10% | 15% |

**Rationale:** Exploratory tasks need flexibility; well-defined tasks benefit from predetermined context.

---

#### 1.2.4 Budget Tracking & Instrumentation

Add to AOF's existing event logger:

```typescript
interface ContextBudgetEvent extends BaseEvent {
  type: "context.budget";
  taskId: string;
  agentId: string;
  payload: {
    budget: ContextBudget;
    phase: "allocated" | "consumed" | "exceeded";
    overageTokens?: number;
    prunedComponents?: string[];
  };
}
```

**Metrics to track:**
- Budget utilization ratio (consumed / allocated)
- Overage frequency (% of tasks exceeding budget)
- Token efficiency (task success rate / tokens consumed)
- Signal density distribution (histogram)

**Visualization:**
```bash
aof context budget --task TASK-2026-02-07-001

Context Budget Report
=====================
Task: TASK-2026-02-07-001 (swe-backend)
Priority: high
Allocated: 96,000 effective tokens (120k raw × 0.8 avg density)
Consumed: 87,234 effective tokens (91% utilization)

Breakdown:
  System prompt     12,456 tokens (14%) ███████░░░
  Tools             13,789 tokens (16%) ████████░░
  Task card         18,234 tokens (21%) ██████████
  Memory (hot)      21,567 tokens (25%) ████████████
  Memory (warm)     15,432 tokens (18%) █████████░
  History            5,756 tokens ( 7%) ███░░░░░░░

Signal density by component:
  Task card: 0.92 ████████████████████▌
  Memory hot: 0.87 █████████████████▌
  System prompt: 0.81 ████████████████
  Tools: 0.76 ███████████████
  Memory warm: 0.64 ████████████▌
  History: 0.52 ██████████

Budget health: ✅ Optimal (no overage, high signal density)
```

---

### 1.3 Implementation Roadmap

**Phase 1 (Foundation):**
- Add token counting to event logger (track per component)
- Implement basic signal density scoring (heuristic formula)
- Add `aof context budget` command (reporting only)

**Phase 2 (Optimization):**
- Implement dynamic budget allocation (based on task complexity)
- Add pruning logic (remove low-signal components)
- A/B test different budget policies (measure task success rate)

**Phase 3 (Learning):**
- Train learned model for relevance scoring (task embedding similarity)
- Track empirical retrieval frequency (which docs LLM actually uses)
- Automated budget tuning (optimize for success rate + cost)

**Measurement criteria:**
- **Success metric:** 20% reduction in token consumption with no degradation in task success rate
- **Leading indicator:** Signal density score increases from 0.65 → 0.80 avg

---

## 2. Retrieval Strategy Evaluation

### 2.1 Strategy Comparison Matrix

| Strategy | Latency | Relevance | Freshness | AOF Fit |
|----------|---------|-----------|-----------|---------|
| **Pre-computed (RAG)** | ⚡ Low (0ms) | 🟡 Static | ❌ Stale | 🟡 Moderate |
| **Just-in-time (Agentic)** | 🟡 Medium (100-500ms) | ✅ Dynamic | ✅ Real-time | ✅ Strong |
| **Hybrid (Recommended)** | ⚡ Low (hot) + 🟡 Medium (warm/cold) | ✅ Best of both | ✅ Real-time | ⭐ Optimal |

---

### 2.2 Recommended: Hybrid Strategy

**Design principle:** "Do the simplest thing that works" (Anthropic principle #5).

#### 2.2.1 Three-Tier Retrieval Model

```typescript
interface RetrievalStrategy {
  hot: "preload";    // Always indexed, <50KB, canonical
  warm: "indexed";   // Pre-indexed but lazy-loaded based on task hints
  cold: "search";    // On-demand grep/ripgrep search
}

interface RetrievalContext {
  preloaded: string[];      // Hot tier (always present)
  indexed: string[];        // Warm tier (task-scoped subset)
  searchable: string[];     // Cold tier (paths for grep)
}
```

**Implementation:**

```typescript
async function buildRetrievalContext(
  task: Task,
  agent: AgentConfig
): Promise<RetrievalContext> {
  // 1. Hot tier: always preload (canonical core)
  const hotPaths = await resolveHotPaths(agent);
  const preloaded = await loadFiles(hotPaths);
  
  // 2. Warm tier: task-scoped hints drive indexing
  const warmPaths = await resolveWarmPaths(agent, task);
  const indexed = await selectiveIndex(warmPaths, task);
  
  // 3. Cold tier: expose as searchable (grep tools)
  const coldPaths = await resolveColdPaths(agent);
  
  return { preloaded, indexed, searchable: coldPaths };
}

async function selectiveIndex(
  warmPaths: string[],
  task: Task
): Promise<string[]> {
  // Task card can include "context hints" in metadata
  const hints = task.frontmatter.metadata.contextHints ?? [];
  
  // Filter warm docs by relevance to task
  const relevant = warmPaths.filter(path => {
    // Match by hint keywords
    if (hints.some(hint => path.includes(hint))) return true;
    
    // Match by routing (e.g., swe-backend gets swe runbooks)
    if (matchesRouting(path, task.frontmatter.routing)) return true;
    
    return false;
  });
  
  return relevant;
}
```

---

#### 2.2.2 Task-Driven Context Hints

**Extend task schema with context scoping metadata:**

```yaml
---
schemaVersion: 1
id: TASK-2026-02-07-042
title: Fix payment processor timeout
status: ready
priority: high
routing:
  role: swe-backend
metadata:
  contextHints:
    - payment-processor     # Warm doc keyword
    - stripe-integration    # Warm doc keyword
    - incident-2026-02-05   # Cold log reference
  contextScope:
    warmFilter: "runbooks/payments/**"
    coldSearchPaths:
      - "cold/incidents/2026-02-*.json"
      - "cold/logs/payment-*.jsonl"
---

Fix timeout in payment processor integration.
See incident report: cold/incidents/2026-02-05-payment-timeout.json
```

**Benefit:** Task card becomes a **context index** (Anthropic principle #4: progressive disclosure).

---

#### 2.2.3 Agentic Search Tools

Expose cold tier as **searchable** via tools:

```typescript
// Tool: grep cold tier logs
interface ColdSearchTool {
  name: "cold_search";
  description: "Search cold tier logs/transcripts/incidents";
  parameters: {
    query: string;        // grep pattern
    paths?: string[];     // Scope to specific dirs
    since?: string;       // Temporal filter (e.g., "7d")
    limit?: number;       // Max results
  };
}

// Example agent interaction:
// Agent: "Let me check recent payment failures..."
// Tool call: cold_search(query="payment.*timeout", since="7d")
// Result: [3 incidents found] → agent loads relevant incident report
```

**Key insight:** Don't dump all cold logs into context — let agent **discover incrementally** via search tools.

---

### 2.3 Comparison to Pure RAG

**Why hybrid beats pure RAG for AOF:**

1. **Dynamic task scope:** RAG embeddings are static; tasks have unique context needs
2. **Freshness:** Warm tier changes frequently (daily aggregation); RAG would require continuous re-indexing
3. **Multi-scale retrieval:** Hot (canonical) + warm (operational) + cold (archival) require different retrieval semantics
4. **Transparency:** Agentic search is auditable (tool calls logged); RAG retrieval is black-box

**When to use RAG (future):**
- Warm tier becomes too large for full indexing (>10MB per pool)
- Semantic search outperforms keyword/path filtering
- Real-time task-to-doc embedding similarity needed

**Recommendation:** Start with hybrid (hot preload + warm selective index + cold search), migrate to RAG for warm tier if/when it scales beyond 10MB.

---

### 2.4 Implementation Checklist

- [ ] **Phase 1:** Expose cold tier search via tool (`cold_search` tool definition)
- [ ] **Phase 1:** Add `contextHints` to task schema metadata
- [ ] **Phase 1:** Implement selective warm indexing (filter by hints + routing)
- [ ] **Phase 2:** Track retrieval patterns (which warm docs are actually used)
- [ ] **Phase 2:** Auto-generate context hints (learn from past task→doc patterns)
- [ ] **Phase 3:** Evaluate RAG for warm tier (if >10MB or poor recall quality)

---

## 3. Compaction Optimization

### 3.1 Current State

AOF relies on **OpenClaw's built-in compaction** (summarize + reinitiate). This is a black box from AOF's perspective — no control over what gets discarded or how to re-retrieve.

**Problem:** Compaction is lossy. If agent needs discarded context later, it has no path back to the source.

---

### 3.2 Proposed: Metadata-Driven Compaction Hints

**Design principle:** Task artifacts should include **compaction metadata** — explicit hints about what's safe to discard.

#### 3.2.1 Artifact Schema Extension

```typescript
interface TaskArtifact {
  path: string;                   // File path (e.g., "output.md")
  content: string;
  metadata: {
    compactionHint: CompactionHint;
    retrieval: RetrievalHint;
  };
}

interface CompactionHint {
  mode: "keep_full" | "summarize" | "discard_after_summary" | "ephemeral";
  priority: "critical" | "high" | "normal" | "low";
  summaryLength?: number;         // Target summary token count
  keyPoints?: string[];           // Must-preserve information
}

interface RetrievalHint {
  reloadable: boolean;            // Can be re-retrieved from source?
  sourcePath?: string;            // If reloadable, where to find it
  reconstructable?: boolean;      // Can be regenerated (e.g., derived data)?
  reconstructionCommand?: string; // How to regenerate
}
```

**Example:**

```typescript
// Agent creates an artifact with compaction hints
const designDoc: TaskArtifact = {
  path: "design/payment-refactor.md",
  content: "# Design: Payment Refactor\n\n...",
  metadata: {
    compactionHint: {
      mode: "summarize",
      priority: "high",
      summaryLength: 500,
      keyPoints: [
        "Selected strategy: Two-phase commit",
        "Rollback plan: Reverse idempotency key",
        "Timeline: 2 weeks"
      ]
    },
    retrieval: {
      reloadable: true,
      sourcePath: "design/payment-refactor.md",
      reconstructable: false
    }
  }
};
```

---

#### 3.2.2 Compaction Modes

| Mode | Description | When to Use | Example |
|------|-------------|-------------|---------|
| `keep_full` | Never compact | Critical decisions, contracts | USER.md, SAFETY.md |
| `summarize` | Keep key points only | Design docs, incident reports | Design proposals, post-mortems |
| `discard_after_summary` | One-time read, then drop | Logs, verbose output | CI logs, trace dumps |
| `ephemeral` | Discard immediately after use | Intermediate computation | Temp calculations, scaffolding |

---

#### 3.2.3 Re-Retrieval Protocol

When compacted context is needed again:

```typescript
interface CompactionLog {
  timestamp: string;
  artifactPath: string;
  originalSize: number;
  summarySize: number;
  discardedSize: number;
  retrievalHint: RetrievalHint;
}

async function retrieveCompacted(
  artifactPath: string,
  log: CompactionLog
): Promise<string> {
  // 1. Check if reloadable from source
  if (log.retrievalHint.reloadable && log.retrievalHint.sourcePath) {
    return await loadFile(log.retrievalHint.sourcePath);
  }
  
  // 2. Check if reconstructable
  if (log.retrievalHint.reconstructable && log.retrievalHint.reconstructionCommand) {
    return await exec(log.retrievalHint.reconstructionCommand);
  }
  
  // 3. Fallback: cold tier search
  return await searchColdTier({ path: artifactPath });
}
```

**Benefit:** Compaction becomes **lossy but recoverable** — agent can always get back to source.

---

#### 3.2.4 Tool Result Clearing (Low-Hanging Fruit)

Anthropic identifies tool result clearing as "low-hanging fruit" compaction. AOF should implement aggressive tool result pruning.

**Strategy:**

```typescript
interface ToolResultPolicy {
  clearAfter: "immediate" | "next_turn" | "task_complete" | "never";
  keepSummary: boolean;
  summaryLength?: number;
}

const toolPolicies: Record<string, ToolResultPolicy> = {
  // Ephemeral (clear immediately)
  "exec": { clearAfter: "immediate", keepSummary: false },
  "read": { clearAfter: "immediate", keepSummary: false },
  
  // Keep summary (useful for reasoning chains)
  "web_fetch": { clearAfter: "next_turn", keepSummary: true, summaryLength: 200 },
  "image": { clearAfter: "next_turn", keepSummary: true, summaryLength: 100 },
  
  // Keep full (critical for correctness)
  "write": { clearAfter: "task_complete", keepSummary: false },
  "edit": { clearAfter: "task_complete", keepSummary: false },
  
  // Never clear (audit trail)
  "message": { clearAfter: "never", keepSummary: false },
};

async function compactToolResults(
  history: ConversationTurn[]
): Promise<ConversationTurn[]> {
  return history.map(turn => {
    if (!turn.toolResults) return turn;
    
    turn.toolResults = turn.toolResults.map(result => {
      const policy = toolPolicies[result.toolName] ?? { clearAfter: "next_turn", keepSummary: true };
      
      if (shouldClear(policy, turn.timestamp)) {
        if (policy.keepSummary) {
          return {
            ...result,
            content: summarize(result.content, policy.summaryLength),
            compacted: true
          };
        } else {
          return {
            ...result,
            content: "[Cleared]",
            compacted: true
          };
        }
      }
      
      return result;
    });
    
    return turn;
  });
}
```

**Expected impact:** 30–50% reduction in context size for long-running tasks with frequent tool calls.

---

### 3.3 Integration with AOF Event Log

**Log compaction events for auditability:**

```typescript
interface CompactionEvent extends BaseEvent {
  type: "context.compacted";
  taskId: string;
  agentId: string;
  payload: {
    artifactPath: string;
    mode: CompactionHint["mode"];
    originalSize: number;
    compactedSize: number;
    retrievalHint: RetrievalHint;
  };
}
```

**Metrics:**
- Compaction ratio (original / compacted size)
- Re-retrieval frequency (how often agents reload compacted docs)
- Compaction-related errors (failed re-retrieval)

---

### 3.4 Implementation Roadmap

**Phase 1 (Immediate):**
- [ ] Implement tool result clearing policies (exec/read → clear immediately)
- [ ] Add `compactionHint` to task artifact schema
- [ ] Log compaction events to cold tier

**Phase 2 (Optimization):**
- [ ] Implement re-retrieval protocol (reload from source/cold tier)
- [ ] Add `aof context compact` command (manual compaction trigger)
- [ ] Track re-retrieval patterns (which docs need to be reloaded)

**Phase 3 (Automation):**
- [ ] Auto-generate compaction hints (learn from task patterns)
- [ ] Proactive compaction (trigger before hitting token limit)
- [ ] Adaptive compaction policies (tune based on task success rate)

---

## 4. Progressive Disclosure Protocol

### 4.1 Design Principle

Anthropic: "Agents should discover context incrementally. File sizes suggest complexity, naming conventions hint at purpose, timestamps proxy for relevance."

**AOF advantage:** Filesystem-as-API design already embodies this! Task cards are lightweight identifiers, artifacts are files, directory structure encodes status.

---

### 4.2 Task Card as Context Index

**Current state:** Task cards include full instructions + input artifacts in body.

**Problem:** Large task cards (10KB+) waste tokens if agent doesn't need all context upfront.

**Solution:** Split task card into **index** (lightweight metadata) + **artifacts** (lazy-loaded).

#### 4.2.1 Schema Evolution

```yaml
---
schemaVersion: 2  # New version
id: TASK-2026-02-07-042
title: Fix payment processor timeout
status: ready
priority: high
routing:
  role: swe-backend

# NEW: Artifact manifest (lazy-loadable)
artifacts:
  inputs:
    - path: "artifacts/incident-report.md"
      size: 8234
      description: "Incident report from 2026-02-05"
      optional: false
    - path: "artifacts/payment-logs.jsonl"
      size: 156789
      description: "Payment processor logs (last 7 days)"
      optional: true
    - path: "artifacts/stripe-api-docs.md"
      size: 45678
      description: "Stripe API reference"
      optional: true
  outputs:
    - path: "artifacts/fix-summary.md"
      required: true
    - path: "artifacts/test-results.md"
      required: true

metadata:
  contextHints: ["payment-processor", "stripe-integration"]
---

# Task Instructions (lightweight)

Fix timeout in payment processor integration.

**Acceptance criteria:**
- [ ] Timeout resolved
- [ ] Test coverage added
- [ ] Incident report closed

**Artifacts:**
- See `artifacts/incident-report.md` for context (8KB)
- Payment logs available in `artifacts/payment-logs.jsonl` (156KB) — load if needed
- Stripe API docs in `artifacts/stripe-api-docs.md` (45KB) — reference only
```

**Key change:** Body is lightweight (instructions + acceptance criteria). Large input docs moved to `artifacts/` with manifest.

---

#### 4.2.2 Lazy Loading Protocol

Agent receives task card with **manifest only** — full artifacts loaded on demand.

```typescript
// Initial context (lightweight)
const taskCard = await loadTaskCard("TASK-2026-02-07-042");
// → 2KB (frontmatter + instructions only)

// Agent reasoning:
// "I need the incident report to understand the failure."

// Lazy load artifact
const incidentReport = await loadArtifact(
  taskCard.frontmatter.artifacts.inputs[0].path
);
// → 8KB loaded into context

// Agent reasoning:
// "I should check the payment logs for specific error patterns."

// Lazy load large artifact
const paymentLogs = await loadArtifact(
  taskCard.frontmatter.artifacts.inputs[1].path
);
// → 156KB loaded (but agent can grep/search instead of loading full content)
```

**Benefit:** Agent controls attention budget — only loads what it needs.

---

#### 4.2.3 Artifact Discovery Tools

Provide tools for **exploring** task context:

```typescript
// Tool: list task artifacts
interface ListArtifactsTool {
  name: "list_artifacts";
  description: "List input/output artifacts for current task";
  parameters: {
    type?: "inputs" | "outputs" | "all";
  };
  returns: {
    artifacts: Array<{
      path: string;
      size: number;
      description: string;
      optional: boolean;
    }>;
  };
}

// Tool: load artifact (selective)
interface LoadArtifactTool {
  name: "load_artifact";
  description: "Load a task artifact into context";
  parameters: {
    path: string;
    mode?: "full" | "summary" | "grep";
    grepPattern?: string;  // If mode=grep
  };
}

// Example agent interaction:
// 1. Agent spawned with task card (2KB)
// 2. Agent: list_artifacts() → sees 3 input artifacts
// 3. Agent: load_artifact("incident-report.md", mode="summary") → 500 tokens
// 4. Agent: load_artifact("payment-logs.jsonl", mode="grep", pattern="timeout") → 20 matching lines
```

**Key insight:** Agent discovers context **incrementally** via tool exploration (Anthropic principle #4).

---

### 4.3 Directory Structure as Navigation

AOF's filesystem-as-API design already provides **progressive disclosure via directory structure**:

```
tasks/
├── backlog/       # Not yet triaged → agent can ignore
├── ready/         # Agent's queue → high relevance
├── in-progress/   # Active work → highest relevance
├── blocked/       # Waiting → low relevance
├── review/        # Awaiting feedback → medium relevance
└── done/          # Completed → archive (cold tier)

agents/
├── swe-backend/
│   ├── inbox/     # New tasks → high relevance
│   ├── processing/# Active → highest relevance
│   └── outbox/    # Completed → low relevance
```

**Progressive disclosure strategy:**
1. **Initial context:** Only `inbox/` + current task
2. **On-demand:** Agent can list `ready/` if looking for related tasks
3. **Cold search:** Agent can grep `done/` for historical patterns

**Recommendation:** Expose directory traversal as **navigable context** (not pre-loaded blob).

```typescript
// Tool: list directory (exploration)
interface ListDirTool {
  name: "list_tasks";
  description: "List tasks in a directory (by status)";
  parameters: {
    status: TaskStatus;
    limit?: number;
  };
}

// Agent: "Are there other payment-related tasks?"
// Tool call: list_tasks(status="ready", limit=10)
// Result: [3 tasks found] → agent can load_task_card() selectively
```

---

### 4.4 Naming Conventions as Hints

AOF task IDs already encode temporal information: `TASK-2026-02-07-042`.

**Enhance with semantic prefixes:**

```typescript
// Proposed naming convention
const taskIdPattern = /^(TASK|BUG|FEAT|CHORE|INCIDENT)-\d{4}-\d{2}-\d{2}-\d{3}$/;

// Examples:
"BUG-2026-02-07-001"      // Bug fix (high relevance to qa/backend)
"FEAT-2026-02-07-002"     // Feature work (high relevance to pm/frontend)
"INCIDENT-2026-02-05-001" // Incident response (high relevance to ops)
"CHORE-2026-02-07-003"    // Maintenance (low priority)
```

**Benefit:** Agent can **filter by prefix** when searching for related tasks.

---

### 4.5 Implementation Roadmap

**Phase 1 (Foundation):**
- [ ] Add `artifacts` section to task schema v2
- [ ] Implement artifact manifest generation (split large bodies into files)
- [ ] Add `list_artifacts` and `load_artifact` tools

**Phase 2 (Discovery):**
- [ ] Add `list_tasks` tool (directory exploration)
- [ ] Implement semantic task ID prefixes (BUG/FEAT/INCIDENT)
- [ ] Add artifact search tool (grep across artifacts)

**Phase 3 (Optimization):**
- [ ] Track which artifacts are actually loaded (prune unused optional artifacts)
- [ ] Auto-generate artifact summaries (for mode="summary")
- [ ] Recommend artifact loading order (based on historical patterns)

---

## 5. Memory Tier Optimization

### 5.1 Current Medallion Design

AOF's medallion pipeline (cold → warm → hot) is primarily **size-based**:
- **Cold:** Unlimited, never indexed
- **Warm:** Target <100KB per doc, indexed per team
- **Hot:** <50KB total, always indexed

**Question:** Is size the right optimization metric?

---

### 5.2 Proposed: Signal Density as Primary Metric

**Thesis:** **Signal density** (relevance per token) matters more than raw size.

A 10KB doc with 90% signal (9KB useful) is **more valuable** than a 5KB doc with 20% signal (1KB useful).

#### 5.2.1 Tier Redefinition

| Tier | Criterion | Size Limit | Signal Density | Promotion Rule |
|------|-----------|------------|----------------|----------------|
| **Hot** | Canonical, stable | <50KB total | >0.90 | Manual review + stability (unchanged for 30d) |
| **Warm** | Operational, fresh | <100KB per doc | >0.70 | Automated (daily aggregation) |
| **Cold** | Archival, raw | Unlimited | N/A (not scored) | Write-only (no promotion) |

**Key change:** Promotion driven by **signal density threshold**, not just size/age.

---

#### 5.2.2 Signal Density Measurement

Extend the scoring formula from Section 1:

```typescript
async function measureSignalDensity(
  doc: string,
  context: "hot" | "warm"
): Promise<number> {
  // 1. Structure score (well-formatted Markdown)
  const structureScore = scoreStructure(doc);
  
  // 2. Information density (non-redundant content)
  const densityScore = scoreInformationDensity(doc);
  
  // 3. Empirical retrieval (how often agents use this doc)
  const retrievalScore = await getRetrievalFrequency(doc);
  
  // 4. Task success correlation (does including this doc improve outcomes?)
  const effectivenessScore = await getEffectivenessScore(doc);
  
  return (
    structureScore * 0.2 +
    densityScore * 0.3 +
    retrievalScore * 0.3 +
    effectivenessScore * 0.2
  );
}

function scoreStructure(doc: string): number {
  // Heuristics:
  // - Has headers? +0.3
  // - Has code blocks? +0.2
  // - Has lists? +0.2
  // - Has tables? +0.2
  // - Low whitespace ratio? +0.1
  // Max score: 1.0
}

function scoreInformationDensity(doc: string): number {
  // Heuristics:
  // - Unique word ratio (vs corpus)
  // - Low repetition (no wall-of-text logs)
  // - High technical term density
}

async function getRetrievalFrequency(doc: string): Promise<number> {
  // Query cold tier logs for how often this doc appears in retrieval results
  const logs = await searchColdTier({ query: `retrieved:${doc}` });
  const frequency = logs.length / totalRetrievalEvents;
  return Math.min(frequency * 10, 1.0); // Normalize to 0-1
}

async function getEffectivenessScore(doc: string): Promise<number> {
  // Correlate doc inclusion with task success rate
  const tasksWithDoc = await getTasksRetrievingDoc(doc);
  const successRate = tasksWithDoc.filter(t => t.status === "done").length / tasksWithDoc.length;
  const baseline = await getBaselineSuccessRate();
  return Math.min((successRate - baseline) / baseline, 1.0); // Lift over baseline
}
```

**Insight:** Effectiveness score is **empirical** — measures actual impact on task outcomes.

---

#### 5.2.3 Promotion/Demotion Driven by Signal Density

```typescript
interface TierTransitionRule {
  from: "cold" | "warm" | "hot";
  to: "cold" | "warm" | "hot";
  condition: (doc: Document, metrics: DocumentMetrics) => boolean;
}

const promotionRules: TierTransitionRule[] = [
  {
    from: "warm",
    to: "hot",
    condition: (doc, metrics) =>
      metrics.signalDensity > 0.90 &&
      metrics.stability > 30 && // days unchanged
      metrics.retrievalFrequency > 0.5 &&
      metrics.effectiveness > 0.2
  },
  {
    from: "cold",
    to: "warm",
    condition: (doc, metrics) =>
      metrics.signalDensity > 0.70 &&
      metrics.recency < 7 && // days old
      metrics.retrievalFrequency > 0.1
  }
];

const demotionRules: TierTransitionRule[] = [
  {
    from: "hot",
    to: "warm",
    condition: (doc, metrics) =>
      metrics.signalDensity < 0.80 || // Degraded quality
      metrics.retrievalFrequency < 0.3 || // Rarely used
      metrics.staleness > 90 // Outdated
  },
  {
    from: "warm",
    to: "cold",
    condition: (doc, metrics) =>
      metrics.signalDensity < 0.50 ||
      metrics.retrievalFrequency < 0.05 ||
      metrics.staleness > 180
  }
];
```

**Key insight:** Demotion is **automatic** based on empirical usage, not manual review.

---

#### 5.2.4 Metrics Dashboard

```bash
aof memory tiers --report

Memory Tier Health Report
==========================
Hot Tier
  Total size: 42.3 KB / 50 KB (85% capacity)
  Docs: 4
  Avg signal density: 0.92 ✅
  Avg retrieval frequency: 0.68 ✅
  Candidates for demotion: 0

Warm Tier
  Total size: 2.1 MB
  Docs: 23
  Avg signal density: 0.74 ✅
  Avg retrieval frequency: 0.31 🟡
  Candidates for promotion: 2
    - runbooks/deploy-backend.md (density: 0.94, freq: 0.78)
    - decisions/2026-02-ADR-003.md (density: 0.91, freq: 0.52)
  Candidates for demotion: 3
    - status/2026-01-week4-status.md (density: 0.48, stale: 45d)

Cold Tier
  Total size: 456 MB
  Events: 125,432
  Growth rate: 8 MB/day
  Retention policy: compress after 90d, delete after 1y
```

---

### 5.3 Implementation Roadmap

**Phase 1 (Measurement):**
- [ ] Implement signal density scoring (structure + density + retrieval)
- [ ] Track retrieval frequency in cold logs
- [ ] Add `aof memory tiers --report` command

**Phase 2 (Optimization):**
- [ ] Implement effectiveness scoring (task success correlation)
- [ ] Add automated promotion/demotion rules
- [ ] A/B test signal density thresholds (optimize for task success)

**Phase 3 (Automation):**
- [ ] Auto-prune low-signal warm docs (move to cold)
- [ ] Auto-promote high-signal warm docs (with review gate)
- [ ] Continuous optimization (tune thresholds based on metrics)

---

## 6. Evolutionary Architecture

### 6.1 Design Principles

**Core thesis:** Context engineering is **evolving research** — AOF must evolve with it.

Requirements:
1. **Pluggable strategies:** Swap curation algorithms without rewriting core
2. **Measurable metrics:** Quantify context quality (not just size)
3. **A/B testing:** Compare strategies empirically (task success rate, cost, latency)
4. **Backward compatibility:** New strategies don't break existing tasks
5. **Gradual rollout:** Test strategies on subset before global deployment

---

### 6.2 Strategy Plugin Architecture

#### 6.2.1 Interface Definition

```typescript
interface ContextCurationStrategy {
  id: string;
  version: string;
  description: string;
  
  // Core methods
  curate(context: RawContext): Promise<CuratedContext>;
  compact(context: CuratedContext): Promise<CompactedContext>;
  estimate(task: Task): Promise<ContextBudget>;
  
  // Metadata
  capabilities: string[];
  configSchema: JSONSchema;
  metrics: MetricDefinition[];
}

interface RawContext {
  systemPrompt: string;
  tools: ToolDefinition[];
  taskCard: Task;
  memoryHot: string[];
  memoryWarm: string[];
  memoryCold: string[]; // Paths, not content
  history: ConversationTurn[];
}

interface CuratedContext extends RawContext {
  budget: ContextBudget;
  pruned: string[]; // What was removed
  metadata: Record<string, unknown>;
}

interface CompactedContext extends CuratedContext {
  compactionLog: CompactionLog[];
  recoveryHints: RetrievalHint[];
}
```

---

#### 6.2.2 Strategy Registry

```typescript
class ContextStrategyRegistry {
  private strategies: Map<string, ContextCurationStrategy>;
  
  register(strategy: ContextCurationStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }
  
  get(id: string): ContextCurationStrategy {
    return this.strategies.get(id) ?? defaultStrategy;
  }
  
  list(): ContextCurationStrategy[] {
    return Array.from(this.strategies.values());
  }
}

// Global registry
export const contextStrategies = new ContextStrategyRegistry();

// Register built-in strategies
contextStrategies.register(heuristicStrategy);
contextStrategies.register(signalDensityStrategy);
contextStrategies.register(llmSummarizationStrategy);
```

---

#### 6.2.3 Strategy Selection

Per-agent or per-task strategy selection:

```yaml
# Org chart: default strategy per agent
agents:
  - id: swe-backend
    contextStrategy: signal-density-v1
  - id: swe-qa
    contextStrategy: heuristic-v1

# Task override: specific strategy for high-priority tasks
---
id: TASK-2026-02-07-042
priority: critical
metadata:
  contextStrategy: llm-summarization-v1  # Override default
---
```

---

#### 6.2.4 Built-in Strategies

**Strategy 1: Heuristic (v1, baseline)**
```typescript
const heuristicStrategy: ContextCurationStrategy = {
  id: "heuristic-v1",
  version: "1.0.0",
  description: "Simple rule-based curation (size limits only)",
  
  async curate(context: RawContext): Promise<CuratedContext> {
    // Simple rules: keep hot, prune old history, no warm filtering
    const pruned: string[] = [];
    
    if (context.history.length > 10) {
      pruned.push(`history:${context.history.length - 10} old turns`);
      context.history = context.history.slice(-10);
    }
    
    return { ...context, pruned, budget: estimateBudget(context), metadata: {} };
  },
  
  capabilities: ["basic"],
  configSchema: {},
  metrics: [{ name: "context_size", unit: "tokens" }]
};
```

**Strategy 2: Signal Density (v1, recommended)**
```typescript
const signalDensityStrategy: ContextCurationStrategy = {
  id: "signal-density-v1",
  version: "1.0.0",
  description: "Quality-weighted curation (signal density scoring)",
  
  async curate(context: RawContext): Promise<CuratedContext> {
    // Score all components by signal density
    const scored = await scoreComponents(context);
    
    // Prune low-signal components below threshold
    const threshold = 0.5; // Configurable
    const pruned = scored
      .filter(c => c.signalDensity < threshold)
      .map(c => c.id);
    
    // Rebuild context without pruned components
    const curated = removeComponents(context, pruned);
    
    return {
      ...curated,
      pruned,
      budget: estimateBudget(curated),
      metadata: { signalDensityThreshold: threshold }
    };
  },
  
  capabilities: ["signal_scoring", "adaptive_pruning"],
  configSchema: {
    type: "object",
    properties: {
      signalDensityThreshold: { type: "number", default: 0.5 }
    }
  },
  metrics: [
    { name: "avg_signal_density", unit: "ratio" },
    { name: "pruned_components", unit: "count" }
  ]
};
```

**Strategy 3: LLM Summarization (v2, future)**
```typescript
const llmSummarizationStrategy: ContextCurationStrategy = {
  id: "llm-summarization-v1",
  version: "1.0.0",
  description: "LLM-based context summarization",
  
  async curate(context: RawContext): Promise<CuratedContext> {
    // Use small/fast model to summarize long docs
    const summaries = await Promise.all(
      context.memoryWarm.map(doc => summarizeWithLLM(doc))
    );
    
    context.memoryWarm = summaries;
    
    return {
      ...context,
      pruned: ["warm_docs:summarized"],
      budget: estimateBudget(context),
      metadata: { summaryModel: "claude-haiku" }
    };
  },
  
  capabilities: ["llm_summarization"],
  configSchema: {
    type: "object",
    properties: {
      summaryModel: { type: "string", default: "claude-haiku" },
      targetSummaryLength: { type: "number", default: 500 }
    }
  },
  metrics: [
    { name: "summary_compression_ratio", unit: "ratio" },
    { name: "summary_cost", unit: "usd" }
  ]
};
```

---

### 6.3 Measurable Metrics Framework

Define **context quality metrics** (not just size):

```typescript
interface ContextQualityMetrics {
  // Size metrics (basic)
  totalTokens: number;
  effectiveTokens: number; // Quality-weighted
  
  // Signal metrics (advanced)
  avgSignalDensity: number;
  signalEntropy: number; // Information diversity
  redundancyRatio: number; // Duplicate/overlapping content
  
  // Relevance metrics (task-specific)
  taskRelevanceScore: number; // How relevant to current task
  retrievalPrecision: number; // % of context actually used
  retrievalRecall: number; // % of needed context present
  
  // Efficiency metrics (outcome-based)
  tokenEfficiency: number; // Task success / tokens consumed
  costEfficiency: number; // Task success / API cost
  timeEfficiency: number; // Task success / wall-clock time
  
  // Compaction metrics
  compactionRatio: number; // Original / compacted size
  reRetrievalRate: number; // % of compacted items reloaded
}

interface ContextStrategyBenchmark {
  strategyId: string;
  taskCount: number;
  metrics: {
    avg: ContextQualityMetrics;
    p50: ContextQualityMetrics;
    p95: ContextQualityMetrics;
  };
  taskSuccessRate: number;
  avgCostPerTask: number;
  avgDurationPerTask: number;
}
```

**Visualization:**

```bash
aof context strategies --benchmark

Context Strategy Benchmark
===========================
Period: 2026-02-01 to 2026-02-07 (7 days)
Tasks: 127

Strategy: heuristic-v1 (baseline)
  Success rate: 87.3%
  Avg tokens: 124,567
  Avg signal density: 0.62
  Avg cost: $0.42/task
  Avg duration: 4.2 min

Strategy: signal-density-v1 (candidate)
  Success rate: 89.1% (+1.8pp ✅)
  Avg tokens: 87,234 (-30% ✅)
  Avg signal density: 0.78 (+26% ✅)
  Avg cost: $0.28/task (-33% ✅)
  Avg duration: 3.8 min (-10% ✅)

Recommendation: Promote signal-density-v1 to default ✅
```

---

### 6.4 A/B Testing Framework

#### 6.4.1 Test Configuration

```yaml
# experiments/context-strategy-ab-test.yaml
experiment:
  id: signal-density-rollout
  type: ab_test
  startDate: 2026-02-07
  endDate: 2026-02-14
  hypothesis: "Signal density strategy reduces tokens by 30% with no degradation in success rate"
  
  variants:
    - id: control
      strategy: heuristic-v1
      allocation: 0.5  # 50% of tasks
    
    - id: treatment
      strategy: signal-density-v1
      allocation: 0.5  # 50% of tasks
  
  successMetrics:
    primary: task_success_rate
    secondary:
      - avg_token_consumption
      - avg_task_duration
      - avg_cost_per_task
  
  stopConditions:
    - metric: task_success_rate
      threshold: -0.05  # Stop if success rate drops >5pp
    - metric: avg_cost_per_task
      threshold: +0.20  # Stop if cost increases >20%
```

---

#### 6.4.2 Runtime Allocation

```typescript
async function assignStrategy(task: Task): Promise<ContextCurationStrategy> {
  // Check for explicit override
  if (task.frontmatter.metadata.contextStrategy) {
    return contextStrategies.get(task.frontmatter.metadata.contextStrategy);
  }
  
  // Check for active experiments
  const experiment = await getActiveExperiment("context-strategy");
  if (experiment) {
    const variant = allocateVariant(experiment, task);
    logExperimentAllocation(experiment.id, task.frontmatter.id, variant);
    return contextStrategies.get(variant.strategy);
  }
  
  // Default: org chart strategy or global default
  const agent = await getAgent(task.frontmatter.routing.role);
  return contextStrategies.get(agent.contextStrategy ?? "heuristic-v1");
}
```

---

#### 6.4.3 Results Analysis

```bash
aof experiments report signal-density-rollout

A/B Test Results: signal-density-rollout
=========================================
Period: 2026-02-07 to 2026-02-14 (7 days)
Tasks: 256 (128 control, 128 treatment)

Primary metric: task_success_rate
  Control: 87.5% (112/128)
  Treatment: 89.8% (115/128)
  Delta: +2.3pp (p=0.12, not significant)

Secondary metrics:
  avg_token_consumption
    Control: 126,453
    Treatment: 88,721
    Delta: -29.8% (p<0.01, significant ✅)
  
  avg_task_duration
    Control: 4.3 min
    Treatment: 3.9 min
    Delta: -9.3% (p=0.08, marginally significant)
  
  avg_cost_per_task
    Control: $0.43
    Treatment: $0.29
    Delta: -32.6% (p<0.01, significant ✅)

Stop conditions: None triggered

Recommendation: Promote treatment to 100% ✅
  - Success rate not degraded (slight improvement)
  - Token consumption -30% (hypothesis confirmed)
  - Cost savings: $0.14/task × 1000 tasks/month = $140/month
```

---

### 6.5 Backward Compatibility & Migration

**Principle:** New strategies must not break existing tasks.

```typescript
interface StrategyMigration {
  fromStrategy: string;
  toStrategy: string;
  migrationFn: (context: CuratedContext) => Promise<CuratedContext>;
  rollbackFn: (context: CuratedContext) => Promise<CuratedContext>;
}

const migrations: StrategyMigration[] = [
  {
    fromStrategy: "heuristic-v1",
    toStrategy: "signal-density-v1",
    migrationFn: async (context) => {
      // Re-score context with signal density
      return signalDensityStrategy.curate(context);
    },
    rollbackFn: async (context) => {
      // Restore original context (no pruning)
      return heuristicStrategy.curate(context);
    }
  }
];
```

**Rollout plan:**
1. **Week 1:** Deploy signal-density-v1 as opt-in (task metadata override)
2. **Week 2:** A/B test 50/50 split (validate no degradation)
3. **Week 3:** Gradual rollout to 100% (monitor for regressions)
4. **Week 4:** Retire heuristic-v1 (keep as fallback for 1 month)

---

### 6.6 Implementation Roadmap

**Phase 1 (Foundation):**
- [ ] Define `ContextCurationStrategy` interface
- [ ] Implement strategy registry
- [ ] Add strategy selection logic (org chart + task override)
- [ ] Migrate existing logic to `heuristic-v1` strategy

**Phase 2 (Measurement):**
- [ ] Define `ContextQualityMetrics` schema
- [ ] Implement metric collection in event logger
- [ ] Add `aof context strategies --benchmark` command

**Phase 3 (Experimentation):**
- [ ] Implement A/B testing framework
- [ ] Add experiment configuration (YAML)
- [ ] Add `aof experiments` CLI commands (start/stop/report)

**Phase 4 (Optimization):**
- [ ] Implement `signal-density-v1` strategy
- [ ] Run A/B test (validate 30% token reduction)
- [ ] Promote to default strategy (gradual rollout)

**Phase 5 (Advanced):**
- [ ] Implement `llm-summarization-v1` strategy (v2)
- [ ] Add learned relevance models (embeddings + classifiers)
- [ ] Continuous optimization (auto-tune thresholds)

---

## 7. Summary & Prioritized Recommendations

### 7.1 Implementation Priority Matrix

| Recommendation | Impact | Effort | Priority | Timeline | Article Source |
|----------------|--------|--------|----------|----------|----------------|
| **Tool result clearing** | High | Low | 🔴 P0 | Week 1 | Anthropic |
| **Decision mode tracking** | High | Low | 🔴 P0 | Week 1 | Fowler |
| **Task card artifact manifest** | High | Medium | 🔴 P0 | Week 2-3 | Anthropic + Fowler |
| **Compaction hints schema** | High | Low | 🟠 P1 | Week 2 | Anthropic |
| **Context budget tracking** | Medium | Low | 🟠 P1 | Week 2 | Anthropic |
| **Context transparency dashboard** | High | Low | 🟠 P1 | Week 2 | Fowler |
| **Skills manifest + lazy loading** | High | Medium | 🟠 P1 | Week 3-4 | Fowler |
| **Signal density scoring (heuristic)** | High | Medium | 🟠 P1 | Week 3-4 | Anthropic |
| **Hybrid retrieval (warm selective indexing)** | High | Medium | 🟠 P1 | Week 3-4 | Anthropic |
| **Autonomy-based budget allocation** | Medium | Medium | 🟡 P2 | Week 5-6 | Fowler |
| **Strategy plugin architecture** | Medium | High | 🟡 P2 | Week 5-6 | Anthropic |
| **A/B testing framework** | Medium | High | 🟡 P2 | Week 6-7 | Anthropic |
| **Metrics dashboard** | Low | Medium | 🟡 P2 | Week 7-8 | Anthropic |
| **MCP server integration** | High | High | 🟢 P3 | Month 3+ | Fowler |
| **LLM summarization strategy** | High | High | 🟢 P3 | Month 3+ | Anthropic |

---

### 7.2 Quick Wins (Weeks 1-2)

**Immediate actions with high ROI:**

1. **Tool result clearing policies** (Section 3.2.4, Anthropic)
   - Implementation: 1 day
   - Expected impact: 30-50% context reduction for tool-heavy tasks
   - Risk: None (clearing exec/read results is safe)

2. **Decision mode tracking** (Section 0.2, Fowler)
   - Implementation: 1 day
   - Expected impact: Visibility into autonomous vs manual vs deterministic context loading
   - Risk: None (telemetry only)
   - Deliverable: `aof context decisions` command

3. **Context transparency dashboard** (Section 0.6, Fowler)
   - Implementation: 2 days
   - Expected impact: Real-time budget visibility, per-component attribution
   - Risk: None (reporting only)
   - Deliverable: `aof context status` command

4. **Compaction hints schema** (Section 3.2.1, Anthropic)
   - Implementation: 2 days
   - Expected impact: Better compaction quality, re-retrieval paths
   - Risk: Schema migration (backward compatible)

5. **Context budget event logging** (Section 1.2.4, Anthropic)
   - Implementation: 1 day
   - Expected impact: Baseline measurement for optimization
   - Risk: None (telemetry only)

6. **Task card artifact manifest** (Section 4.2.1, Anthropic + Fowler)
   - Implementation: 3-5 days
   - Expected impact: Lazy loading, progressive disclosure
   - Risk: Schema migration (v2, opt-in initially)

**Expected combined impact:** 40-60% token reduction + critical visibility into context usage patterns.

---

### 7.3 Medium-Term Optimization (Weeks 3-8)

**Strategic improvements with measurable ROI:**

1. **Skills pattern implementation** (Section 0.4, Fowler)
   - Add skill manifest frontmatter to warm docs
   - Implement `list_skills` and `load_skill` tools
   - Convert warm tier from preloaded → lazy-loaded
   - Expected impact: 40-60% reduction in warm tier token waste

2. **Signal density scoring** (Section 1.2.2, Anthropic)
   - Heuristic formula (v1) → 20% better curation
   - Measure retrieval frequency, structure, density
   - A/B test threshold tuning

3. **Hybrid retrieval strategy** (Section 2.2, Anthropic)
   - Hot preload + warm selective indexing + cold search
   - Context hints in task metadata
   - Expected impact: 30% reduction in irrelevant context

4. **Autonomy-based budget allocation** (Section 1.2.3, Fowler)
   - Allocate budget based on task autonomy level
   - High autonomy → more reserve for LLM-decided context
   - Low autonomy → more predetermined context

5. **Memory tier signal density** (Section 5.2, Anthropic)
   - Promotion/demotion based on empirical usage
   - Track effectiveness (task success correlation)
   - Automated warm→hot promotion (with review gate)

6. **Strategy plugin architecture** (Section 6.2, Anthropic)
   - Enable experimentation without core changes
   - A/B testing framework for empirical validation
   - Gradual rollout of new strategies

**Expected combined impact:** 70-85% overall token efficiency improvement (Skills alone: 40-60%).

---

### 7.4 Long-Term Research (Month 3+)

**Advanced techniques as research evolves:**

1. **LLM-based summarization** (Section 6.2.4)
   - Use fast models (Haiku) for warm tier summarization
   - Trade-off: summarization cost vs context cost
   - Only worth it if warm docs >10MB

2. **Learned relevance models** (Section 1.2.2)
   - Train embedding-based relevance scoring
   - Replace heuristics with learned model
   - Requires: 1000+ tasks for training data

3. **Real-time attention tracking** (Section 1.2.1)
   - If OpenClaw exposes attention weights → prune unused context
   - Highest potential impact (direct empirical signal)
   - Depends on upstream OpenClaw instrumentation

4. **Context federation** (Future)
   - Multi-agent context sharing (sub-agents reuse parent context)
   - Distributed context caching (warm tier as shared cache)
   - Requires: distributed coordination layer

---

### 7.5 Success Metrics (30/60/90 Day Goals)

**30 days (baseline + quick wins):**
- [ ] Token consumption baseline established (1 week measurement)
- [ ] Tool result clearing deployed (30-50% reduction in tool-heavy tasks)
- [ ] Task card artifact manifest v2 schema finalized
- [ ] Context budget tracking instrumented

**60 days (optimization deployed):**
- [ ] Signal density scoring deployed (20% better curation)
- [ ] Hybrid retrieval strategy deployed (30% less irrelevant context)
- [ ] A/B test results: signal-density-v1 vs heuristic-v1
- [ ] Overall token reduction: 40-60% (vs baseline)

**90 days (evolutionary architecture):**
- [ ] Strategy plugin architecture deployed
- [ ] 2+ strategies in production (heuristic, signal-density)
- [ ] Memory tier promotion/demotion automated
- [ ] Overall token reduction: 60-80% (vs baseline)
- [ ] Task success rate maintained or improved

---

## 8. Conclusion

This analysis synthesizes **two complementary perspectives** on context engineering:

1. **Anthropic** — Theoretical foundations (attention budget, context rot, compaction, progressive disclosure)
2. **Fowler/Thoughtworks** — Practical patterns (Skills, decision modes, context transparency, probabilistic thinking)

### 8.1 AOF's Alignment with Research

AOF's **filesystem-as-API design and medallion pipeline** are **fundamentally aligned** with both frameworks:

#### Anthropic Principles
✅ **Just-in-time loading:** Task artifacts, directory traversal, cold tier search  
✅ **Progressive disclosure:** Task card as context index, lazy artifact loading  
✅ **Compaction:** Medallion tiers, tool result clearing  
✅ **Hybrid strategy:** Hot preload + warm indexed + cold search  

#### Fowler Patterns
✅ **Skills pattern:** Warm tier maps to lazy-loaded context bundles  
✅ **Decision modes:** AOF supports deterministic (Memory V2), autonomous (tools), manual (task hints)  
✅ **Context transparency:** Event logging + metrics foundation already exists  
✅ **Claude Code stack:** Hot tier = CLAUDE.md, warm = Rules/Skills, cold = archival  

### 8.2 Critical Gaps Identified

**From Fowler analysis:**
1. **Skills not lazy-loaded** — Warm tier is preloaded; should be opt-in with manifest
2. **Decision mode tracking absent** — No visibility into autonomous vs manual vs deterministic
3. **Context transparency incomplete** — No real-time budget dashboard (`aof context status`)
4. **Probabilistic thinking missing** — Rigid enforcement over graceful degradation

**From Anthropic analysis:**
5. **Signal density not measured** — Size-based tiers, not quality-based
6. **Tool result clearing not implemented** — Low-hanging fruit (30-50% savings)
7. **Compaction hints absent** — No re-retrieval paths for compacted context
8. **Budget tracking instrumentation** — Token counting exists but not per-component attribution

### 8.3 The Opportunity

**Make the implicit explicit.** AOF already does many things right — now **instrument, measure, and iteratively optimize**.

**Three transformative changes:**

1. **Skills pattern** (Fowler, P1) — Convert warm tier from preloaded → lazy-loaded
   - Expected impact: **40-60% reduction in warm tier waste**
   - Implementation: 1 week (skill manifest + tools)

2. **Tool result clearing** (Anthropic, P0) — Aggressive pruning of ephemeral tool results
   - Expected impact: **30-50% reduction in tool-heavy tasks**
   - Implementation: 1 day (policy table)

3. **Context transparency** (Fowler, P0) — Real-time budget dashboard + decision mode tracking
   - Expected impact: **Critical visibility for optimization**
   - Implementation: 2 days (reporting commands)

**Combined impact: 70-85% token efficiency improvement** (vs current baseline).

### 8.4 Implementation Philosophy

1. **Start simple** — Heuristic rules (v1) before learned models (v2+)
2. **Measure everything** — Token accounting + signal density + decision modes
3. **Think probabilistically** — Graceful degradation over rigid enforcement (Fowler principle)
4. **Build up gradually** — Phase 1 (simple) → Phase 2 (optimize) → Phase 3 (autonomous)
5. **Iterate empirically** — A/B testing for strategy validation

### 8.5 Research Evolution Strategy

Context engineering is **evolving research** — AOF must evolve with it.

**Evolutionary architecture (Section 6):**
- **Plugin pattern** for curation strategies
- **A/B testing framework** for empirical validation
- **Backward compatibility** for safe migration
- **Gradual rollout** (opt-in → 50% → 100%)

**As research advances:**
- Anthropic publishes new techniques → new strategy plugin
- Fowler identifies new patterns → integrate via plugin
- AOF validates via A/B test → promote to default if successful

### 8.6 Success Metrics (Integrated)

**30 days (baseline + quick wins):**
- [ ] Token consumption baseline (Anthropic)
- [ ] Decision mode tracking deployed (Fowler)
- [ ] Tool result clearing deployed (Anthropic): 30-50% reduction
- [ ] Context transparency dashboard (Fowler)
- [ ] Task card artifact manifest v2 (both)

**60 days (optimization):**
- [ ] Skills pattern deployed (Fowler): 40-60% warm tier savings
- [ ] Signal density scoring (Anthropic): 20% better curation
- [ ] Hybrid retrieval (Anthropic): 30% less irrelevant context
- [ ] Overall reduction: **60-75%** (vs baseline)

**90 days (evolutionary):**
- [ ] Strategy plugins (Anthropic)
- [ ] Autonomy-based allocation (Fowler)
- [ ] MCP integration planning (Fowler)
- [ ] Overall reduction: **70-85%** (vs baseline)
- [ ] Task success rate maintained or improved

### 8.7 Next Steps

**Immediate (this week):**
1. Review this analysis with **swe-architect** (integration approval)
2. Prioritize **P0 quick wins** (tool clearing, decision tracking, transparency)
3. Baseline measurement (1 week token tracking before changes)

**Week 2-3:**
4. Implement **Skills pattern** (biggest single impact: 40-60%)
5. Deploy **context transparency dashboard** (`aof context status`)
6. Schema migration (artifact manifest v2)

**Week 4+:**
7. A/B test Skills pattern (validate savings)
8. Implement signal density scoring (Anthropic)
9. Iterate based on empirical data

---

## 8.8 Final Recommendation

**Approve for implementation.** This analysis provides:

✅ **Unified framework** — Synthesizes Anthropic (theory) + Fowler (practice)  
✅ **Concrete designs** — TypeScript interfaces, CLI commands, tool definitions  
✅ **Clear priorities** — P0 (quick wins) → P1 (optimization) → P2 (architecture) → P3 (research)  
✅ **Measurable outcomes** — 70-85% token efficiency within 90 days  
✅ **Evolutionary path** — Plugin architecture enables continuous improvement  

**The Skills pattern alone justifies immediate action** — 40-60% warm tier savings for ~1 week of implementation effort.

**Next action:** Demerzel/swe-architect review → prioritize P0 items → begin baseline measurement.

---

**End of analysis.**
