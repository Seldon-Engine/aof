/**
 * Task Permission Tests
 * 
 * Tests permission enforcement for:
 * - Workers can close own task
 * - Workers rejected editing other's task
 * - Orchestrators can edit team task
 * - Orchestrators rejected editing other team's task
 * - Admins unrestricted
 * - Unknown agents denied
 */

import { describe, it, expect, beforeEach } from "vitest";
import { determineRole, checkPermission, PermissionAwareTaskStore } from "../task-permissions.js";
import type { OrgChart } from "../../schemas/org-chart.js";
import type { Task } from "../../schemas/task.js";
import type { ITaskStore } from "../../store/interfaces.js";

// Mock task factory
function createMockTask(id: string, team: string, assignee?: string): Task {
  return {
    frontmatter: {
      id,
      title: "Test Task",
      status: "in-progress",
      priority: "normal",
      routing: {
        team,
        agent: assignee,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    body: "Test task body",
    path: `tasks/in-progress/${id}.md`,
  } as Task;
}

// Mock org chart
const mockOrgChart: OrgChart = {
  schemaVersion: 1,
  teams: [
    {
      id: "swe",
      name: "Software Engineering",
      lead: "swe-architect",
    },
    {
      id: "ops",
      name: "Operations",
      lead: "main",
    },
    {
      id: "data",
      name: "Data Engineering",
      lead: "data-lead",
    },
  ],
  agents: [
    {
      id: "main",
      name: "Main Agent",
      team: "ops",
      canDelegate: true,
      capabilities: { tags: [], concurrency: 1 },
      comms: { preferred: "send", fallbacks: [] },
    },
    {
      id: "swe-architect",
      name: "Software Architect",
      team: "swe",
      canDelegate: true,
      capabilities: { tags: [], concurrency: 1 },
      comms: { preferred: "send", fallbacks: [] },
    },
    {
      id: "swe-backend",
      name: "Backend Engineer",
      team: "swe",
      capabilities: { tags: [], concurrency: 1 },
      comms: { preferred: "send", fallbacks: [] },
    },
    {
      id: "swe-frontend",
      name: "Frontend Engineer",
      team: "swe",
      capabilities: { tags: [], concurrency: 1 },
      comms: { preferred: "send", fallbacks: [] },
    },
    {
      id: "data-lead",
      name: "Data Engineering Lead",
      team: "data",
      capabilities: { tags: [], concurrency: 1 },
      comms: { preferred: "send", fallbacks: [] },
    },
  ],
};

describe("determineRole", () => {
  it("should identify main agent as admin", () => {
    const roleInfo = determineRole("main", mockOrgChart);
    expect(roleInfo.role).toBe("admin");
  });

  it("should identify human agents as admin", () => {
    const roleInfo = determineRole("human-operator", mockOrgChart);
    expect(roleInfo.role).toBe("admin");
  });

  it("should identify team leads as orchestrators", () => {
    const roleInfo = determineRole("swe-architect", mockOrgChart);
    expect(roleInfo.role).toBe("orchestrator");
    expect(roleInfo.orchestratorTeams).toContain("swe");
  });

  it("should identify regular agents as workers", () => {
    const roleInfo = determineRole("swe-backend", mockOrgChart);
    expect(roleInfo.role).toBe("worker");
    expect(roleInfo.team).toBe("swe");
  });

  it("should identify unknown agents", () => {
    const roleInfo = determineRole("unknown-agent", mockOrgChart);
    expect(roleInfo.role).toBe("unknown");
  });
});

describe("checkPermission", () => {
  const task = createMockTask("AOF-123", "swe", "swe-backend");

  it("should allow admins to do anything", () => {
    const roleInfo = { role: "admin" as const, orchestratorTeams: [] };
    const check = checkPermission("create", "main", undefined, roleInfo);
    expect(check.allowed).toBe(true);

    const check2 = checkPermission("cancel", "main", task, roleInfo);
    expect(check2.allowed).toBe(true);
  });

  it("should allow workers to list and get tasks", () => {
    const roleInfo = { role: "worker" as const, team: "swe", orchestratorTeams: [] };
    const check = checkPermission("list", "swe-backend", undefined, roleInfo);
    expect(check.allowed).toBe(true);

    const check2 = checkPermission("get", "swe-backend", task, roleInfo);
    expect(check2.allowed).toBe(true);
  });

  it("should allow workers to close their own tasks", () => {
    const roleInfo = { role: "worker" as const, team: "swe", orchestratorTeams: [] };
    const check = checkPermission("close", "swe-backend", task, roleInfo);
    expect(check.allowed).toBe(true);
  });

  it("should allow workers to update their own tasks", () => {
    const roleInfo = { role: "worker" as const, team: "swe", orchestratorTeams: [] };
    const check = checkPermission("update", "swe-backend", task, roleInfo);
    expect(check.allowed).toBe(true);
  });

  it("should deny workers from closing other's tasks", () => {
    const roleInfo = { role: "worker" as const, team: "swe", orchestratorTeams: [] };
    const check = checkPermission("close", "swe-frontend", task, roleInfo);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("task is assigned to swe-backend");
  });

  it("should deny workers from creating tasks", () => {
    const roleInfo = { role: "worker" as const, team: "swe", orchestratorTeams: [] };
    const check = checkPermission("create", "swe-backend", undefined, roleInfo);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("only team orchestrators can create tasks");
  });

  it("should deny workers from canceling tasks", () => {
    const roleInfo = { role: "worker" as const, team: "swe", orchestratorTeams: [] };
    const check = checkPermission("cancel", "swe-backend", task, roleInfo);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("workers can only close or update their own tasks");
  });

  it("should allow orchestrators to edit team tasks", () => {
    const roleInfo = { role: "orchestrator" as const, team: "swe", orchestratorTeams: ["swe"] };
    const check = checkPermission("update", "swe-architect", task, roleInfo);
    expect(check.allowed).toBe(true);

    const check2 = checkPermission("cancel", "swe-architect", task, roleInfo);
    expect(check2.allowed).toBe(true);
  });

  it("should allow orchestrators to create tasks", () => {
    const roleInfo = { role: "orchestrator" as const, team: "swe", orchestratorTeams: ["swe"] };
    const check = checkPermission("create", "swe-architect", undefined, roleInfo);
    expect(check.allowed).toBe(true);
  });

  it("should deny orchestrators from editing other team's tasks", () => {
    const dataTask = createMockTask("AOF-456", "data", "data-engineer");
    const roleInfo = { role: "orchestrator" as const, team: "swe", orchestratorTeams: ["swe"] };
    const check = checkPermission("cancel", "swe-architect", dataTask, roleInfo);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("not the orchestrator for team data");
  });

  it("should deny unknown agents except for list/get", () => {
    const roleInfo = { role: "unknown" as const, orchestratorTeams: [] };
    const check = checkPermission("create", "unknown-agent", undefined, roleInfo);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("not found in the org chart");

    const check2 = checkPermission("list", "unknown-agent", undefined, roleInfo);
    expect(check2.allowed).toBe(true);
  });
});

describe("PermissionAwareTaskStore", () => {
  let mockStore: ITaskStore;
  let backendTask: Task;
  let frontendTask: Task;

  beforeEach(() => {
    backendTask = createMockTask("AOF-001", "swe", "swe-backend");
    frontendTask = createMockTask("AOF-002", "swe", "swe-frontend");

    // Mock store implementation
    mockStore = {
      projectRoot: "/test",
      projectId: "AOF",
      tasksDir: "/test/tasks",
      init: async () => {},
      create: async (opts) => backendTask,
      get: async (id) => {
        if (id === "AOF-001") return backendTask;
        if (id === "AOF-002") return frontendTask;
        return undefined;
      },
      getByPrefix: async (prefix) => {
        if (prefix === "AOF-001") return backendTask;
        if (prefix === "AOF-002") return frontendTask;
        return undefined;
      },
      list: async () => [backendTask, frontendTask],
      countByStatus: async () => ({ "in-progress": 2 }),
      transition: async (id, status) => backendTask,
      cancel: async (id) => backendTask,
      updateBody: async (id, body) => backendTask,
      update: async (id, patch) => backendTask,
      delete: async (id) => true,
      lint: async () => [],
      getTaskInputs: async (id) => [],
      getTaskOutputs: async (id) => [],
      writeTaskOutput: async (id, filename, content) => {},
      addDep: async (taskId, blockerId) => backendTask,
      removeDep: async (taskId, blockerId) => backendTask,
      block: async (id, reason) => backendTask,
      unblock: async (id) => backendTask,
    } as ITaskStore;
  });

  it("worker can close their own task", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-backend");
    const result = await store.transition("AOF-001", "done");
    expect(result).toBeDefined();
  });

  it("worker cannot close other's task", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-backend");
    await expect(store.transition("AOF-002", "done")).rejects.toThrow(
      "task is assigned to swe-frontend"
    );
  });

  it("worker can update their own task", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-backend");
    const result = await store.update("AOF-001", { title: "Updated" });
    expect(result).toBeDefined();
  });

  it("worker cannot update other's task", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-frontend");
    await expect(store.update("AOF-001", { title: "Updated" })).rejects.toThrow(
      "task is assigned to swe-backend"
    );
  });

  it("worker cannot create tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-backend");
    await expect(
      store.create({
        title: "New Task",
        createdBy: "swe-backend",
      })
    ).rejects.toThrow("only team orchestrators can create tasks");
  });

  it("worker cannot cancel tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-backend");
    await expect(store.cancel("AOF-001", "Test cancellation")).rejects.toThrow(
      "workers can only close or update their own tasks"
    );
  });

  it("orchestrator can create tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-architect");
    const result = await store.create({
      title: "New Task",
      createdBy: "swe-architect",
    });
    expect(result).toBeDefined();
  });

  it("orchestrator can edit team tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-architect");
    const result = await store.update("AOF-001", { title: "Updated" });
    expect(result).toBeDefined();
  });

  it("orchestrator can cancel team tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-architect");
    const result = await store.cancel("AOF-001", "Cancelled by orchestrator");
    expect(result).toBeDefined();
  });

  it("orchestrator can block team tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-architect");
    const result = await store.block("AOF-001", "Blocked by orchestrator");
    expect(result).toBeDefined();
  });

  it("orchestrator can add dependencies to team tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-architect");
    const result = await store.addDep("AOF-001", "AOF-002");
    expect(result).toBeDefined();
  });

  it("orchestrator cannot edit other team's tasks", async () => {
    // Create a task for the data team
    const dataTask = createMockTask("AOF-999", "data", "data-engineer");
    mockStore.get = async (id) => {
      if (id === "AOF-999") return dataTask;
      if (id === "AOF-001") return backendTask;
      if (id === "AOF-002") return frontendTask;
      return undefined;
    };

    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-architect");
    await expect(store.cancel("AOF-999", "Test")).rejects.toThrow(
      "not the orchestrator for team data"
    );
  });

  it("admin can do anything", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "main");

    // Create
    const created = await store.create({
      title: "Admin Task",
      createdBy: "main",
    });
    expect(created).toBeDefined();

    // Update
    const updated = await store.update("AOF-001", { title: "Updated by admin" });
    expect(updated).toBeDefined();

    // Cancel
    const cancelled = await store.cancel("AOF-001", "Cancelled by admin");
    expect(cancelled).toBeDefined();
  });

  it("unknown agent is denied for operations except list/get", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "unknown-agent");

    // List should work
    const tasks = await store.list();
    expect(tasks).toBeDefined();

    // Get should work
    const task = await store.get("AOF-001");
    expect(task).toBeDefined();

    // Create should fail
    await expect(
      store.create({
        title: "Test",
        createdBy: "unknown-agent",
      })
    ).rejects.toThrow("not found in the org chart");
  });

  it("workers can list all tasks", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-backend");
    const tasks = await store.list();
    expect(tasks).toHaveLength(2);
  });

  it("workers can get any task", async () => {
    const store = new PermissionAwareTaskStore(mockStore, mockOrgChart, "swe-backend");
    const task = await store.get("AOF-002");
    expect(task).toBeDefined();
    expect(task?.frontmatter.id).toBe("AOF-002");
  });
});
