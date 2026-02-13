/**
 * AOF Packaging — dependency management and installation
 */

export { install, update, list } from "./installer.js";
export type { InstallOptions, InstallResult, PackageInfo } from "./installer.js";

export { runWizard, detectOpenClaw } from "./wizard.js";
export type { WizardOptions, WizardResult, OpenClawDetectionResult } from "./wizard.js";

export { integrateWithOpenClaw, detectOpenClawConfig } from "./integration.js";
export type { IntegrationOptions, IntegrationResult, DetectionResult } from "./integration.js";

export { selfUpdate, rollbackUpdate } from "./updater.js";
export type { UpdateOptions, UpdateResult, UpdateHooks, RollbackOptions, RollbackResult } from "./updater.js";

export { runMigrations, registerMigration, getMigrationHistory } from "./migrations.js";
export type { Migration, MigrationContext, MigrationHistory, MigrationHistoryEntry, RunMigrationsOptions, RunMigrationsResult } from "./migrations.js";
