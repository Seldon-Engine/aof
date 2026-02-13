/**
 * Deliverable parsing utilities.
 *
 * Provides lightweight, deterministic checks for runbook compliance sections.
 */

export interface DeliverableSection {
  heading: string;
  level: number;
  content: string;
}

export interface RunbookComplianceResult {
  requiredRunbook: string;
  sectionFound: boolean;
  referencesRunbook: boolean;
  hasCheckpoints: boolean;
  warnings: string[];
  compliant: boolean;
}

const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

export function parseDeliverableSections(body: string): DeliverableSection[] {
  const lines = body.split("\n");
  const sections: DeliverableSection[] = [];
  let current: DeliverableSection | null = null;

  for (const line of lines) {
    const match = HEADING_REGEX.exec(line.trim());
    if (match && match[1] && match[2]) {
      if (current) {
        current.content = current.content.trimEnd();
        sections.push(current);
      }
      current = {
        heading: match[2].trim(),
        level: match[1].length,
        content: "",
      };
      continue;
    }

    if (current) {
      current.content += line + "\n";
    }
  }

  if (current) {
    current.content = current.content.trimEnd();
    sections.push(current);
  }

  return sections;
}

export function findSection(body: string, heading: string): DeliverableSection | undefined {
  const normalized = normalizeHeading(heading);
  return parseDeliverableSections(body).find(
    (section) => normalizeHeading(section.heading) === normalized,
  );
}

function containsRunbookReference(content: string, requiredRunbook: string): boolean {
  const normalizedContent = content.toLowerCase();
  const normalizedRunbook = requiredRunbook.toLowerCase();
  return normalizedContent.includes(normalizedRunbook);
}

function hasCompletedCheckpoint(content: string): boolean {
  const lines = content.split("\n");
  return lines.some((line) => /^\s*[-*]\s+\[[xX]\]/.test(line));
}

export function checkRunbookCompliance(
  body: string,
  requiredRunbook: string,
): RunbookComplianceResult {
  const warnings: string[] = [];
  const section = findSection(body, "Runbook compliance");

  const sectionFound = Boolean(section);
  if (!sectionFound) {
    warnings.push("Missing Runbook compliance section.");
  }

  const content = section?.content ?? "";
  const referencesRunbook = sectionFound
    ? containsRunbookReference(content, requiredRunbook)
    : false;
  if (sectionFound && !referencesRunbook) {
    warnings.push("Runbook compliance section must reference the required runbook.");
  }

  const hasCheckpoints = sectionFound
    ? hasCompletedCheckpoint(content)
    : false;
  if (sectionFound && !hasCheckpoints) {
    warnings.push("Runbook compliance section must include completed checkpoints.");
  }

  const compliant = sectionFound && referencesRunbook && hasCheckpoints;

  return {
    requiredRunbook,
    sectionFound,
    referencesRunbook,
    hasCheckpoints,
    warnings,
    compliant,
  };
}
