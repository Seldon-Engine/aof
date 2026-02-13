/**
 * Projects barrel export.
 */

export { discoverProjects } from "./registry.js";
export type { ProjectRecord, DiscoverOptions } from "./registry.js";

export { bootstrapProject } from "./bootstrap.js";

export { lintProject } from "./lint.js";
export type { LintIssue, LintResult, LintSeverity } from "./lint.js";

export { resolveProject, projectExists } from "./resolver.js";
export type { ProjectResolution } from "./resolver.js";

export { buildProjectManifest, writeProjectManifest } from "./manifest.js";
export type { BuildProjectManifestOptions } from "./manifest.js";

export { migrateToProjects, rollbackMigration } from "./migration.js";
export type {
  MigrationOptions,
  RollbackOptions,
  MigrationResult,
  RollbackResult,
} from "./migration.js";
