import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// --- Pure functions (exported for testing) ---

/**
 * Normalize a version tag to its major.minor prefix.
 * "v1.3.0" → "1.3", "v1.3" → "1.3", "1.3.0" → "1.3"
 */
export function parseVersion(tag) {
  const cleaned = tag.replace(/^v/, '');
  const [major, minor] = cleaned.split('.');
  if (major == null || minor == null) return cleaned;
  return `${major}.${minor}`;
}

/**
 * Parse MILESTONES.md into structured entries.
 * Returns array of { version, title, phases, accomplishments }.
 */
export function parseMilestones(content) {
  const entries = [];
  const lines = content.split('\n');

  let current = null;
  let inAccomplishments = false;

  for (const line of lines) {
    // Match milestone header: ## v1.3 Seamless Upgrade (Shipped: ...)
    const headerMatch = line.match(/^## v(\d+\.\d+)\s+(.+?)(?:\s+\(.*\))?$/);
    if (headerMatch) {
      if (current) entries.push(current);
      current = {
        version: headerMatch[1],
        title: headerMatch[2].trim(),
        phases: '',
        accomplishments: [],
      };
      inAccomplishments = false;
      continue;
    }

    if (!current) continue;

    // Match phases line
    const phasesMatch = line.match(/^\*\*Phases completed:\*\*\s*(.+)$/);
    if (phasesMatch) {
      current.phases = phasesMatch[1].trim();
      continue;
    }

    // Detect accomplishments section
    if (line.match(/^\*\*Key accomplishments:\*\*/)) {
      inAccomplishments = true;
      continue;
    }

    // Collect accomplishment bullets
    if (inAccomplishments) {
      if (line.startsWith('- ') && line.trim() !== '- (none recorded)') {
        current.accomplishments.push(line.slice(2).trim());
      } else if (line.trim() === '' || line.startsWith('**') || line.startsWith('---')) {
        inAccomplishments = false;
      }
    }
  }

  if (current) entries.push(current);
  return entries;
}

/**
 * Find the milestone entry matching a version tag.
 * Tries exact match first, then fuzzy (major.minor prefix).
 */
export function findMilestone(entries, tag) {
  const target = parseVersion(tag);
  return entries.find((e) => e.version === target) ?? null;
}

/**
 * Check if a commit message is a planning/noise doc commit.
 */
export function isPlanningDoc(message) {
  // Must start with docs type
  const docsMatch = message.match(/^docs(?:\(([^)]*)\))?:\s*(.*)$/);
  if (!docsMatch) return false;

  const scope = docsMatch[1];
  const subject = docsMatch[2];

  // Scoped planning: docs(17-01):, docs(phase-17):, docs(state):, docs(audit):, docs(roadmap):
  if (scope && /^(\d+(-\d+)?|phase-\d+|state|audit|roadmap)$/.test(scope)) {
    return true;
  }

  // Unscoped planning keywords in subject
  if (!scope && /\b(milestone|roadmap|requirements|phase|planning|research)\b/i.test(subject)) {
    return true;
  }

  return false;
}

/**
 * Format the final release notes output.
 */
export function formatOutput(milestone, groupedCommits) {
  const parts = [];

  // Highlights section
  if (milestone && milestone.accomplishments.length > 0) {
    parts.push('## Highlights');
    parts.push(`**${milestone.title}** — ${milestone.phases}`);
    for (const item of milestone.accomplishments) {
      parts.push(`- ${item}`);
    }
    parts.push('');
  }

  // Changes section
  const typeOrder = [
    ['feat', 'Features'],
    ['fix', 'Bug Fixes'],
    ['perf', 'Performance'],
    ['refactor', 'Refactor'],
    ['test', 'Tests'],
    ['docs', 'Documentation'],
  ];

  const hasChanges = typeOrder.some(([type]) => groupedCommits[type]?.length > 0);

  if (hasChanges) {
    parts.push('## Changes');
    for (const [type, header] of typeOrder) {
      const commits = groupedCommits[type];
      if (commits && commits.length > 0) {
        parts.push(`### ${header}`);
        for (const c of commits) {
          parts.push(`- ${c}`);
        }
        parts.push('');
      }
    }
  }

  return parts.join('\n').trim();
}

// --- Main ---

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/generate-release-notes.mjs <version-tag>');
    process.exit(1);
  }

  // Find previous tag
  const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter((t) => t.startsWith('v'));

  const currentIdx = tags.indexOf(version);
  const prevTag = currentIdx >= 0 ? tags[currentIdx + 1] : tags[0];
  const range = prevTag ? `${prevTag}..${version}` : version;

  // Parse milestones
  let milestone = null;
  const milestonesPath = '.planning/MILESTONES.md';
  if (existsSync(milestonesPath)) {
    const content = readFileSync(milestonesPath, 'utf-8');
    const entries = parseMilestones(content);
    milestone = findMilestone(entries, version);
    if (!milestone) {
      console.error(`Warning: No MILESTONES.md entry found for ${version}`);
    }
  } else {
    console.error('Warning: .planning/MILESTONES.md not found');
  }

  // Parse git log
  let log;
  try {
    log = execSync(
      `git log --pretty=format:"%s (%h)" ${range}`,
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    log = '';
  }

  const grouped = {};
  const types = ['feat', 'fix', 'perf', 'refactor', 'test', 'docs'];

  if (log) {
    for (const line of log.split('\n')) {
      for (const type of types) {
        if (line.startsWith(`${type}(`) || line.startsWith(`${type}: `)) {
          // Skip planning docs and hidden types
          if (type === 'docs' && isPlanningDoc(line)) continue;

          if (!grouped[type]) grouped[type] = [];
          grouped[type].push(line);
          break;
        }
      }
    }
  }

  const output = formatOutput(milestone, grouped);
  if (output) {
    console.log(output);
  }
}

// Only run main when executed directly (not imported for testing)
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('generate-release-notes.mjs');

if (isMain) {
  main();
}
