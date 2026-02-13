# Pulse Vision - Sprint Operating Framework

**Version:** 2.0 (Semantic Phases)  
**Status:** Active  
**Scope:** Sprint planning and execution for agent teams

## Overview

Pulse Vision defines how agent teams organize sprints and deliver value. It builds on the Software Development Lifecycle (SDLC.md) phases and emphasizes semantic guidance over prescriptive processes.

## Sprint Structure

### Pre-Sprint: Environment Readiness

**Reference:** SDLC.md Phase 0

Before starting a sprint, the Architect verifies the development environment supports all practices required by the project. This is not a checklist—it's a semantic requirement to ensure prerequisites exist.

**Key Questions:**
- Does the project have version control initialized?
- Does the test framework work?
- Is task tracking initialized?
- Are build and CI pipelines functional?

**Outcome:** Environment is complete and ready. No gaps exist that would block development.

---

### Sprint Phase 1: Planning & Design

**Reference:** SDLC.md Phase 1

The Architect translates project goals into implementable work:
- Review requirements and define architecture
- Decompose work into task briefs
- Create task records with dependencies in Beads
- Define acceptance criteria for each task

**Outcome:** Task graph exists with clear acceptance criteria. Specialists know what to build.

---

### Sprint Phase 2: Implementation

**Reference:** SDLC.md Phase 2

Specialists claim tasks from the ready queue and implement according to task briefs:
- Work on unblocked tasks (use `bd ready --json`)
- Claim task before starting (`bd update --claim`)
- Implement according to acceptance criteria
- Write tests (if TDD is specified)
- Close task when complete (`bd close`)

**Outcome:** Features are implemented, tested, and committed to version control.

---

### Sprint Phase 3: Verification

**Reference:** SDLC.md Phase 3

QA specialist verifies that implementations meet acceptance criteria:
- Run full test suite
- Verify acceptance criteria
- Test edge cases and error conditions
- Create bug tasks for issues found

**Outcome:** All acceptance criteria verified. No critical bugs blocking release.

---

### Sprint Phase 4: Deployment

**Reference:** SDLC.md Phase 4

Ops specialist (or Architect) deploys to production:
- Build production artifacts
- Deploy to target environment
- Verify deployment success
- Monitor for errors

**Outcome:** Release is live and healthy.

---

## Sprint Principles

### Semantic Over Prescriptive

Agents are reasoning systems. We provide phases and principles, not step-by-step instructions.

**Example:**
- ❌ Wrong: "Run `git status` to check for uncommitted changes"
- ✅ Right: "Verify version control state before claiming tasks"

### Verify Prerequisites Semantically

Agents use judgment to verify prerequisites. If a practice requires a tool, agents verify the tool exists and works.

**Example:**
- ❌ Wrong: Provide `hasGitRepo()` function
- ✅ Right: Phase 0 guidance requires version control initialization

### Dependency-Aware Work

Use Beads dependency graph to ensure work is done in the correct order:
- Architect defines dependencies (`bd dep add`)
- Specialists work on ready tasks (`bd ready --json`)
- No manual coordination required

---

## Sprint Gates

### Gate 0: Environment Ready

**Check:** All prerequisites from Phase 0 are verified.

**Block:** Cannot proceed to Phase 1 if environment is incomplete.

---

### Gate 1: Design Complete

**Check:** Task graph exists with acceptance criteria.

**Block:** Cannot proceed to Phase 2 if design is incomplete or ambiguous.

---

### Gate 2: Implementation Complete

**Check:** All tasks closed, all tests passing.

**Block:** Cannot proceed to Phase 3 if code is incomplete or tests fail.

---

### Gate 3: Verification Complete

**Check:** QA report shows all acceptance criteria met, no critical bugs.

**Block:** Cannot proceed to Phase 4 if verification fails.

---

## Anti-Patterns (What NOT to Do)

### ❌ Prescriptive Commands in Vision Documents

**Wrong:**
```
1. Run `bd init`
2. Run `git init`
3. Run `npm install`
```

**Right:**
```
Phase 0: Verify task tracking, version control, and dependencies are initialized.
```

**Why:** Agents should understand requirements and verify them semantically.

### ❌ Deterministic Tooling for Prerequisites

**Wrong:**
```typescript
if (!hasBeads(projectRoot)) {
  await initBeads(projectRoot);
}
```

**Right:**
```
Phase 0 guidance: "If Task Tracking is specified → task management system (Beads) is initialized"
```

**Why:** Agents should reason about prerequisites, not depend on functions.

### ❌ Assuming Agents Know Everything

**Wrong:**
```
# Assumes agents know how to check git status
Verify version control is clean.
```

**Right:**
```
# Provides semantic guidance
Verify version control state is clean (no uncommitted changes).
Use diagnostic commands to check repository state.
```

**Why:** Semantic guidance should be complete enough for agents to reason about.

---

## Evolution

As new practices emerge (e.g., automated deployment, observability), add them to Phase 0 as prerequisites to verify. The semantic approach adapts without requiring code changes.

---

## References

- SDLC phases: See `swe-process/SDLC.md`
- Task tracking: See `swe-process/BEADS-QUICK-REF.md`
- Agent roles: See `AGENTS.md` in each agent workspace
- AOF project: `~/Projects/AOF`
