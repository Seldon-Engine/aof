import type { ViewSnapshot, WatchEvent, KanbanSnapshot, MailboxSnapshot } from "./parser.js";

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

export function renderCLI(snapshot: ViewSnapshot): string {
  if (snapshot.viewType === "kanban") {
    return renderKanbanCLI(snapshot.data as KanbanSnapshot, snapshot.timestamp);
  } else {
    return renderMailboxCLI(snapshot.data as MailboxSnapshot, snapshot.timestamp);
  }
}

export function renderJSON(snapshot: ViewSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function renderJSONL(event: WatchEvent, snapshot?: ViewSnapshot): string {
  if (snapshot) {
    return JSON.stringify({ event, snapshot }) + "\n";
  } else {
    return JSON.stringify(event) + "\n";
  }
}

function renderKanbanCLI(data: KanbanSnapshot, timestamp: string): string {
  const lines: string[] = [];

  // Header
  const date = formatTimestamp(timestamp);
  lines.push("");
  lines.push(`${colors.bold}${colors.cyan}📋 AOF Kanban${colors.reset} — ${colors.dim}${date}${colors.reset}`);
  lines.push("");

  // Render each column with tasks
  for (const column of data.columns) {
    if (column.count === 0) continue;

    const icon = getColumnIcon(column.name);
    const header = `${icon} ${colors.bold}${column.name.toUpperCase()}${colors.reset} ${colors.gray}(${column.count})${colors.reset}`;
    lines.push(header);

    for (const task of column.tasks) {
      const taskId = truncateId(task.id);
      const priority = task.priority ? formatPriority(task.priority) : "";
      const assignee = task.assignee ? `${colors.dim}@${task.assignee}${colors.reset}` : "";
      
      const parts = [
        `  ${colors.cyan}${taskId}${colors.reset}`,
        `${colors.bold}${task.title}${colors.reset}`,
        assignee,
        priority,
      ].filter(Boolean);

      lines.push(parts.join("  "));
    }

    lines.push("");
  }

  // Footer
  lines.push(`${colors.dim}Total: ${data.totalTasks} tasks${colors.reset}`);
  lines.push("");

  return lines.join("\n");
}

function renderMailboxCLI(data: MailboxSnapshot, timestamp: string): string {
  const lines: string[] = [];

  // Header
  const date = formatTimestamp(timestamp);
  lines.push("");
  lines.push(`${colors.bold}${colors.magenta}📬 Mailbox: ${data.agentId}${colors.reset} — ${colors.dim}${date}${colors.reset}`);
  lines.push("");

  // Inbox
  lines.push(`${colors.bold}📥 INBOX${colors.reset} ${colors.gray}(${data.inbox.length})${colors.reset}`);
  for (const task of data.inbox) {
    const taskId = truncateId(task.id);
    const from = task.from ? `${colors.dim}from: ${task.from}${colors.reset}` : "";
    
    const parts = [
      `  ${colors.cyan}${taskId}${colors.reset}`,
      `${colors.bold}${task.title}${colors.reset}`,
      from,
    ].filter(Boolean);

    lines.push(parts.join("  "));
  }
  lines.push("");

  // Processing
  lines.push(`${colors.bold}⚙️  PROCESSING${colors.reset} ${colors.gray}(${data.processing.length})${colors.reset}`);
  for (const task of data.processing) {
    const taskId = truncateId(task.id);
    lines.push(`  ${colors.cyan}${taskId}${colors.reset}  ${colors.bold}${task.title}${colors.reset}`);
  }
  lines.push("");

  // Outbox
  lines.push(`${colors.bold}📤 OUTBOX${colors.reset} ${colors.gray}(${data.outbox.length})${colors.reset}`);
  for (const task of data.outbox) {
    const taskId = truncateId(task.id);
    const to = task.to ? `${colors.dim}to: ${task.to}${colors.reset}` : "";
    
    const parts = [
      `  ${colors.cyan}${taskId}${colors.reset}`,
      `${colors.bold}${task.title}${colors.reset}`,
      to,
    ].filter(Boolean);

    lines.push(parts.join("  "));
  }
  lines.push("");

  return lines.join("\n");
}

function getColumnIcon(columnName: string): string {
  const icons: Record<string, string> = {
    backlog: "📋",
    ready: "🎯",
    "in-progress": "🚧",
    blocked: "🚫",
    review: "👀",
    done: "✅",
  };

  return icons[columnName] ?? "📁";
}

function formatPriority(priority: string): string {
  const upper = priority.toUpperCase();
  
  switch (upper) {
    case "CRITICAL":
      return `${colors.red}${colors.bold}CRITICAL${colors.reset}`;
    case "HIGH":
      return `${colors.yellow}${colors.bold}HIGH${colors.reset}`;
    case "NORMAL":
      return `${colors.blue}NORMAL${colors.reset}`;
    case "LOW":
      return `${colors.gray}LOW${colors.reset}`;
    default:
      return `${colors.dim}${upper}${colors.reset}`;
  }
}

function truncateId(id: string): string {
  if (id.length <= 10) return id;
  return id.slice(0, 10);
}

function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    
    // Format as: 2026-02-07 19:45 EST
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");

    // Get timezone abbreviation (simple approach)
    const tzOffset = -date.getTimezoneOffset();
    const tzHours = Math.floor(Math.abs(tzOffset) / 60);
    const tzString = `UTC${tzOffset >= 0 ? "+" : "-"}${tzHours}`;

    return `${year}-${month}-${day} ${hours}:${minutes} ${tzString}`;
  } catch {
    return isoString;
  }
}
