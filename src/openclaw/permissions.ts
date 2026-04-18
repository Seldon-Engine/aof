/**
 * withPermissions() Higher-Order Function for OpenClaw tool handlers.
 *
 * Wraps a framework-agnostic tool handler with actor/project extraction,
 * permission-aware store resolution, and result formatting. Eliminates
 * all `(params as any)` casts from OpenClaw adapter tool registration.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { ToolContext } from "../tools/aof-tools.js";
import type { EventLogger } from "../events/logger.js";
import type { ToolResult } from "./types.js";

type ToolHandler = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;
type ResolveProjectStore = (projectId?: string) => Promise<ITaskStore>;
type GetStoreForActor = (actor?: string, baseStore?: ITaskStore) => Promise<ITaskStore>;

/**
 * Wrap a tool handler with actor/project extraction and permission resolution.
 *
 * Returns an OpenClaw-compatible execute function that:
 * 1. Extracts `actor` and `project` from params (typed, no `as any`)
 * 2. Resolves the project-scoped store
 * 3. Gets a permission-aware store for the actor
 * 4. Calls the handler with a ToolContext and the remaining params
 * 5. Wraps the result in OpenClaw's content array format
 */
export function withPermissions(
  handler: ToolHandler,
  resolveProjectStore: ResolveProjectStore,
  getStoreForActor: GetStoreForActor,
  logger: EventLogger,
  orgChartPath?: string,
): (id: string, params: Record<string, unknown>) => Promise<ToolResult> {
  return async (_id: string, params: Record<string, unknown>): Promise<ToolResult> => {
    const actor = params.actor as string | undefined;
    const projectId = params.project as string | undefined;

    const projectStore = await resolveProjectStore(projectId);
    const permissionStore = await getStoreForActor(actor, projectStore);

    const ctx: ToolContext = {
      store: permissionStore,
      logger,
      // BUG-044: coerce null (unscoped store) to undefined to satisfy
      // ToolContext's `string | undefined` shape.
      projectId: projectId ?? permissionStore.projectId ?? undefined,
      orgChartPath,
    };

    const result = await handler(ctx, params);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  };
}
