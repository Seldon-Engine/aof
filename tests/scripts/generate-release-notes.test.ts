import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  parseMilestones,
  findMilestone,
  isPlanningDoc,
  formatOutput,
} from '../../scripts/generate-release-notes.mjs';

describe('parseVersion', () => {
  it('strips v prefix and patch version', () => {
    expect(parseVersion('v1.3.0')).toBe('1.3');
  });

  it('strips v prefix without patch', () => {
    expect(parseVersion('v1.3')).toBe('1.3');
  });

  it('handles bare version with patch', () => {
    expect(parseVersion('1.3.0')).toBe('1.3');
  });

  it('handles bare major.minor', () => {
    expect(parseVersion('1.3')).toBe('1.3');
  });

  it('handles single number', () => {
    expect(parseVersion('v1')).toBe('1');
  });
});

describe('parseMilestones', () => {
  const sample = `# Milestones

## v1.3 Seamless Upgrade (Shipped: 2026-03-04)

**Phases completed:** 4 phases (17-20), 7 plans

**Key accomplishments:**
- Migration framework with snapshot-based rollback
- DAG workflows as default for new tasks

---

## v1.2 Task Workflows (Shipped: 2026-03-03)

**Phases completed:** 7 phases, 16 plans, 0 tasks

**Key accomplishments:**
- (none recorded)

---
`;

  it('parses multiple entries', () => {
    const entries = parseMilestones(sample);
    expect(entries).toHaveLength(2);
  });

  it('extracts version and title', () => {
    const entries = parseMilestones(sample);
    expect(entries[0].version).toBe('1.3');
    expect(entries[0].title).toBe('Seamless Upgrade');
  });

  it('extracts phases', () => {
    const entries = parseMilestones(sample);
    expect(entries[0].phases).toBe('4 phases (17-20), 7 plans');
  });

  it('extracts accomplishments', () => {
    const entries = parseMilestones(sample);
    expect(entries[0].accomplishments).toEqual([
      'Migration framework with snapshot-based rollback',
      'DAG workflows as default for new tasks',
    ]);
  });

  it('skips (none recorded) accomplishments', () => {
    const entries = parseMilestones(sample);
    expect(entries[1].accomplishments).toEqual([]);
  });
});

describe('findMilestone', () => {
  const entries = [
    { version: '1.3', title: 'Seamless Upgrade', phases: '', accomplishments: ['a'] },
    { version: '1.2', title: 'Task Workflows', phases: '', accomplishments: [] },
  ];

  it('finds by exact major.minor', () => {
    expect(findMilestone(entries, 'v1.3')).toBe(entries[0]);
  });

  it('finds by fuzzy match (v1.3.0 → 1.3)', () => {
    expect(findMilestone(entries, 'v1.3.0')).toBe(entries[0]);
  });

  it('returns null when no match', () => {
    expect(findMilestone(entries, 'v2.0.0')).toBeNull();
  });
});

describe('isPlanningDoc', () => {
  // Scoped planning — should be filtered
  it('filters docs(17-01): scoped commits', () => {
    expect(isPlanningDoc('docs(17-01): add phase plan')).toBe(true);
  });

  it('filters docs(phase-17): scoped commits', () => {
    expect(isPlanningDoc('docs(phase-17): complete phase execution')).toBe(true);
  });

  it('filters docs(state): scoped commits', () => {
    expect(isPlanningDoc('docs(state): update tracking')).toBe(true);
  });

  it('filters docs(audit): scoped commits', () => {
    expect(isPlanningDoc('docs(audit): milestone review')).toBe(true);
  });

  it('filters docs(roadmap): scoped commits', () => {
    expect(isPlanningDoc('docs(roadmap): update phases')).toBe(true);
  });

  it('filters docs(24-01): numbered plan scope', () => {
    expect(isPlanningDoc('docs(24-01): add context optimization measurements document')).toBe(true);
  });

  // Unscoped planning — should be filtered
  it('filters unscoped milestone docs', () => {
    expect(isPlanningDoc('docs: create milestone v1.3 roadmap')).toBe(true);
  });

  it('filters unscoped phase docs', () => {
    expect(isPlanningDoc('docs: start phase 17 planning')).toBe(true);
  });

  it('filters unscoped research docs', () => {
    expect(isPlanningDoc('docs: add research for migration')).toBe(true);
  });

  // Non-planning docs — should survive
  it('keeps docs(README): scoped commits', () => {
    expect(isPlanningDoc('docs(README): update installation guide')).toBe(false);
  });

  it('keeps docs(api): scoped commits', () => {
    expect(isPlanningDoc('docs(api): add endpoint reference')).toBe(false);
  });

  it('keeps unscoped non-planning docs', () => {
    expect(isPlanningDoc('docs: update UPGRADING.md')).toBe(false);
  });

  // Non-docs types — should not match
  it('ignores feat commits', () => {
    expect(isPlanningDoc('feat(17-01): implement migration')).toBe(false);
  });

  it('ignores fix commits', () => {
    expect(isPlanningDoc('fix: resolve crash')).toBe(false);
  });
});

describe('formatOutput', () => {
  it('renders highlights and changes', () => {
    const milestone = {
      title: 'Seamless Upgrade',
      phases: '4 phases (17-20), 7 plans',
      accomplishments: ['Migration framework', 'DAG workflows as default'],
    };
    const grouped = {
      feat: ['feat(18-01): implement resolveDefaultWorkflow (fb21dca)'],
      fix: ['fix: correct migration path (abc1234)'],
    };

    const output = formatOutput(milestone, grouped);
    expect(output).toContain('## Highlights');
    expect(output).toContain('**Seamless Upgrade** — 4 phases (17-20), 7 plans');
    expect(output).toContain('- Migration framework');
    expect(output).toContain('## Changes');
    expect(output).toContain('### Features');
    expect(output).toContain('### Bug Fixes');
  });

  it('skips highlights when no milestone', () => {
    const grouped = {
      feat: ['feat: add feature (abc1234)'],
    };
    const output = formatOutput(null, grouped);
    expect(output).not.toContain('## Highlights');
    expect(output).toContain('## Changes');
  });

  it('skips highlights when accomplishments empty', () => {
    const milestone = {
      title: 'Task Workflows',
      phases: '7 phases',
      accomplishments: [],
    };
    const grouped = {
      feat: ['feat: something (abc1234)'],
    };
    const output = formatOutput(milestone, grouped);
    expect(output).not.toContain('## Highlights');
  });

  it('skips changes when no commits', () => {
    const milestone = {
      title: 'Test',
      phases: '1 phase',
      accomplishments: ['Did a thing'],
    };
    const output = formatOutput(milestone, {});
    expect(output).toContain('## Highlights');
    expect(output).not.toContain('## Changes');
  });

  it('returns empty string when nothing to show', () => {
    const output = formatOutput(null, {});
    expect(output).toBe('');
  });
});
