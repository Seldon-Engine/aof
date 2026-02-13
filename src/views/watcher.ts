import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

export interface WatchEvent {
  type: "add" | "change" | "remove";
  path: string;
  viewType: "kanban" | "mailbox" | "generic";
  timestamp: string;
}

export interface ViewWatcherOptions {
  viewDir: string;
  viewType?: "kanban" | "mailbox" | "auto";
  debounceMs?: number;
  onEvent: (event: WatchEvent) => void;
}

export class ViewWatcher {
  private readonly options: Required<ViewWatcherOptions>;
  private watcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pendingPaths = new Set<string>();
  private fileStates = new Map<string, boolean>(); // path -> exists
  private detectedViewType: "kanban" | "mailbox" | "generic" | undefined;

  constructor(options: ViewWatcherOptions) {
    this.options = {
      viewType: options.viewType ?? "auto",
      debounceMs: options.debounceMs ?? 100,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.watcher) {
      throw new Error("Watcher already running");
    }

    // Verify directory exists
    try {
      const stats = await stat(this.options.viewDir);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${this.options.viewDir}`);
      }
    } catch (error) {
      throw new Error(`Cannot watch directory: ${(error as Error).message}`);
    }

    // Auto-detect view type if needed
    if (this.options.viewType === "auto") {
      this.detectedViewType = await this.detectViewType(this.options.viewDir);
    } else {
      this.detectedViewType = this.options.viewType;
    }

    // Initialize file states
    await this.initializeFileStates();

    // Start watching (recursive)
    this.watcher = watch(
      this.options.viewDir,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;

        const fullPath = join(this.options.viewDir, filename);
        
        // Only track .md files
        if (!filename.endsWith(".md")) return;

        this.pendingPaths.add(fullPath);
        this.scheduleFlush();
      }
    );
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }

    this.pendingPaths.clear();
    this.fileStates.clear();
  }

  isRunning(): boolean {
    return this.watcher !== undefined;
  }

  private async detectViewType(dir: string): Promise<"kanban" | "mailbox" | "generic"> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const dirNames = entries
        .filter(e => e.isDirectory())
        .map(e => e.name.toLowerCase());

      // Check for kanban structure
      const kanbanDirs = ["backlog", "ready", "in-progress", "blocked", "review", "done"];
      const hasKanbanDirs = kanbanDirs.some(d => dirNames.includes(d));

      // Check for mailbox structure
      const mailboxDirs = ["inbox", "processing", "outbox"];
      const hasMailboxDirs = mailboxDirs.every(d => dirNames.includes(d));

      if (hasMailboxDirs) {
        return "mailbox";
      } else if (hasKanbanDirs) {
        return "kanban";
      } else {
        return "generic";
      }
    } catch {
      return "generic";
    }
  }

  private async initializeFileStates(): Promise<void> {
    try {
      await this.scanDirectory(this.options.viewDir);
    } catch {
      // Directory might be empty or inaccessible
    }
  }

  private async scanDirectory(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.scanDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          this.fileStates.set(fullPath, true);
        }
      }
    } catch {
      // Ignore errors during scan
    }
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.flushPendingEvents();
    }, this.options.debounceMs);
  }

  private async flushPendingEvents(): Promise<void> {
    const paths = Array.from(this.pendingPaths);
    this.pendingPaths.clear();

    for (const path of paths) {
      await this.processPath(path);
    }
  }

  private async processPath(path: string): Promise<void> {
    const wasKnown = this.fileStates.has(path);
    let exists = false;

    try {
      await stat(path);
      exists = true;
    } catch {
      exists = false;
    }

    let eventType: WatchEvent["type"];

    if (!wasKnown && exists) {
      eventType = "add";
      this.fileStates.set(path, true);
    } else if (wasKnown && !exists) {
      eventType = "remove";
      this.fileStates.delete(path);
    } else if (wasKnown && exists) {
      eventType = "change";
    } else {
      // Unknown and doesn't exist - ignore
      return;
    }

    const event: WatchEvent = {
      type: eventType,
      path,
      viewType: this.detectedViewType!,
      timestamp: new Date().toISOString(),
    };

    this.options.onEvent(event);
  }
}
