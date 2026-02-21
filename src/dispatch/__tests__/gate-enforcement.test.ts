/**
 * SDLC Gate Enforcement Tests — P0 regression suite.
 *
 * Proves that the AOF runtime strictly enforces gate transitions:
 * - Only the authorized role can advance a gate (code-review = architect only)
 * - Only the authorized role can reject a gate (qa = swe-qa only)
 * - Gates with canReject: false cannot issue needs_review
 * - Conditional gates (security, docs) are inserted and enforced based on task tags
 * - A backend/frontend agent CANNOT bypass code-review or qa gates
 *
 * Related:
 * - RCA: docs/analysis/RCA-SDLC-Gate-Enforcement.md
 * - Design: docs/design/AGENTIC-SDLC-DESIGN.md
 * - Fix: src/dispatch/gate-evaluator.ts (callerRole enforcement, canReject enforcement)
 */

import { describe, it, expect } from "vitest";
import { evaluateGateTransition, type GateEvaluationInput } from "../gate-evaluator.js";
import type { Task } from "../../schemas/task.js";
import type { WorkflowConfig } from "../../schemas/workflow.js";

// ── Shared fixtures ────────────────────────────────────────────────────────────

/** Full SDLC workflow matching AGENTIC-SDLC-DESIGN.md */
const SDLC_WORKFLOW: WorkflowConfig = {
  name: "agentic-sdlc",
  rejectionStrategy: "origin",
  gates: [
    { id: "implement",    role: "swe-backend",   canReject: false },
    { id: "code-review",  role: "swe-architect",  canReject: true  },
    { id: "qa",           role: "swe-qa",          canReject: true  },
    {
      id: "security",
      role: "swe-security",
      canReject: true,
      when: "tags.includes('security')",
    },
    {
      id: "docs",
      role: "swe-tech-writer",
      canReject: true,
      when: "tags.includes('docs')",
    },
    { id: "po-accept",    role: "swe-po",          canReject: true  },
  ],
};

/**
 * Build a minimal task at the given gate.
 *
 * @param gate - Current gate ID
 * @param tags - Routing tags (for conditional gate evaluation)
 */
function makeTask(gate: string, tags: string[] = []): Task {
  return {
    frontmatter: {
      schemaVersion: 1,
      id: "TASK-2026-02-21-001",
      project: "test",
      title: "Add authentication endpoint",
      status: "in-progress",
      priority: "normal",
      routing: { workflow: "agentic-sdlc", role: "swe-backend", tags },
      createdAt: "2026-02-21T00:00:00Z",
      updatedAt: "2026-02-21T00:00:00Z",
      lastTransitionAt: "2026-02-21T00:00:00Z",
      createdBy: "system",
      gate: {
        current: gate,
        entered: "2026-02-21T00:00:00Z",
      },
      gateHistory: [],
      metadata: {},
    },
    body: "Implement JWT auth endpoint.",
  };
}

// ── ROLE ENFORCEMENT ───────────────────────────────────────────────────────────

describe("SDLC Gate Enforcement: role authorization", () => {
  describe("code-review gate (swe-architect only)", () => {
    it("BLOCKS a backend agent from approving code-review", () => {
      const input: GateEvaluationInput = {
        task: makeTask("code-review"),
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "Looks good to me",
        agent: "swe-backend-1",
        callerRole: "swe-backend",           // ← backend trying to approve
      };

      expect(() => evaluateGateTransition(input)).toThrow(
        /Unauthorized gate transition.*code-review.*requires role.*swe-architect.*caller has role.*swe-backend/i
      );
    });

    it("BLOCKS a QA agent from approving code-review", () => {
      const input: GateEvaluationInput = {
        task: makeTask("code-review"),
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "LGTM",
        agent: "swe-qa-1",
        callerRole: "swe-qa",               // ← QA trying to approve code-review
      };

      expect(() => evaluateGateTransition(input)).toThrow(
        /Unauthorized gate transition.*code-review.*requires role.*swe-architect/i
      );
    });

    it("BLOCKS a PO from approving code-review", () => {
      const input: GateEvaluationInput = {
        task: makeTask("code-review"),
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "Approved",
        agent: "swe-po-1",
        callerRole: "swe-po",              // ← PO trying to approve code-review
      };

      expect(() => evaluateGateTransition(input)).toThrow(
        /Unauthorized gate transition.*code-review.*requires role.*swe-architect/i
      );
    });

    it("ALLOWS the architect to approve code-review", () => {
      const input: GateEvaluationInput = {
        task: makeTask("code-review"),
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "Code quality verified. TDD followed. Coverage 91%. LGTM.",
        agent: "swe-architect-main",
        callerRole: "swe-architect",        // ← correct role
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("code-review");
      expect(result.transition.toGate).toBe("qa");
      expect(result.transition.outcome).toBe("complete");
    });

    it("ALLOWS the architect to reject code-review (send back to implement)", () => {
      const input: GateEvaluationInput = {
        task: makeTask("code-review"),
        workflow: SDLC_WORKFLOW,
        outcome: "needs_review",
        summary: "TDD not followed. Tests added after implementation.",
        blockers: ["Tests committed after implementation — fix commit order"],
        rejectionNotes: "Re-commit with tests first (TDD required)",
        agent: "swe-architect-main",
        callerRole: "swe-architect",        // ← correct role
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("code-review");
      expect(result.transition.toGate).toBe("implement");  // loops back
      expect(result.transition.outcome).toBe("needs_review");
      expect(result.taskUpdates.reviewContext?.fromGate).toBe("code-review");
    });
  });

  describe("qa gate (swe-qa only)", () => {
    it("BLOCKS a backend agent from approving QA", () => {
      const input: GateEvaluationInput = {
        task: makeTask("qa"),
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "Tests pass",
        agent: "swe-backend-1",
        callerRole: "swe-backend",          // ← backend trying to bypass QA
      };

      expect(() => evaluateGateTransition(input)).toThrow(
        /Unauthorized gate transition.*qa.*requires role.*swe-qa.*caller has role.*swe-backend/i
      );
    });

    it("BLOCKS an architect from approving QA", () => {
      const input: GateEvaluationInput = {
        task: makeTask("qa"),
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "Looks tested",
        agent: "swe-architect-main",
        callerRole: "swe-architect",        // ← architect trying to bypass QA
      };

      expect(() => evaluateGateTransition(input)).toThrow(
        /Unauthorized gate transition.*qa.*requires role.*swe-qa/i
      );
    });

    it("ALLOWS the QA engineer to approve QA", () => {
      const task = makeTask("qa");
      // Simulate task history: already passed code-review
      task.frontmatter.gateHistory = [
        {
          gate: "implement",
          role: "swe-backend",
          entered: "2026-02-21T00:00:00Z",
          exited:  "2026-02-21T01:00:00Z",
          outcome: "complete",
          summary: "Implementation complete",
          blockers: [],
          duration: 3600,
        },
        {
          gate: "code-review",
          role: "swe-architect",
          entered: "2026-02-21T01:00:00Z",
          exited:  "2026-02-21T01:30:00Z",
          outcome: "complete",
          summary: "LGTM. TDD followed, 91% coverage.",
          blockers: [],
          duration: 1800,
        },
      ];

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "All AC met. No regressions. Edge cases covered.",
        agent: "swe-qa-1",
        callerRole: "swe-qa",             // ← correct role
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("qa");
      // No security/docs tags → advance to po-accept
      expect(result.transition.toGate).toBe("po-accept");
    });

    it("ALLOWS the QA engineer to reject back to implement", () => {
      const input: GateEvaluationInput = {
        task: makeTask("qa"),
        workflow: SDLC_WORKFLOW,
        outcome: "needs_review",
        summary: "AC not met. GET /users/:id missing 401 test.",
        blockers: ["Missing 401 test for unauthenticated requests"],
        rejectionNotes: "Add test for unauthenticated path",
        agent: "swe-qa-1",
        callerRole: "swe-qa",
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.toGate).toBe("implement");
      expect(result.taskUpdates.reviewContext?.fromGate).toBe("qa");
      expect(result.taskUpdates.reviewContext?.fromRole).toBe("swe-qa");
    });
  });
});

// ── canReject ENFORCEMENT ──────────────────────────────────────────────────────

describe("SDLC Gate Enforcement: canReject constraint", () => {
  it("BLOCKS needs_review from the implement gate (canReject: false)", () => {
    // The implement gate cannot reject — it is the starting point, not a review gate.
    const input: GateEvaluationInput = {
      task: makeTask("implement"),
      workflow: SDLC_WORKFLOW,
      outcome: "needs_review",            // ← invalid for this gate
      summary: "Trying to reject",
      blockers: ["Some blocker"],
      agent: "swe-backend-1",
      callerRole: "swe-backend",          // correct role but still blocked
    };

    expect(() => evaluateGateTransition(input)).toThrow(
      /Gate "implement".*does not allow rejections.*canReject: false/i
    );
  });

  it("BLOCKS needs_review from the implement gate even without callerRole", () => {
    // canReject enforcement applies regardless of whether callerRole is present
    const input: GateEvaluationInput = {
      task: makeTask("implement"),
      workflow: SDLC_WORKFLOW,
      outcome: "needs_review",
      summary: "Trying to reject",
      blockers: ["Blocker"],
      agent: "anyone",
      // callerRole intentionally omitted
    };

    expect(() => evaluateGateTransition(input)).toThrow(
      /Gate "implement".*does not allow rejections.*canReject: false/i
    );
  });

  it("ALLOWS complete from the implement gate (canReject: false does not block complete)", () => {
    const input: GateEvaluationInput = {
      task: makeTask("implement"),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "Implementation done",
      agent: "swe-backend-1",
      callerRole: "swe-backend",
    };

    const result = evaluateGateTransition(input);
    expect(result.transition.fromGate).toBe("implement");
    expect(result.transition.toGate).toBe("code-review");
  });
});

// ── CONDITIONAL GATE ENFORCEMENT ──────────────────────────────────────────────

describe("SDLC Gate Enforcement: conditional gates (security / docs)", () => {
  describe("security gate (when: tags.includes('security'))", () => {
    it("INSERTS security gate for tasks tagged 'security'", () => {
      // QA completes → next gate should be security (tag present)
      const task = makeTask("qa", ["security"]);

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "QA passed",
        agent: "swe-qa-1",
        callerRole: "swe-qa",
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("qa");
      expect(result.transition.toGate).toBe("security");  // ← inserted
      expect(result.skippedGates).not.toContain("security");
    });

    it("SKIPS security gate for tasks without 'security' tag", () => {
      const task = makeTask("qa", []);  // no security tag

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "QA passed",
        agent: "swe-qa-1",
        callerRole: "swe-qa",
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("qa");
      expect(result.skippedGates).toContain("security");
    });

    it("BLOCKS an architect from approving the security gate", () => {
      const task = makeTask("security", ["security"]);

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "Looks secure",
        agent: "swe-architect-main",
        callerRole: "swe-architect",     // ← wrong role for security gate
      };

      expect(() => evaluateGateTransition(input)).toThrow(
        /Unauthorized gate transition.*security.*requires role.*swe-security/i
      );
    });

    it("ALLOWS the security engineer to approve the security gate", () => {
      const task = makeTask("security", ["security"]);

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "No CVEs. Input validation present. Auth logic correct.",
        agent: "swe-security-1",
        callerRole: "swe-security",      // ← correct role
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("security");
      // No docs tag → should advance to po-accept
      expect(result.transition.toGate).toBe("po-accept");
    });
  });

  describe("docs gate (when: tags.includes('docs'))", () => {
    it("INSERTS docs gate for tasks tagged 'docs'", () => {
      // QA completes → next gate should be docs (tag present, no security tag)
      const task = makeTask("qa", ["docs"]);

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "QA passed",
        agent: "swe-qa-1",
        callerRole: "swe-qa",
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("qa");
      // security skipped (no security tag), docs active (docs tag present)
      expect(result.skippedGates).toContain("security");
      expect(result.transition.toGate).toBe("docs");     // ← inserted
    });

    it("SKIPS docs gate for tasks without 'docs' tag", () => {
      const task = makeTask("qa", []);  // no docs tag

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "QA passed",
        agent: "swe-qa-1",
        callerRole: "swe-qa",
      };

      const result = evaluateGateTransition(input);
      expect(result.skippedGates).toContain("docs");
    });

    it("INSERTS both security AND docs gates for tasks tagged with both", () => {
      // From code-review, both security and docs should be required
      const task = makeTask("code-review", ["security", "docs"]);

      const input: GateEvaluationInput = {
        task,
        workflow: SDLC_WORKFLOW,
        outcome: "complete",
        summary: "LGTM",
        agent: "swe-architect-main",
        callerRole: "swe-architect",
      };

      const result = evaluateGateTransition(input);
      expect(result.transition.fromGate).toBe("code-review");
      // Next after code-review is qa (unconditional)
      expect(result.transition.toGate).toBe("qa");
      // Neither security nor docs skipped from this advance
      expect(result.skippedGates).toEqual([]);
    });
  });
});

// ── END-TO-END BYPASS PREVENTION ──────────────────────────────────────────────

describe("SDLC Gate Enforcement: bypass prevention (full pipeline)", () => {
  it("prevents an implementation agent from marking a task done without code-review/qa", () => {
    // Simulate: backend agent has a task at code-review gate and tries to
    // call complete with their own role (should be blocked).
    const input: GateEvaluationInput = {
      task: makeTask("code-review"),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "All done, trust me",
      agent: "swe-backend-1",
      callerRole: "swe-backend",           // ← bypass attempt
    };

    expect(() => evaluateGateTransition(input)).toThrow(/Unauthorized gate transition/i);
  });

  it("prevents an implementation agent from self-approving qa", () => {
    const input: GateEvaluationInput = {
      task: makeTask("qa"),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "I tested it myself",
      agent: "swe-backend-1",
      callerRole: "swe-backend",           // ← bypass attempt
    };

    expect(() => evaluateGateTransition(input)).toThrow(/Unauthorized gate transition/i);
  });

  it("correctly routes a security task through all required gates (implement→code-review→qa→security→po-accept→done)", () => {
    const tags = ["security"];

    // Step 1: implement → code-review
    const step1Input: GateEvaluationInput = {
      task: makeTask("implement", tags),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "Tests written first. Implementation follows TDD.",
      agent: "swe-backend-1",
      callerRole: "swe-backend",
    };
    const step1 = evaluateGateTransition(step1Input);
    expect(step1.transition.toGate).toBe("code-review");

    // Step 2: code-review → qa (architect approves)
    const step2Input: GateEvaluationInput = {
      task: makeTask("code-review", tags),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "TDD verified. Coverage 88%. LGTM.",
      agent: "swe-architect-main",
      callerRole: "swe-architect",
    };
    const step2 = evaluateGateTransition(step2Input);
    expect(step2.transition.toGate).toBe("qa");

    // Step 3: qa → security (qa approves, security tag active)
    const step3Input: GateEvaluationInput = {
      task: makeTask("qa", tags),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "All AC met. Edge cases covered. No regressions.",
      agent: "swe-qa-1",
      callerRole: "swe-qa",
    };
    const step3 = evaluateGateTransition(step3Input);
    expect(step3.transition.toGate).toBe("security");   // ← security inserted
    expect(step3.skippedGates).not.toContain("security");

    // Step 4: security → po-accept (security engineer approves, no docs tag)
    const step4Input: GateEvaluationInput = {
      task: makeTask("security", tags),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "No CVEs. Input validation correct. Auth logic reviewed.",
      agent: "swe-security-1",
      callerRole: "swe-security",
    };
    const step4 = evaluateGateTransition(step4Input);
    expect(step4.transition.toGate).toBe("po-accept");  // docs skipped (no tag)
    expect(step4.skippedGates).toContain("docs");

    // Step 5: po-accept → done
    const step5Input: GateEvaluationInput = {
      task: makeTask("po-accept", tags),
      workflow: SDLC_WORKFLOW,
      outcome: "complete",
      summary: "All AC met. Behaviour matches requirements. Shippable.",
      agent: "swe-po-main",
      callerRole: "swe-po",
    };
    const step5 = evaluateGateTransition(step5Input);
    expect(step5.transition.toGate).toBeUndefined();    // ← terminal
    expect(step5.taskUpdates.status).toBe("done");
  });
});
