import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { migrateToProjects, rollbackMigration } from "../migration.js";

describe("migrateToProjects", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aof-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("creates _inbox on fresh install (no legacy dirs, no _inbox)", async () => {
    // Empty vault root
    const result = await migrateToProjects(testRoot);

    expect(result.success).toBe(true);
    expect(result.warnings).toContain("Fresh install: creating _inbox project");
    expect(result.migratedDirs).toEqual([]);

    // Verify _inbox was created
    const inboxExists = await directoryExists(join(testRoot, "Projects", "_inbox"));
    expect(inboxExists).toBe(true);

    // Verify project.yaml exists
    const manifestPath = join(testRoot, "Projects", "_inbox", "project.yaml");
    const manifestExists = await fileExists(manifestPath);
    expect(manifestExists).toBe(true);
  });

  it("treats already-migrated vault as no-op (no legacy dirs + _inbox exists)", async () => {
    // Create Projects/_inbox to simulate already-migrated vault
    await mkdir(join(testRoot, "Projects", "_inbox"), { recursive: true });

    const result = await migrateToProjects(testRoot);

    expect(result.success).toBe(true);
    expect(result.warnings).toContain(
      "Already migrated: no legacy dirs and _inbox exists"
    );
    expect(result.migratedDirs).toEqual([]);
  });

  it("migrates legacy tasks/ and updates frontmatter", async () => {
    // Create legacy tasks/backlog/ with a sample task
    const tasksBacklogPath = join(testRoot, "tasks", "backlog");
    await mkdir(tasksBacklogPath, { recursive: true });

    const taskContent = `---
schemaVersion: 1
id: TASK-2026-01-01-001
title: Test Task
status: backlog
priority: high
routing:
  role: swe-backend
createdAt: 2026-01-01T10:00:00Z
updatedAt: 2026-01-01T10:00:00Z
lastTransitionAt: 2026-01-01T10:00:00Z
createdBy: test
dependsOn: []
metadata: {}
---

## Instructions
Test task body.
`;

    await writeFile(join(tasksBacklogPath, "TASK-2026-01-01-001.md"), taskContent);

    // Run migration with deterministic timestamp
    const result = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.migratedDirs).toContain("tasks");
    expect(result.updatedTaskCount).toBe(1);
    expect(result.backupPath).toBe(join(testRoot, "tasks.backup-2026-01-15T12-00-00-000Z"));

    // Verify backup exists
    const backupTaskPath = join(
      testRoot,
      "tasks.backup-2026-01-15T12-00-00-000Z",
      "tasks",
      "backlog",
      "TASK-2026-01-01-001.md"
    );
    const backupExists = await fileExists(backupTaskPath);
    expect(backupExists).toBe(true);

    // Verify migrated task has project field
    const migratedTaskPath = join(
      testRoot,
      "Projects",
      "_inbox",
      "tasks",
      "backlog",
      "TASK-2026-01-01-001.md"
    );
    const migratedContent = await readFile(migratedTaskPath, "utf-8");
    const frontmatter = extractFrontmatter(migratedContent);

    expect(frontmatter.project).toBe("_inbox");
    expect(frontmatter.id).toBe("TASK-2026-01-01-001");
    expect(frontmatter.title).toBe("Test Task");

    // Verify body is preserved
    expect(migratedContent).toContain("## Instructions");
    expect(migratedContent).toContain("Test task body.");

    // Verify project.yaml created
    const manifestPath = join(testRoot, "Projects", "_inbox", "project.yaml");
    const manifestExists = await fileExists(manifestPath);
    expect(manifestExists).toBe(true);

    const manifestContent = await readFile(manifestPath, "utf-8");
    const manifest = parseYaml(manifestContent);
    expect(manifest.id).toBe("_inbox");
    expect(manifest.title).toBe("_Inbox");
  });

  it("migrates multiple legacy directories (tasks, events, state, views)", async () => {
    // Create all legacy directories
    await mkdir(join(testRoot, "tasks", "backlog"), { recursive: true });
    await mkdir(join(testRoot, "events"), { recursive: true });
    await mkdir(join(testRoot, "state"), { recursive: true });
    await mkdir(join(testRoot, "views"), { recursive: true });

    // Add sample files
    await writeFile(join(testRoot, "tasks", "backlog", "TASK-001.md"), createSampleTask("001"));
    await writeFile(join(testRoot, "events", "event.json"), '{"type": "test"}');
    await writeFile(join(testRoot, "state", "state.db"), "dummy");
    await writeFile(join(testRoot, "views", "view.md"), "# View");

    const result = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.migratedDirs).toEqual(
      expect.arrayContaining(["tasks", "events", "state", "views"])
    );

    // Verify all directories migrated
    const inboxPath = join(testRoot, "Projects", "_inbox");
    const inboxContents = await readdir(inboxPath);
    expect(inboxContents).toContain("tasks");
    expect(inboxContents).toContain("events");
    expect(inboxContents).toContain("state");
    expect(inboxContents).toContain("views");

    // Verify events directory was created (special case)
    const eventsPath = join(inboxPath, "events");
    const eventsExists = await directoryExists(eventsPath);
    expect(eventsExists).toBe(true);
  });

  it("dry-run mode reports actions without making changes", async () => {
    // Create legacy tasks
    const tasksPath = join(testRoot, "tasks", "backlog");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(join(tasksPath, "TASK-001.md"), createSampleTask("001"));

    const result = await migrateToProjects(testRoot, {
      dryRun: true,
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.migratedDirs).toContain("tasks");

    // Verify nothing was actually changed
    const legacyTasksExist = await directoryExists(join(testRoot, "tasks"));
    expect(legacyTasksExist).toBe(true);

    const inboxExists = await directoryExists(join(testRoot, "Projects", "_inbox"));
    expect(inboxExists).toBe(false);

    const backupExists = await directoryExists(
      join(testRoot, "tasks.backup-2026-01-15T12-00-00-000Z")
    );
    expect(backupExists).toBe(false);
  });

  it("is safe to re-run after successful migration (no legacy dirs remain)", async () => {
    // Create legacy tasks
    const tasksPath = join(testRoot, "tasks", "backlog");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(join(tasksPath, "TASK-001.md"), createSampleTask("001"));

    // First migration
    const result1 = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });
    expect(result1.success).toBe(true);
    expect(result1.updatedTaskCount).toBe(1);

    // Verify legacy dirs were moved to backup
    const legacyTasksGone = !(await directoryExists(join(testRoot, "tasks")));
    expect(legacyTasksGone).toBe(true);

    // Second migration (should be no-op since no legacy dirs remain)
    const result2 = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T13-00-00-000Z",
    });
    expect(result2.success).toBe(true);
    expect(result2.warnings).toContain(
      "Already migrated: no legacy dirs and _inbox exists"
    );
    expect(result2.updatedTaskCount).toBe(0);

    // Verify no duplicate tasks
    const inboxTasksPath = join(testRoot, "Projects", "_inbox", "tasks", "backlog");
    const inboxTasks = await readdir(inboxTasksPath);
    expect(inboxTasks).toHaveLength(1);
  });

  it("preserves task body and adds project field without schema validation", async () => {
    // Create a legacy task with minimal/incomplete frontmatter
    const tasksPath = join(testRoot, "tasks", "backlog");
    await mkdir(tasksPath, { recursive: true });

    const minimalTask = `---
id: TASK-2026-01-01-001
title: Minimal Task
status: backlog
---

## Instructions
This is a minimal task without all required fields.
`;

    await writeFile(join(tasksPath, "TASK-2026-01-01-001.md"), minimalTask);

    const result = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.updatedTaskCount).toBe(1);

    // Verify migrated task has project field added
    const migratedTaskPath = join(
      testRoot,
      "Projects",
      "_inbox",
      "tasks",
      "backlog",
      "TASK-2026-01-01-001.md"
    );
    const migratedContent = await readFile(migratedTaskPath, "utf-8");
    const frontmatter = extractFrontmatter(migratedContent);

    expect(frontmatter.project).toBe("_inbox");
    expect(frontmatter.id).toBe("TASK-2026-01-01-001");
    expect(frontmatter.title).toBe("Minimal Task");

    // Verify body preserved
    expect(migratedContent).toContain("## Instructions");
    expect(migratedContent).toContain("This is a minimal task without all required fields.");
  });

  it("preserves task companion directories and non-md files", async () => {
    // Create legacy task with companion directories and various file types
    const taskDir = join(testRoot, "tasks", "ready", "TASK-2026-01-01-001");
    await mkdir(join(taskDir, "inputs"), { recursive: true });
    await mkdir(join(taskDir, "outputs"), { recursive: true });
    await mkdir(join(taskDir, "work"), { recursive: true });

    // Create task card (no project field)
    const taskCard = createSampleTask("001");
    await writeFile(join(testRoot, "tasks", "ready", "TASK-2026-01-01-001.md"), taskCard);

    // Create companion files with various types
    await writeFile(join(taskDir, "inputs", "requirements.json"), '{"key": "value"}');
    await writeFile(join(taskDir, "outputs", "result.json"), '{"status": "complete"}');
    
    // Nested .md file with legacy project field (should NOT be modified)
    const nestedMd = `---
project: legacy
type: handoff
---

## Handoff Notes
This nested markdown has a project field that should remain unchanged.
`;
    await writeFile(join(taskDir, "outputs", "notes.md"), nestedMd);
    await writeFile(join(taskDir, "work", "scratch.txt"), "Work notes");

    // Run migration
    const result = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.updatedTaskCount).toBe(1); // Only the top-level task card
    expect(result.skippedTaskCount).toBe(0);

    // Verify task card was updated with project field
    const migratedTaskCard = join(
      testRoot,
      "Projects",
      "_inbox",
      "tasks",
      "ready",
      "TASK-2026-01-01-001.md"
    );
    const cardContent = await readFile(migratedTaskCard, "utf-8");
    const cardFrontmatter = extractFrontmatter(cardContent);
    expect(cardFrontmatter.project).toBe("_inbox");

    // Verify companion directories exist
    const inboxTaskDir = join(testRoot, "Projects", "_inbox", "tasks", "ready", "TASK-2026-01-01-001");
    expect(await directoryExists(join(inboxTaskDir, "inputs"))).toBe(true);
    expect(await directoryExists(join(inboxTaskDir, "outputs"))).toBe(true);
    expect(await directoryExists(join(inboxTaskDir, "work"))).toBe(true);

    // Verify all companion files were copied
    expect(await fileExists(join(inboxTaskDir, "inputs", "requirements.json"))).toBe(true);
    expect(await fileExists(join(inboxTaskDir, "outputs", "result.json"))).toBe(true);
    expect(await fileExists(join(inboxTaskDir, "outputs", "notes.md"))).toBe(true);
    expect(await fileExists(join(inboxTaskDir, "work", "scratch.txt"))).toBe(true);

    // Verify nested .md file was NOT modified (still has project: legacy)
    const nestedContent = await readFile(join(inboxTaskDir, "outputs", "notes.md"), "utf-8");
    const nestedFrontmatter = extractFrontmatter(nestedContent);
    expect(nestedFrontmatter.project).toBe("legacy"); // Should be unchanged!
    expect(nestedContent).toContain("This nested markdown has a project field that should remain unchanged.");

    // Verify non-md files have correct content
    const jsonContent = await readFile(join(inboxTaskDir, "outputs", "result.json"), "utf-8");
    expect(jsonContent).toBe('{"status": "complete"}');
  });

  it("preserves top-level non-md files (updatedTaskCount only counts .md files)", async () => {
    // Create tasks with various non-md files at top level
    await mkdir(join(testRoot, "tasks", "backlog"), { recursive: true });
    await writeFile(join(testRoot, "tasks", "backlog", "TASK-001.md"), createSampleTask("001"));
    await writeFile(join(testRoot, "tasks", "backlog", "README.txt"), "Task backlog readme");
    await writeFile(join(testRoot, "tasks", "backlog", "config.json"), '{"setting": true}');

    const result = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    // Should only count the .md file, not the .txt or .json
    expect(result.updatedTaskCount).toBe(1);

    // Verify non-md files were copied as-is
    const inboxBacklog = join(testRoot, "Projects", "_inbox", "tasks", "backlog");
    expect(await fileExists(join(inboxBacklog, "TASK-001.md"))).toBe(true);
    expect(await fileExists(join(inboxBacklog, "README.txt"))).toBe(true);
    expect(await fileExists(join(inboxBacklog, "config.json"))).toBe(true);

    // Verify content preserved exactly
    const readmeContent = await readFile(join(inboxBacklog, "README.txt"), "utf-8");
    expect(readmeContent).toBe("Task backlog readme");
    
    const configContent = await readFile(join(inboxBacklog, "config.json"), "utf-8");
    expect(configContent).toBe('{"setting": true}');
  });

  it("creates all required directories in _inbox", async () => {
    // Create minimal legacy tasks
    const tasksPath = join(testRoot, "tasks");
    await mkdir(tasksPath, { recursive: true });

    const result = await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);

    // Verify all required directories exist
    const inboxPath = join(testRoot, "Projects", "_inbox");
    const requiredDirs = ["tasks", "artifacts", "state", "views", "cold"];

    for (const dir of requiredDirs) {
      const dirPath = join(inboxPath, dir);
      const exists = await directoryExists(dirPath);
      expect(exists).toBe(true);
    }

    // Verify artifact tiers
    const artifactTiers = ["bronze", "silver", "gold"];
    for (const tier of artifactTiers) {
      const tierPath = join(inboxPath, "artifacts", tier);
      const exists = await directoryExists(tierPath);
      expect(exists).toBe(true);
    }
  });
});

describe("rollbackMigration", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aof-rollback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("restores legacy layout from backup", async () => {
    // Create legacy tasks
    const tasksPath = join(testRoot, "tasks", "backlog");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(join(tasksPath, "TASK-001.md"), createSampleTask("001"));

    // Migrate
    await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    // Verify migration succeeded
    const inboxExists = await directoryExists(join(testRoot, "Projects", "_inbox"));
    expect(inboxExists).toBe(true);

    const legacyTasksGone = !(await directoryExists(join(testRoot, "tasks")));
    expect(legacyTasksGone).toBe(true);

    // Rollback
    const result = await rollbackMigration(testRoot, {
      backupDir: "tasks.backup-2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.restoredDirs).toContain("tasks");

    // Verify legacy layout restored
    const restoredTasksExist = await directoryExists(join(testRoot, "tasks"));
    expect(restoredTasksExist).toBe(true);

    const restoredTaskPath = join(testRoot, "tasks", "backlog", "TASK-001.md");
    const restoredTaskExists = await fileExists(restoredTaskPath);
    expect(restoredTaskExists).toBe(true);
  });

  it("finds latest backup when no explicit backup specified", async () => {
    // Create legacy tasks
    const tasksPath = join(testRoot, "tasks");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(join(tasksPath, "TASK-001.md"), createSampleTask("001"));

    // Migrate twice with different timestamps
    await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    // Manually create an older backup to test "latest" selection
    await mkdir(join(testRoot, "tasks.backup-2026-01-14T10-00-00-000Z"), {
      recursive: true,
    });

    // Rollback without specifying backup (should use latest)
    const result = await rollbackMigration(testRoot);

    expect(result.success).toBe(true);
    expect(result.restoredDirs).toContain("tasks");
  });

  it("dry-run mode reports actions without making changes", async () => {
    // Migrate first
    const tasksPath = join(testRoot, "tasks");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(join(tasksPath, "TASK-001.md"), createSampleTask("001"));

    await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    // Rollback with dry-run
    const result = await rollbackMigration(testRoot, {
      dryRun: true,
      backupDir: "tasks.backup-2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.restoredDirs).toContain("tasks");

    // Verify nothing was actually changed
    const inboxStillExists = await directoryExists(join(testRoot, "Projects", "_inbox"));
    expect(inboxStillExists).toBe(true);

    const tasksNotRestored = !(await directoryExists(join(testRoot, "tasks")));
    expect(tasksNotRestored).toBe(true);
  });

  it("throws error when backup directory not found", async () => {
    await expect(
      rollbackMigration(testRoot, { backupDir: "nonexistent-backup" })
    ).rejects.toThrow("Backup directory not found");
  });

  it("renames _inbox during rollback to avoid conflicts", async () => {
    // Migrate
    const tasksPath = join(testRoot, "tasks");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(join(tasksPath, "TASK-001.md"), createSampleTask("001"));

    await migrateToProjects(testRoot, {
      timestamp: "2026-01-15T12-00-00-000Z",
    });

    // Rollback
    const result = await rollbackMigration(testRoot, {
      backupDir: "tasks.backup-2026-01-15T12-00-00-000Z",
    });

    expect(result.success).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("Renamed _inbox"))).toBe(true);

    // Verify _inbox was renamed
    const inboxGone = !(await directoryExists(join(testRoot, "Projects", "_inbox")));
    expect(inboxGone).toBe(true);
  });
});

// --- Helper Functions ---

function createSampleTask(id: string): string {
  return `---
schemaVersion: 1
id: TASK-2026-01-01-${id}
title: Sample Task ${id}
status: backlog
priority: normal
routing:
  role: swe-backend
createdAt: 2026-01-01T10:00:00Z
updatedAt: 2026-01-01T10:00:00Z
lastTransitionAt: 2026-01-01T10:00:00Z
createdBy: test
dependsOn: []
metadata: {}
---

## Instructions
Sample task body for ${id}.
`;
}

function extractFrontmatter(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  const endIdx = lines.indexOf("---", 1);
  const yamlBlock = lines.slice(1, endIdx).join("\n");
  return parseYaml(yamlBlock) as Record<string, unknown>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
