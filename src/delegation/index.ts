import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep, dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { stringify as stringifyYaml } from "yaml";
import type { Task } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { TaskStoreHooks } from "../store/task-store.js";
import type { HandoffRequestPayload } from "../schemas/protocol.js";

export interface DelegationSyncResult {
  parents: string[];
  pointerCount: number;
  removedCount: number;
  handoffCount: number;
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function resolveAssignedAgent(task: Task): string | undefined {
  if (task.frontmatter.lease?.agent) return task.frontmatter.lease.agent;
  if (task.frontmatter.routing.agent) return task.frontmatter.routing.agent;
  const assignee = task.frontmatter.metadata?.assignee;
  return typeof assignee === "string" ? assignee : undefined;
}

function resolveTaskPath(task: Task, store: ITaskStore): string {
  if (task.path) return task.path;
  return join(store.tasksDir, task.frontmatter.status, `${task.frontmatter.id}.md`);
}

function resolveTaskDir(task: Task, store: ITaskStore): string {
  const taskPath = resolveTaskPath(task, store);
  return join(dirname(taskPath), task.frontmatter.id);
}

function renderSubtaskPointer(
  task: Task,
  parentId: string,
  canonicalTaskPath: string,
  handoffPath: string,
): string {
  const frontmatter = {
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    status: task.frontmatter.status,
    priority: task.frontmatter.priority,
    agent: resolveAssignedAgent(task),
    parentId,
  };
  const yaml = stringifyYaml(frontmatter, { lineWidth: 120 }).trimEnd();
  return `---\n${yaml}\n---\n\n# ${task.frontmatter.title}\nTask: ${canonicalTaskPath}\nHandoff: ${handoffPath}\n`;
}

function renderHandoffPointer(
  task: Task,
  parent: Task,
  parentPath: string,
  outputPath: string,
  taskPath: string,
): string {
  const frontmatter = {
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    status: task.frontmatter.status,
    parentId: parent.frontmatter.id,
  };
  const yaml = stringifyYaml(frontmatter, { lineWidth: 120 }).trimEnd();
  return `---\n${yaml}\n---\n\n# Handoff\nParent: ${parentPath}\nTask: ${taskPath}\nOutput: ${outputPath}\n`;
}

async function writeIfChanged(filePath: string, contents: string): Promise<void> {
  try {
    const existing = await readFile(filePath, "utf-8");
    if (existing === contents) return;
  } catch {
    // Missing or unreadable — overwrite below.
  }

  await writeFileAtomic(filePath, contents);
}

async function pruneDir(dir: string, keep: Set<string>): Promise<number> {
  let removed = 0;
  let entries: string[] = [];

  try {
    entries = await readdir(dir);
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (keep.has(entry)) continue;
    await rm(join(dir, entry), { force: true });
    removed += 1;
  }

  return removed;
}

export function renderHandoffMarkdown(payload: HandoffRequestPayload): string {
  const sections: string[] = [];

  sections.push("# Handoff Request");
  sections.push("");
  sections.push(`**From:** ${payload.fromAgent}`);
  sections.push(`**To:** ${payload.toAgent}`);
  sections.push(`**Due By:** ${payload.dueBy}`);
  sections.push("");

  sections.push("## Acceptance Criteria");
  sections.push("");
  if (payload.acceptanceCriteria.length === 0) {
    sections.push("None");
  } else {
    for (const criterion of payload.acceptanceCriteria) {
      sections.push(`- ${criterion}`);
    }
  }
  sections.push("");

  sections.push("## Expected Outputs");
  sections.push("");
  if (payload.expectedOutputs.length === 0) {
    sections.push("None");
  } else {
    for (const output of payload.expectedOutputs) {
      sections.push(`- ${output}`);
    }
  }
  sections.push("");

  sections.push("## Context References");
  sections.push("");
  if (payload.contextRefs.length === 0) {
    sections.push("None");
  } else {
    for (const ref of payload.contextRefs) {
      sections.push(`- ${ref}`);
    }
  }
  sections.push("");

  sections.push("## Constraints");
  sections.push("");
  if (payload.constraints.length === 0) {
    sections.push("None");
  } else {
    for (const constraint of payload.constraints) {
      sections.push(`- ${constraint}`);
    }
  }
  sections.push("");

  return sections.join("\n");
}

export async function writeHandoffArtifacts(
  store: ITaskStore,
  childTask: Task,
  payload: HandoffRequestPayload,
): Promise<void> {
  const childDir = resolveTaskDir(childTask, store);
  const inputsDir = join(childDir, "inputs");
  await mkdir(inputsDir, { recursive: true });

  const jsonPath = join(inputsDir, "handoff.json");
  const mdPath = join(inputsDir, "handoff.md");

  await writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2));
  await writeFileAtomic(mdPath, renderHandoffMarkdown(payload));
}

export async function syncDelegationArtifacts(
  store: ITaskStore,
): Promise<DelegationSyncResult> {
  const tasks = await store.list();
  const tasksById = new Map(tasks.map(task => [task.frontmatter.id, task]));
  const childrenByParent = new Map<string, Task[]>();

  for (const task of tasks) {
    const parentId = task.frontmatter.parentId;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(task);
    childrenByParent.set(parentId, list);
  }

  let pointerCount = 0;
  let removedCount = 0;
  let handoffCount = 0;

  for (const [parentId, children] of childrenByParent) {
    const parent = tasksById.get(parentId);
    if (!parent) continue;

    const parentDir = resolveTaskDir(parent, store);
    const subtasksDir = join(parentDir, "subtasks");
    await mkdir(subtasksDir, { recursive: true });

    const keep = new Set<string>();

    for (const child of children) {
      const fileName = `${child.frontmatter.id}.md`;
      keep.add(fileName);

      const childTaskPath = resolveTaskPath(child, store);
      const childDir = resolveTaskDir(child, store);
      const handoffPath = join(childDir, "handoff.md");

      const canonicalTaskRel = toPosixPath(relative(subtasksDir, childTaskPath));
      const handoffRel = toPosixPath(relative(subtasksDir, handoffPath));
      const pointerContents = renderSubtaskPointer(child, parentId, canonicalTaskRel, handoffRel);
      await writeIfChanged(join(subtasksDir, fileName), pointerContents);
      pointerCount += 1;

      const parentTaskPath = resolveTaskPath(parent, store);
      const parentRel = toPosixPath(relative(childDir, parentTaskPath));
      const outputRel = toPosixPath(relative(childDir, join(childDir, "output")));
      const childTaskRel = toPosixPath(relative(childDir, childTaskPath));
      const handoffContents = renderHandoffPointer(child, parent, parentRel, outputRel, childTaskRel);
      await writeIfChanged(handoffPath, handoffContents);
      handoffCount += 1;
    }

    removedCount += await pruneDir(subtasksDir, keep);
  }

  return {
    parents: Array.from(childrenByParent.keys()).sort(),
    pointerCount,
    removedCount,
    handoffCount,
  };
}

export function createDelegationHooks(getStore: () => ITaskStore): TaskStoreHooks {
  return {
    afterTransition: async () => {
      await syncDelegationArtifacts(getStore());
    },
  };
}
