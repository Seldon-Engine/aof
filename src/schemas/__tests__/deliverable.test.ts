import { describe, it, expect } from "vitest";
import { checkRunbookCompliance } from "../deliverable.js";

describe("checkRunbookCompliance", () => {
  const runbookPath = "data/runbooks/swe/deploy-backend.md";

  it("passes when compliance section references runbook and checkpoints", () => {
    const body = `# Deliverables

## Runbook compliance
Runbook: ${runbookPath}

Checkpoints:
- [x] Verified pre-deploy checklist
- [x] Ran smoke tests
`;

    const result = checkRunbookCompliance(body, runbookPath);

    expect(result.compliant).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.sectionFound).toBe(true);
    expect(result.referencesRunbook).toBe(true);
    expect(result.hasCheckpoints).toBe(true);
  });

  it("warns when compliance section is missing", () => {
    const body = `# Deliverables\n\nNo compliance section here.`;
    const result = checkRunbookCompliance(body, runbookPath);

    expect(result.compliant).toBe(false);
    expect(result.sectionFound).toBe(false);
    expect(result.warnings.join(" ")).toContain("Runbook compliance section");
  });

  it("warns when runbook reference is missing", () => {
    const body = `## Runbook compliance\n- [x] Completed checks`;
    const result = checkRunbookCompliance(body, runbookPath);

    expect(result.compliant).toBe(false);
    expect(result.referencesRunbook).toBe(false);
    expect(result.warnings.join(" ")).toContain("reference");
  });

  it("warns when checkpoints are missing", () => {
    const body = `## Runbook compliance\nRunbook: ${runbookPath}\n\nNo checkpoints listed.`;
    const result = checkRunbookCompliance(body, runbookPath);

    expect(result.compliant).toBe(false);
    expect(result.hasCheckpoints).toBe(false);
    expect(result.warnings.join(" ")).toContain("checkpoint");
  });
});
