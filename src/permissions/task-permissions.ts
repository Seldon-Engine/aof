/**
 * Task Permission Enforcement Layer
 * 
 * Wraps ITaskStore with permission checks based on org chart roles:
 * - Workers (regular agents): can only close/update tasks assigned to them, can list/get any task
 * - Orchestrators (team leads): can create, edit, cancel, block/unblock, add/remove deps on any task within their team
 * - Admins (main agent, humans): unrestricted access
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { OrgChart } from "../schemas/org-chart.js";

export type AgentRole = "admin" | "orchestrator" | "worker" | "unknown";

export interface RoleInfo {
  role: AgentRole;
  team?: string;
  orchestratorTeams: string[];
}

/**
 * Determine the role and team of an agent based on the org chart.
 */
export function determineRole(agentId: string, orgChart: OrgChart): RoleInfo {
  // Admins: main agent or any agent matching "human" pattern
  if (agentId === "main" || agentId.toLowerCase().includes("human")) {
    return { role: "admin", orchestratorTeams: [] };
  }

  const agent = orgChart.agents.find(a => a.id === agentId);
  if (!agent) {
    return { role: "unknown", orchestratorTeams: [] };
  }

  // Check if agent is an orchestrator (team lead)
  const orchestratorTeams: string[] = [];
  
  // Check legacy teams
  for (const team of orgChart.teams || []) {
    if (team.lead === agentId) {
      orchestratorTeams.push(team.id);
    }
  }
  
  // Check orgUnits
  for (const unit of orgChart.orgUnits || []) {
    if (unit.leadId === agentId) {
      orchestratorTeams.push(unit.id);
    }
  }

  if (orchestratorTeams.length > 0) {
    return { role: "orchestrator", team: agent.team, orchestratorTeams };
  }

  // Regular worker
  return { role: "worker", team: agent.team, orchestratorTeams: [] };
}

/**
 * Check if an agent has permission to perform an operation on a task.
 */
export function checkPermission(
  operation: string,
  agentId: string,
  task: Task | undefined,
  roleInfo: RoleInfo
): { allowed: boolean; reason?: string } {
  // Admins can do anything
  if (roleInfo.role === "admin") {
    return { allowed: true };
  }

  // Unknown agents are denied everything except list/get
  if (roleInfo.role === "unknown") {
    if (operation === "list" || operation === "get") {
      return { allowed: true };
    }
    return { allowed: false, reason: `Agent ${agentId} is not found in the org chart` };
  }

  // Operations that don't require a task (list, create)
  if (operation === "list") {
    return { allowed: true };
  }

  if (operation === "create") {
    // Only orchestrators and admins can create tasks
    if (roleInfo.role === "orchestrator") {
      return { allowed: true };
    }
    return { allowed: false, reason: `Agent ${agentId} cannot create tasks: only team orchestrators can create tasks` };
  }

  // Operations that require a task
  if (!task) {
    return { allowed: false, reason: "Task not found" };
  }

  const taskTeam = task.frontmatter.routing.team;
  const taskAssignee = task.frontmatter.routing.agent || task.frontmatter.lease?.agent;

  // Workers can only close or update tasks assigned to them
  if (roleInfo.role === "worker") {
    if (operation === "get") {
      return { allowed: true };
    }

    if (operation === "close" || operation === "update" || operation === "updateBody") {
      if (taskAssignee === agentId) {
        return { allowed: true };
      }
      return { 
        allowed: false, 
        reason: `Agent ${agentId} cannot ${operation} task ${task.frontmatter.id}: task is assigned to ${taskAssignee || "no one"}` 
      };
    }

    return { 
      allowed: false, 
      reason: `Agent ${agentId} cannot ${operation} task ${task.frontmatter.id}: workers can only close or update their own tasks` 
    };
  }

  // Orchestrators can do anything within their team
  if (roleInfo.role === "orchestrator") {
    // Get operation is allowed for any task
    if (operation === "get") {
      return { allowed: true };
    }

    // Check if the task is within any of the orchestrator's teams
    if (taskTeam && roleInfo.orchestratorTeams.includes(taskTeam)) {
      return { allowed: true };
    }

    // If task has no team, check if it's assigned to someone in their team
    if (!taskTeam && taskAssignee) {
      // This requires loading the org chart again to check assignee's team
      // For now, we'll allow orchestrators to manage unassigned tasks
      return { allowed: true };
    }

    return { 
      allowed: false, 
      reason: `Agent ${agentId} cannot ${operation} task ${task.frontmatter.id}: not the orchestrator for team ${taskTeam || "unassigned"}` 
    };
  }

  return { allowed: false, reason: "Unknown role" };
}

/**
 * Permission-aware wrapper around ITaskStore.
 * Checks permissions before delegating to the underlying store.
 */
export class PermissionAwareTaskStore implements ITaskStore {
  constructor(
    private readonly store: ITaskStore,
    private readonly orgChart: OrgChart,
    private readonly agentId: string
  ) {}

  get projectRoot(): string {
    return this.store.projectRoot;
  }

  get projectId(): string {
    return this.store.projectId;
  }

  get tasksDir(): string {
    return this.store.tasksDir;
  }

  async init(): Promise<void> {
    return this.store.init();
  }

  async create(opts: {
    title: string;
    body?: string;
    priority?: string;
    routing?: { role?: string; team?: string; agent?: string; tags?: string[] };
    sla?: { maxInProgressMs?: number; onViolation?: "alert" | "block" | "deadletter" };
    metadata?: Record<string, unknown>;
    createdBy: string;
    parentId?: string;
    dependsOn?: string[];
  }): Promise<Task> {
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("create", this.agentId, undefined, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.create(opts);
  }

  async get(id: string): Promise<Task | undefined> {
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const task = await this.store.get(id);
    
    if (!task) {
      return undefined;
    }

    const check = checkPermission("get", this.agentId, task, roleInfo);
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return task;
  }

  async getByPrefix(prefix: string): Promise<Task | undefined> {
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const task = await this.store.getByPrefix(prefix);
    
    if (!task) {
      return undefined;
    }

    const check = checkPermission("get", this.agentId, task, roleInfo);
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return task;
  }

  async list(filters?: {
    status?: TaskStatus;
    agent?: string;
    team?: string;
  }): Promise<Task[]> {
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("list", this.agentId, undefined, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.list(filters);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("list", this.agentId, undefined, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.countByStatus();
  }

  async transition(
    id: string,
    newStatus: TaskStatus,
    opts?: { reason?: string; agent?: string }
  ): Promise<Task> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    
    // Special case: transition to "done" is treated as "close"
    const operation = newStatus === "done" ? "close" : "transition";
    const check = checkPermission(operation, this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.transition(id, newStatus, opts);
  }

  async cancel(id: string, reason?: string): Promise<Task> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("cancel", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.cancel(id, reason);
  }

  async updateBody(id: string, body: string): Promise<Task> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("updateBody", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.updateBody(id, body);
  }

  async update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      priority?: string;
      routing?: {
        role?: string;
        team?: string;
        agent?: string;
        tags?: string[];
      };
    }
  ): Promise<Task> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("update", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.update(id, patch);
  }

  async delete(id: string): Promise<boolean> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("delete", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.delete(id);
  }

  async lint(): Promise<Array<{ task: Task; issue: string }>> {
    // Lint is a read-only operation, allow for all
    return this.store.lint();
  }

  async getTaskInputs(id: string): Promise<string[]> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("get", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.getTaskInputs(id);
  }

  async getTaskOutputs(id: string): Promise<string[]> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("get", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.getTaskOutputs(id);
  }

  async writeTaskOutput(id: string, filename: string, content: string): Promise<void> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("update", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.writeTaskOutput(id, filename, content);
  }

  async addDep(taskId: string, blockerId: string): Promise<Task> {
    const task = await this.store.get(taskId);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("addDep", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.addDep(taskId, blockerId);
  }

  async removeDep(taskId: string, blockerId: string): Promise<Task> {
    const task = await this.store.get(taskId);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("removeDep", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.removeDep(taskId, blockerId);
  }

  async block(id: string, reason: string): Promise<Task> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("block", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.block(id, reason);
  }

  async unblock(id: string): Promise<Task> {
    const task = await this.store.get(id);
    const roleInfo = determineRole(this.agentId, this.orgChart);
    const check = checkPermission("unblock", this.agentId, task, roleInfo);
    
    if (!check.allowed) {
      throw new Error(check.reason || "Permission denied");
    }

    return this.store.unblock(id);
  }
}
