/**
 * task unblock command — unblock a task.
 * 
 * Transitions task from blocked to ready and clears the block reason.
 */

import type { ITaskStore } from "../../store/interfaces.js";

/**
 * Unblock a task.
 * 
 * @param store - Task store
 * @param taskId - Task ID to unblock
 */
export async function taskUnblock(
  store: ITaskStore,
  taskId: string
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
  
  // Store.unblock() will throw if not currently blocked, so we can just call it
  try {
    await store.unblock(fullId);
    
    console.log(`✅ Task unblocked: ${fullId}`);
    console.log(`   Previous status: ${currentStatus}`);
    console.log(`   Now ready for dispatch`);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
