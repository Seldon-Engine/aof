/**
 * task block command — block a task with a reason.
 * 
 * Transitions task to blocked status and stores the block reason.
 */

import type { ITaskStore } from "../../store/interfaces.js";

export interface TaskBlockOptions {
  reason: string;
}

/**
 * Block a task.
 * 
 * @param store - Task store
 * @param taskId - Task ID to block
 * @param options - Command options
 */
export async function taskBlock(
  store: ITaskStore,
  taskId: string,
  options: TaskBlockOptions
): Promise<void> {
  // Resolve task by prefix
  const task = await store.getByPrefix(taskId);
  
  if (!task) {
    console.error(`❌ Task not found: ${taskId}`);
    process.exitCode = 1;
    return;
  }
  
  const fullId = task.frontmatter.id;
  const currentStatus = task.frontmatter.status;
  
  // Store.block() will throw if already terminal or invalid state, so we can just call it
  try {
    await store.block(fullId, options.reason);
    
    console.log(`✅ Task blocked: ${fullId}`);
    console.log(`   Previous status: ${currentStatus}`);
    console.log(`   Reason: ${options.reason}`);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
