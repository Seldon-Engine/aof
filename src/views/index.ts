export {
  syncMailboxView,
  createMailboxHooks,
} from "./mailbox.js";
export type { MailboxViewOptions, MailboxViewResult, MailboxFolder } from "./mailbox.js";

export {
  syncKanbanView,
  createKanbanHooks,
} from "./kanban.js";
export type { KanbanViewOptions, KanbanViewResult, KanbanSwimlane } from "./kanban.js";

export { ViewWatcher } from "./watcher.js";
export type { WatchEvent, ViewWatcherOptions } from "./watcher.js";

export { parseViewSnapshot } from "./parser.js";
export type {
  ViewSnapshot,
  KanbanSnapshot,
  KanbanColumn,
  TaskSummary,
  MailboxSnapshot,
  MailboxTask,
} from "./parser.js";

export { renderCLI, renderJSON, renderJSONL } from "./renderers.js";
