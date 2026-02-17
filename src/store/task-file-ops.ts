/**
 * Task file I/O operations.
 * 
 * Functions for reading and writing task input/output directories.
 * Extracted from FilesystemTaskStore to keep it under size limits.
 */

import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { Task, TaskStatus } from "../schemas/task.js";

/**
 * Task getter function type - abstracts store's get() method.
 */
export type TaskGetter = (id: string) => Promise<Task | undefined>;

/**
 * Task directory resolver function type - abstracts store's taskDir() method.
 */
export type TaskDirResolver = (id: string, status: TaskStatus) => string;

/**
 * List all files in the task's inputs/ directory.
 * Returns empty array if task or directory doesn't exist.
 * 
 * @param id - Task ID
 * @param getTask - Function to fetch task by ID
 * @param taskDir - Function to get task directory path
 * @returns Array of input filenames
 */
export async function getTaskInputs(
  id: string,
  getTask: TaskGetter,
  taskDir: TaskDirResolver,
): Promise<string[]> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const inputsDir = join(taskDir(id, task.frontmatter.status), "inputs");
  try {
    const entries = await readdir(inputsDir);
    return entries.filter(entry => entry !== "." && entry !== "..");
  } catch {
    return [];
  }
}

/**
 * List all files in the task's outputs/ directory.
 * Returns empty array if task or directory doesn't exist.
 * 
 * @param id - Task ID
 * @param getTask - Function to fetch task by ID
 * @param taskDir - Function to get task directory path
 * @returns Array of output filenames
 */
export async function getTaskOutputs(
  id: string,
  getTask: TaskGetter,
  taskDir: TaskDirResolver,
): Promise<string[]> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const outputsDir = join(taskDir(id, task.frontmatter.status), "outputs");
  try {
    const entries = await readdir(outputsDir);
    return entries.filter(entry => entry !== "." && entry !== "..");
  } catch {
    return [];
  }
}

/**
 * Write a file to the task's outputs/ directory.
 * Creates the outputs directory if it doesn't exist.
 * 
 * @param id - Task ID
 * @param filename - Output filename
 * @param content - File content
 * @param getTask - Function to fetch task by ID
 * @param taskDir - Function to get task directory path
 */
export async function writeTaskOutput(
  id: string,
  filename: string,
  content: string,
  getTask: TaskGetter,
  taskDir: TaskDirResolver,
): Promise<void> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const outputsDir = join(taskDir(id, task.frontmatter.status), "outputs");
  await mkdir(outputsDir, { recursive: true });
  
  const filePath = join(outputsDir, filename);
  await writeFileAtomic(filePath, content);
}
