import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

export interface WatchEvent {
  type: "add" | "change" | "remove";
  path: string;
  viewType: "kanban" | "mailbox" | "generic";
  timestamp: string;
}

export interface ViewSnapshot {
  viewType: "kanban" | "mailbox";
  timestamp: string;
  data: KanbanSnapshot | MailboxSnapshot;
}

export interface KanbanSnapshot {
  columns: KanbanColumn[];
  totalTasks: number;
}

export interface KanbanColumn {
  name: string;
  tasks: TaskSummary[];
  count: number;
}

export interface TaskSummary {
  id: string;
  title: string;
  assignee?: string;
  priority?: string;
}

export interface MailboxSnapshot {
  agentId: string;
  inbox: MailboxTask[];
  processing: MailboxTask[];
  outbox: MailboxTask[];
}

export interface MailboxTask {
  id: string;
  title: string;
  from?: string;
  to?: string;
}

const KANBAN_COLUMNS = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
] as const;

const MAILBOX_FOLDERS = ["inbox", "processing", "outbox"] as const;

export async function parseViewSnapshot(
  viewDir: string,
  viewType: "kanban" | "mailbox"
): Promise<ViewSnapshot> {
  // Verify directory exists
  try {
    const stats = await stat(viewDir);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${viewDir}`);
    }
  } catch (error) {
    throw new Error(`Cannot read view directory: ${(error as Error).message}`);
  }

  if (viewType === "kanban") {
    const data = await parseKanbanView(viewDir);
    return {
      viewType: "kanban",
      timestamp: new Date().toISOString(),
      data,
    };
  } else if (viewType === "mailbox") {
    const data = await parseMailboxView(viewDir);
    return {
      viewType: "mailbox",
      timestamp: new Date().toISOString(),
      data,
    };
  } else {
    throw new Error(`Invalid view type: ${viewType}`);
  }
}

async function parseKanbanView(viewDir: string): Promise<KanbanSnapshot> {
  const columns: KanbanColumn[] = [];
  let totalTasks = 0;

  for (const columnName of KANBAN_COLUMNS) {
    const columnDir = join(viewDir, columnName);
    const tasks = await parseTasksInDirectory(columnDir);

    columns.push({
      name: columnName,
      tasks,
      count: tasks.length,
    });

    totalTasks += tasks.length;
  }

  return { columns, totalTasks };
}

async function parseMailboxView(viewDir: string): Promise<MailboxSnapshot> {
  // Extract agent ID from path
  const agentId = basename(viewDir);

  const inbox = await parseMailboxTasks(join(viewDir, "inbox"));
  const processing = await parseMailboxTasks(join(viewDir, "processing"));
  const outbox = await parseMailboxTasks(join(viewDir, "outbox"));

  return {
    agentId,
    inbox,
    processing,
    outbox,
  };
}

async function parseTasksInDirectory(dir: string): Promise<TaskSummary[]> {
  const tasks: TaskSummary[] = [];

  try {
    const entries = await readdir(dir);

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const filePath = join(dir, entry);
      const task = await parseTaskFile(filePath);
      if (task) {
        tasks.push(task);
      }
    }
  } catch {
    // Directory doesn't exist or is inaccessible - return empty
  }

  return tasks;
}

async function parseMailboxTasks(dir: string): Promise<MailboxTask[]> {
  const tasks: MailboxTask[] = [];

  try {
    const entries = await readdir(dir);

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const filePath = join(dir, entry);
      const task = await parseMailboxTaskFile(filePath);
      if (task) {
        tasks.push(task);
      }
    }
  } catch {
    // Directory doesn't exist or is inaccessible - return empty
  }

  return tasks;
}

async function parseTaskFile(filePath: string): Promise<TaskSummary | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const frontmatter = extractFrontmatter(content);

    if (!frontmatter || !frontmatter.id || !frontmatter.title) {
      return null;
    }

    return {
      id: frontmatter.id,
      title: frontmatter.title,
      assignee: frontmatter.agent || frontmatter.assignee,
      priority: frontmatter.priority,
    };
  } catch {
    return null;
  }
}

async function parseMailboxTaskFile(filePath: string): Promise<MailboxTask | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const frontmatter = extractFrontmatter(content);

    if (!frontmatter || !frontmatter.id || !frontmatter.title) {
      return null;
    }

    return {
      id: frontmatter.id,
      title: frontmatter.title,
      from: frontmatter.from,
      to: frontmatter.to,
    };
  } catch {
    return null;
  }
}

function extractFrontmatter(content: string): any {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return null;

  try {
    return parseYaml(match[1]);
  } catch {
    return null;
  }
}
