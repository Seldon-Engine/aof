# RCA: SDLC Gate Enforcement Failure

**Date:** 2026-02-21
**Status:** Critical Bug
**Authors:** Demerzel (Operations)
**Target Audience:** `swe-architect`, `swe-po`

## Problem Statement
The AOF workflow engine is currently failing to strictly enforce the SDLC gates defined in our Agentic SDLC design (`docs/design/AGENTIC-SDLC-DESIGN.md`). Tasks are moving through the system or being processed without rigid adherence to the multi-stage quality gates (Code Review, QA, PO Accept, etc.). 

This lack of enforcement constitutes a critical bug, as it compromises the core innovation of our agentic workflow: using rejection as a first-class learning signal and ensuring quality through automated, deterministic state transitions.

## Impact
- **Quality Erosion:** Code can be merged without passing through the Architect's `code-review` gate (which enforces TDD and coverage limits).
- **Process Bypass:** Conditional gates (`security`, `docs`) or standard validation gates (`qa`, `po-accept`) are easily bypassed if the state machine doesn't strictly lock task progression.
- **Metrics Invalidation:** Cycle times, rejection rates, and bottleneck detection metrics become meaningless if the gate flow is not strictly enforced by the platform.

## Root Cause Analysis
1. **Permissive State Transitions:** The dispatch mechanism or task update logic allows agents to update task statuses to `done` or transition between states without the workflow engine verifying that the required gate owner (e.g., `swe-architect` for `code-review`) actually performed the approval.
2. **Missing Gate Transition Locks:** The workflow logic does not strictly reject transitions that skip mandatory gates. The workflow engine should physically block a task from entering `qa` if it hasn't successfully cleared `code-review`.
3. **Implicit vs. Explicit Gate Approvals:** The system relies too heavily on agents "doing the right thing" rather than the AOF runtime enforcing cryptographic or strict identity-based state updates for gate advancement.

## Remediation Plan (Action Required)

**For `swe-architect` and `swe-backend`:**
1. **Implement Strict State Machine Enforcement:** Modify the AOF dispatcher/workflow core to enforce that a task can only advance to the next gate if the correct role explicitly approves it via the proper tool call.
2. **Lock State Transitions:** Any attempt to skip a gate or move a task to `done` prematurely must be rejected by the runtime with a clear error to the agent.
3. **Enforce Conditional Gates:** Ensure that the tags (e.g., `docs`, `security`) correctly insert mandatory gates into the task's flow at runtime, and that these cannot be bypassed.

**For `swe-po`:**
1. Review this RCA and ensure that the backlog tasks created to fix this accurately reflect the strict requirements of `AGENTIC-SDLC-DESIGN.md`.
2. Prioritize this fix above standard feature work, as the integrity of the entire agentic pipeline depends on it.

## Definition of Done for Fix
- AOF runtime explicitly rejects invalid gate transitions.
- Unit/E2E tests prove that an implementation agent cannot mark a task as `done` without it passing `code-review` and `qa`.
- The SDLC pipeline is strictly enforced locally and ready for the next Mule deployment.