# Software Development Lifecycle - Agent Operating Framework

**Version:** 2.0 (Semantic Phases)  
**Status:** Active  
**Scope:** All AOF and Mule development work

## Overview

This document defines the development lifecycle for agent-driven software projects. It uses **semantic phases** that require reasoning and judgment, not prescriptive checklists.

Agents are reasoning systems, not CI pipelines. We provide phases and principles; agents verify prerequisites and make implementation decisions.

## Phase 0: Environment Readiness (Pre-Sprint)

**Purpose:** Verify the development environment supports all practices specified in this lifecycle.

**Responsibility:** Architect (or lead agent starting a sprint)

**Actions Required:**

Before starting any sprint or claiming any task, verify that the development environment supports every practice required by this project:

- **If Trunk-Based Development is specified** → version control system exists and is initialized
  - Run diagnostic commands (e.g., `git status`) to verify repository state
  - If missing, initialize version control with appropriate defaults
  - Ensure default branch naming aligns with team conventions

- **If Test-Driven Development is specified** → test runner and assertion library are working
  - Verify test framework is installed and executable
  - Run smoke test to confirm test discovery and execution work
  - If missing, install required test dependencies

- **If Task Tracking is specified** → task management system (Beads) is initialized
  - Verify task database exists and is accessible
  - Confirm task creation, claiming, and closing workflows function
  - If missing, initialize task tracking with `bd init`

- **If Continuous Integration is specified** → build pipeline is verified
  - Confirm build scripts run successfully
  - Verify CI configuration files are present and valid
  - If missing, create minimal CI configuration

- **If Code Quality Tooling is specified** → linters, formatters, and type checkers are configured
  - Verify tooling runs without errors on existing codebase
  - Confirm configuration files are present
  - If missing, install and configure required tools

**Acceptance Criteria:**
- All prerequisite systems are functional
- No gaps exist that would block development work
- Environment state is documented (what exists, what was created)

**Out of Scope:**
- Prescriptive step-by-step commands (agents use judgment)
- Specific tool choices (agents select appropriate tools for the ecosystem)
- Automated tooling to check prerequisites (agents verify semantically)

**Principle:** Fix any gaps BEFORE proceeding to Phase 1. Do not start work with an incomplete environment.

---

## Phase 1: Design & Planning

**Purpose:** Define what will be built, how it will be architected, and how work will be decomposed.

**Responsibility:** Architect

**Actions Required:**

- Review requirements and produce architectural design
- Identify major components, interfaces, and data flows
- Decompose work into implementable tasks
- Create task records with dependencies in task tracking system
- Define acceptance criteria for each task
- Estimate complexity and identify risks

**Acceptance Criteria:**
- Design documents exist and are complete
- Task graph is created with dependencies
- All tasks have clear acceptance criteria
- Design review is complete (if required by project governance)

---

## Phase 2: Implementation

**Purpose:** Build the designed system according to specifications.

**Responsibility:** Backend, Frontend, QA specialists (as assigned by Architect)

**Actions Required:**

- Claim task from ready queue
- Implement according to task brief and acceptance criteria
- Write tests first (if TDD is specified)
- Commit frequently with meaningful messages
- Push code to version control
- Mark task complete when acceptance criteria are met

**Acceptance Criteria:**
- Code exists and builds successfully
- Tests pass (unit, integration, as specified)
- Code review is complete (if required)
- Task is marked closed in task tracking

---

## Phase 3: Verification

**Purpose:** Confirm that implementation meets acceptance criteria and doesn't introduce regressions.

**Responsibility:** QA specialist

**Actions Required:**

- Run full test suite
- Verify acceptance criteria for completed tasks
- Test edge cases and error conditions
- Document any issues found
- Create bug tasks for failures

**Acceptance Criteria:**
- All tests pass
- Acceptance criteria verified
- No critical bugs blocking release
- QA report generated

---

## Phase 4: Deployment & Monitoring

**Purpose:** Release to production and verify system health.

**Responsibility:** Ops specialist (or Architect if ops role doesn't exist)

**Actions Required:**

- Build production artifacts
- Deploy to target environment
- Verify deployment success
- Monitor for errors or anomalies
- Document deployment state

**Acceptance Criteria:**
- Deployment completes successfully
- Health checks pass
- Monitoring confirms expected behavior
- Rollback plan is ready (if issues occur)

---

## Practices

### Trunk-Based Development

- Work on main branch (or short-lived feature branches < 1 day)
- Commit frequently
- Keep builds green
- If version control doesn't exist, Phase 0 must initialize it

### Test-Driven Development (TDD)

- Write tests before implementation
- Run tests frequently
- Maintain high test coverage
- If test framework doesn't exist, Phase 0 must configure it

### Task Tracking (Beads)

- All work is tracked as tasks
- Tasks have dependencies
- Agents claim tasks before starting work
- Agents close tasks when acceptance criteria are met
- If task tracking doesn't exist, Phase 0 must initialize it

### Code Review

- All code changes are reviewed (by human or senior agent)
- Reviews check for architectural conformance
- Reviews verify acceptance criteria alignment

---

## Anti-Patterns (What NOT to Do)

### ❌ Prescriptive Checklists

**Wrong:**
```
STEP 1: Run `git init`
STEP 2: Run `git config user.name "Team Name"`
STEP 3: Run `git branch -M main`
```

**Right:**
```
Verify version control is initialized. If not, initialize it with appropriate defaults.
```

**Why:** Agents should understand requirements and execute with judgment, not follow rote instructions.

### ❌ Deterministic Tooling

**Wrong:**
```typescript
if (!hasGitRepo(projectRoot)) {
  await initGit(projectRoot);
}
```

**Right:**
```
Phase 0 guidance: "If Trunk-Based Development is specified → version control system exists and is initialized"
```

**Why:** Agents should reason about prerequisites, not depend on functions that check for them.

### ❌ Assuming Tools Exist

**Wrong:**
```
Run `npm test` (assumes test framework is installed)
```

**Right:**
```
Phase 0 guidance: "If Test-Driven Development is specified → test runner and assertion library are working"
```

**Why:** Agents should verify prerequisites exist before using them.

---

## Evolution

This document describes semantic phases. If new practices are adopted (e.g., continuous deployment, automated monitoring), add them to Phase 0 as prerequisites to verify.

The semantic approach means **new practices don't require code changes**. Agents understand the principles and adapt.

---

## References

- Task tracking: `~/Projects/AOF/.beads/` (Beads database)
- Project structure: `~/Projects/AOF/` (AOF codebase)
- Agent roles: See `AGENTS.md` in each agent workspace
