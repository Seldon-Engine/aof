/**
 * Callback delivery helper — safe wrapper around deliverCallbacks + deliverAllGranularityCallbacks.
 *
 * Provides deliverAllCallbacksSafely() which constructs SubscriptionStore internally,
 * calls both delivery functions, and swallows+logs any errors independently.
 * Single canonical callback delivery function (REF-04).
 */

import { join } from "node:path";
import { createLogger } from "../logging/index.js";
import { deliverCallbacks, deliverAllGranularityCallbacks } from "./callback-delivery.js";
import { SubscriptionStore } from "../store/subscription-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { GatewayAdapter } from "./executor.js";
import type { EventLogger } from "../events/logger.js";

const log = createLogger("callback-helpers");

/** Parameters for deliverAllCallbacksSafely. */
export interface CallbackDeliveryParams {
  taskId: string;
  store: ITaskStore;
  executor: GatewayAdapter;
  logger: EventLogger;
}

/**
 * Safely deliver all callbacks for a task.
 *
 * - Constructs SubscriptionStore internally from store.tasksDir.
 * - Calls deliverCallbacks + deliverAllGranularityCallbacks sequentially.
 * - Each call has its own try/catch — failures are logged at warn, never thrown.
 * - SubscriptionStore construction failure is also caught gracefully.
 */
export async function deliverAllCallbacksSafely(params: CallbackDeliveryParams): Promise<void> {
  const { taskId, store, executor, logger } = params;

  let subscriptionStore: SubscriptionStore;
  try {
    const tasksDir = store.tasksDir;
    const taskDirResolver = async (tid: string): Promise<string> => {
      const t = await store.get(tid);
      if (!t) throw new Error(`Task not found: ${tid}`);
      return join(tasksDir, t.frontmatter.status, tid);
    };
    subscriptionStore = new SubscriptionStore(taskDirResolver);
  } catch (err) {
    log.warn({ err, taskId, op: "subscriptionStoreInit" }, "SubscriptionStore construction failed (best-effort)");
    return;
  }

  const callbackOpts = {
    taskId,
    store,
    subscriptionStore,
    executor,
    logger,
  };

  try {
    await deliverCallbacks(callbackOpts);
  } catch (err) {
    log.warn({ err, taskId, op: "deliverCallbacks" }, "callback delivery failed (best-effort)");
  }

  // GRAN-02: Deliver all-granularity callbacks (separate try/catch per DLVR-04)
  try {
    await deliverAllGranularityCallbacks(callbackOpts);
  } catch (err) {
    log.warn({ err, taskId, op: "deliverAllGranularityCallbacks" }, "all-granularity callback delivery failed (best-effort)");
  }
}
