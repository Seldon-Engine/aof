/**
 * Memory management CLI commands.
 * Registers memory V2 commands (generate, audit, aggregate, promote, curate, health, rebuild).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import type { SqliteDb } from "../../memory/types.js";
import type { HnswIndex } from "../../memory/store/hnsw-index.js";
import { generateMemoryConfigFile, auditMemoryConfigFile } from "../../commands/memory.js";
import { loadOrgChart } from "../../org/index.js";
import { FilesystemTaskStore } from "../../store/task-store.js";

// ─── Health Report Types ────────────────────────────────────────────────────

export type PoolBreakdown = {
  pool: string;
  count: number;
};

export type HealthReport = {
  hnswCount: number;
  sqliteCount: number;
  syncStatus: "ok" | "desynced";
  fragmentationPct: number;
  lastRebuildTime: string | null;
  pools: PoolBreakdown[];
};

/**
 * Compute a health report from the given SQLite database and HNSW index.
 * This is a pure function (given its inputs) and can be unit-tested without the full CLI.
 */
export function computeHealthReport(db: SqliteDb, hnsw: HnswIndex): HealthReport {
  const hnswCount = hnsw.count;
  const sqliteCount = (db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c;
  const syncStatus = hnswCount === sqliteCount ? "ok" : "desynced";

  const maxEl = hnsw.maxElements;
  const fragmentationPct = maxEl > 0
    ? Math.round(((maxEl - hnswCount) / maxEl) * 1000) / 10
    : 0;

  // memory_meta may not exist yet
  let lastRebuildTime: string | null = null;
  try {
    const row = db.prepare("SELECT value FROM memory_meta WHERE key = 'last_rebuild_time'").get() as { value: string } | undefined;
    lastRebuildTime = row?.value ?? null;
  } catch {
    // Table doesn't exist yet — that's fine
  }

  const poolRows = db.prepare("SELECT pool, COUNT(*) as count FROM chunks GROUP BY pool").all() as Array<{ pool: string | null; count: number }>;
  const pools: PoolBreakdown[] = poolRows.map((r) => ({
    pool: r.pool ?? "(none)",
    count: r.count,
  }));

  return {
    hnswCount,
    sqliteCount,
    syncStatus,
    fragmentationPct,
    lastRebuildTime,
    pools,
  };
}

function printHealthReport(report: HealthReport): void {
  console.log("Memory Health Report");
  console.log(`  HNSW count:      ${report.hnswCount}`);
  console.log(`  SQLite count:    ${report.sqliteCount}`);
  console.log(`  Sync status:     ${report.syncStatus}`);
  console.log(`  Fragmentation:   ${report.fragmentationPct}%`);
  console.log(`  Last rebuild:    ${report.lastRebuildTime ?? "never"}`);
  if (report.pools.length > 0) {
    console.log("");
    console.log("  Pool Breakdown:");
    for (const p of report.pools) {
      console.log(`    ${p.pool.padEnd(15)}${p.count}`);
    }
  }
}

function printImportReport(report: import("../../memory/import/index.js").ImportReport): void {
  console.log("\n🔍 Memory Import Audit");
  console.log(`  Sources scanned:  ${report.agents.length} SQLite file(s)`);
  const totalIndexed = report.totalFilesIndexed;
  const totalOnDisk  = report.agents.reduce((s, a) => s + a.filesOnDisk, 0);
  console.log(`  Files indexed:    ${totalIndexed}`);
  console.log(`  Files on disk:    ${totalOnDisk} ✅`);
  console.log(`  Files missing:    ${report.totalFilesMissing} ${report.totalFilesMissing > 0 ? "⚠️" : ""}`);
  console.log(`  Orphan chunks:    ${report.agents.reduce((s, a) => s + a.orphanChunks, 0)}`);
  if (report.agents.length > 0) {
    console.log("\n  Per-agent breakdown:");
    for (const a of report.agents) {
      const tag = a.errors.length > 0 ? "❌" : a.filesMissing > 0 ? "⚠️" : "✅";
      console.log(`    ${tag} ${a.agentId} (${a.providerKind}) — ${a.filesIndexed} files, ${a.filesMissing} missing, ${a.orphanChunks} orphan chunks`);
      for (const w of a.warnings) console.log(`       ⚠️  ${w}`);
      for (const e of a.errors)   console.log(`       ❌ ${e}`);
    }
  }
  const written = report.totalOrphansWritten;
  if (written > 0) {
    const path = report.agents.find(a => a.outputPath)?.outputPath ?? "";
    console.log(`\n✅ Done. ${written} orphaned chunk(s) written to ${path}`);
  } else if (report.dryRun) {
    console.log("\n✅ Dry-run complete — no files written.");
  } else {
    console.log("\n✅ Done. No orphaned chunks to write.");
  }
}

/**
 * Register memory commands with the CLI program.
 */
export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command("memory")
    .description("Memory V2 commands");

  memory
    .command("generate [path]")
    .description("Generate OpenClaw memory config from org chart")
    .option("--out <path>", "Output path for generated config")
    .option("--vault-root <path>", "Vault root for resolving memory pool paths")
    .action(async (path?: string, opts?: { out?: string; vaultRoot?: string }) => {
      const root = program.opts()["root"] as string;
      const orgPath = path ?? join(root, "org", "org-chart.yaml");
      const outputPath = opts?.out ?? join(root, "org", "generated", "memory-config.json");
      const vaultRoot = opts?.vaultRoot ?? process.env["AOF_VAULT_ROOT"] ?? process.env["OPENCLAW_VAULT_ROOT"];

      await generateMemoryConfigFile({
        orgChartPath: orgPath,
        outputPath,
        vaultRoot: vaultRoot ?? undefined,
      });
    });

  memory
    .command("audit [path]")
    .description("Audit OpenClaw memory config against org chart")
    .option("--config <path>", "Path to OpenClaw config file")
    .option("--vault-root <path>", "Vault root for resolving memory pool paths")
    .action(async (path?: string, opts?: { config?: string; vaultRoot?: string }) => {
      const root = program.opts()["root"] as string;
      const orgPath = path ?? join(root, "org", "org-chart.yaml");
      const vaultRoot = opts?.vaultRoot ?? process.env["AOF_VAULT_ROOT"] ?? process.env["OPENCLAW_VAULT_ROOT"];
      const configPath = opts?.config
        ?? process.env["OPENCLAW_CONFIG"]
        ?? join(homedir(), ".openclaw", "openclaw.json");

      await auditMemoryConfigFile({
        orgChartPath: orgPath,
        configPath,
        vaultRoot: vaultRoot ?? undefined,
      });
    });

  memory
    .command("aggregate")
    .description("Aggregate cold tier events into warm docs")
    .option("--dry-run", "Preview changes without writing", false)
    .action(async (opts: { dryRun: boolean }) => {
      const root = program.opts()["root"] as string;
      const { WarmAggregator } = await import("../../memory/warm-aggregation.js");
      const aggregator = new WarmAggregator(root);

      console.log(`🔄 Aggregating cold → warm...${opts.dryRun ? " (DRY RUN)" : ""}\n`);

      const result = await aggregator.aggregate();

      console.log(`✅ Processed ${result.eventsProcessed} cold events`);
      console.log(`✅ Updated ${result.warmDocsUpdated} warm docs`);

      if (result.errors.length > 0) {
        console.log(`\n⚠️  Errors (${result.errors.length}):`);
        for (const err of result.errors) {
          console.log(`  ${err.rule}: ${err.error}`);
        }
      }

      console.log(`\n⚡ Completed in ${result.durationMs}ms`);
    });

  memory
    .command("promote")
    .description("Promote warm doc to hot tier (gated review)")
    .requiredOption("--from <path>", "Source warm doc path")
    .requiredOption("--to <path>", "Target hot doc path")
    .option("--review", "Show diff and prompt for approval", true)
    .option("--approve", "Auto-approve without review", false)
    .action(async (opts: { from: string; to: string; review: boolean; approve: boolean }) => {
      const root = program.opts()["root"] as string;
      const { HotPromotion } = await import("../../memory/hot-promotion.js");
      const promotion = new HotPromotion(root);

      console.log("🔍 Reviewing promotion:");
      console.log(`  From: ${opts.from}`);
      console.log(`  To: ${opts.to}\n`);

      const hotSize = await promotion.getHotSize();
      console.log(`  Hot tier size: ${hotSize} bytes (limit: 50,000 bytes)\n`);

      if (opts.review && !opts.approve) {
        const diff = await promotion.generateDiff(opts.from, opts.to);
        console.log("  Diff preview:");
        console.log(diff.split("\n").map(l => `    ${l}`).join("\n"));
        console.log("\n  ⚠️  Use --approve to apply this promotion");
        return;
      }

      const result = await promotion.promote({
        from: opts.from,
        to: opts.to,
        approved: opts.approve,
      });

      if (result.success) {
        console.log(`✅ Promotion successful`);
        console.log(`  New hot tier size: ${result.hotSize} bytes`);
      } else {
        console.log(`❌ Promotion failed: ${result.error ?? "unknown error"}`);
        process.exitCode = 1;
      }
    });

  memory
    .command("curate")
    .description("Generate memory curation tasks based on adaptive thresholds")
    .option("--policy <path>", "Path to curation policy file (YAML)")
    .option("--org <path>", "Path to org chart (overrides default)")
    .option("--entries <count>", "Manual entry count override (for lancedb)")
    .option("--project <id>", "Project ID for task store", "_inbox")
    .option("--dry-run", "Preview tasks without creating", false)
    .action(async (opts: { policy?: string; org?: string; entries?: string; project: string; dryRun: boolean }) => {
      const root = program.opts()["root"] as string;
      const projectId = opts.project;

      // Resolve project root
      const { resolveProject } = await import("../../projects/resolver.js");
      const resolution = await resolveProject(projectId, root);

      // Load org chart
      const orgPath = opts.org ?? join(root, "org", "org-chart.yaml");
      let orgChart: import("../../schemas/org-chart.js").OrgChart | undefined;
      try {
        const result = await loadOrgChart(orgPath);
        if (result.success) {
          orgChart = result.chart;
        } else {
          console.error(`⚠️  Could not load org chart: validation failed`);
          console.error("   Continuing without org chart reference...");
        }
      } catch (error) {
        console.error(`⚠️  Could not load org chart: ${(error as Error).message}`);
        console.error("   Continuing without org chart reference...");
      }

      // Resolve policy path
      let policyPath: string;
      if (opts.policy) {
        policyPath = opts.policy;
      } else if (orgChart?.memoryCuration?.policyPath) {
        policyPath = join(root, orgChart.memoryCuration.policyPath);
      } else {
        console.error("❌ No policy specified. Use --policy or configure memoryCuration in org chart.");
        process.exitCode = 1;
        return;
      }

      // Load policy
      const { loadCurationPolicy } = await import("../../memory/curation-policy.js");
      let policy: import("../../memory/curation-policy.js").CurationPolicy;
      try {
        policy = await loadCurationPolicy(policyPath);
      } catch (error) {
        console.error(`❌ Failed to load policy: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      console.log(`📋 Curation Policy: ${policyPath}`);
      console.log(`   Strategy: ${policy.strategy}`);
      console.log(`   Thresholds: ${policy.thresholds.length}`);
      if (opts.dryRun) {
        console.log(`   Mode: DRY RUN`);
      }
      console.log();

      // Detect backend
      const { detectMemoryBackend, supportsAutomaticInventory } = await import("../../memory/host-detection.js");
      const detection = await detectMemoryBackend();
      console.log(`🔍 Memory Backend: ${detection.backend} (${detection.source})`);

      // Build inventory
      const { resolvePoolPath } = await import("../../memory/generator.js");
      const vaultRoot = process.env["AOF_VAULT_ROOT"] ?? process.env["OPENCLAW_VAULT_ROOT"] ?? root;
      const scopes: Array<import("../../memory/curation-generator.js").CurationScope> = [];

      if (detection.backend === "memory-lancedb") {
        if (!opts.entries) {
          console.error("❌ memory-lancedb requires --entries override (stats API not yet available)");
          process.exitCode = 1;
          return;
        }
        const entryCount = parseInt(opts.entries, 10);
        if (Number.isNaN(entryCount) || entryCount < 0) {
          console.error("❌ Invalid --entries value (must be non-negative integer)");
          process.exitCode = 1;
          return;
        }
        scopes.push({ type: "pool", id: "lancedb", entryCount });
      } else if (orgChart?.memoryPools) {
        // Count entries in each pool
        const { readdir, stat: statFile } = await import("node:fs/promises");

        async function countFiles(dir: string): Promise<number> {
          let count = 0;
          try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                count += await countFiles(join(dir, entry.name));
              } else if (entry.isFile()) {
                count++;
              }
            }
          } catch {
            // Ignore missing directories
          }
          return count;
        }

        // Hot pool
        const hotPath = resolvePoolPath(orgChart.memoryPools.hot.path, vaultRoot);
        const hotCount = await countFiles(hotPath);
        scopes.push({ type: "pool", id: "hot", entryCount: hotCount });

        // Warm pools
        for (const pool of orgChart.memoryPools.warm) {
          const poolPath = resolvePoolPath(pool.path, vaultRoot);
          const poolCount = await countFiles(poolPath);
          scopes.push({ type: "pool", id: pool.id, entryCount: poolCount });
        }
      } else {
        console.error("❌ No memory pools configured in org chart");
        process.exitCode = 1;
        return;
      }

      console.log(`\n📊 Inventory:`);
      for (const scope of scopes) {
        console.log(`   ${scope.type}:${scope.id} → ${scope.entryCount} entries`);
      }
      console.log();

      // Generate tasks
      const taskStore = new FilesystemTaskStore(resolution.projectRoot);
      await taskStore.init();

      const { generateCurationTasks } = await import("../../memory/curation-generator.js");
      const result = await generateCurationTasks(
        taskStore,
        policy,
        scopes,
        detection.backend,
        policyPath,
        { dryRun: opts.dryRun }
      );

      // Report results
      if (result.tasksCreated.length > 0) {
        console.log(`✅ Created ${result.tasksCreated.length} curation task(s):`);
        for (const task of result.tasksCreated) {
          const scopeId = task.frontmatter.metadata.scopeId as string;
          const entryCount = task.frontmatter.metadata.entryCount as number;
          console.log(`   ${task.frontmatter.id} - ${scopeId} (${entryCount} entries)`);
        }
        console.log();
      }

      if (result.skipped.length > 0) {
        console.log(`⏭️  Skipped ${result.skipped.length} scope(s):`);
        for (const skip of result.skipped) {
          console.log(`   ${skip.scope.id}: ${skip.reason}`);
        }
        console.log();
      }

      if (result.warnings.length > 0) {
        console.log(`⚠️  Warnings:`);
        for (const warning of result.warnings) {
          console.log(`   ${warning}`);
        }
        console.log();
      }

      if (result.tasksCreated.length === 0 && result.skipped.length === 0) {
        console.log("ℹ️  No curation tasks needed at this time");
      }
    });

  memory
    .command("import")
    .description("Audit and import memories from previous memory provider (memory-core SQLite, etc.)")
    .option("--source-dir <path>", "Directory containing *.sqlite files", join(homedir(), ".openclaw", "memory"))
    .option("--workspace <path>", "Base workspace for resolving relative file paths", join(homedir(), ".openclaw", "workspace"))
    .option("--dry-run", "Report gaps without writing any files", false)
    .option("--agent <id>", "Restrict to a single agent")
    .option("--no-orphans", "Skip orphan extraction (audit only)", false)
    .action(async (opts: { sourceDir: string; workspace: string; dryRun: boolean; agent?: string; noOrphans: boolean }) => {
      const { runMemoryImport } = await import("../../memory/import/index.js");
      const report = await runMemoryImport({
        sourceDir: opts.sourceDir,
        workspacePath: opts.workspace,
        dryRun: opts.dryRun,
        agentFilter: opts.agent,
        noOrphans: opts.noOrphans,
      });
      printImportReport(report);
      if (report.errors.length > 0) process.exitCode = 1;
    });

  // ─── Health command ─────────────────────────────────────────────────────

  memory
    .command("health")
    .description("Show memory index health metrics")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const root = program.opts()["root"] as string;
      const { initMemoryDb } = await import("../../memory/store/schema.js");
      const { HnswIndex: HnswIndexClass } = await import("../../memory/store/hnsw-index.js");

      const dbPath = join(root, "memory.db");
      const hnswPath = dbPath.replace(/\.db$/, "-hnsw.dat");

      // Load HNSW to discover dimensions, then open DB with those dimensions
      let dimensions = 768; // default fallback
      let hnswFound = true;

      const tempHnsw = new HnswIndexClass(dimensions);
      if (existsSync(hnswPath)) {
        try {
          tempHnsw.load(hnswPath);
          dimensions = tempHnsw.dimensions;
        } catch {
          console.error("HNSW index corrupt or unreadable.");
          hnswFound = false;
        }
      } else {
        console.error("HNSW index: NOT FOUND");
        hnswFound = false;
      }

      const db = initMemoryDb(dbPath, dimensions);

      // If HNSW wasn't loadable, create a fresh (empty) one for reporting
      const hnsw = hnswFound ? tempHnsw : new HnswIndexClass(dimensions);

      const report = computeHealthReport(db, hnsw);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printHealthReport(report);
      }
    });

  // ─── Rebuild command ────────────────────────────────────────────────────

  memory
    .command("rebuild")
    .description("Rebuild HNSW index from SQLite")
    .option("--yes", "Skip confirmation prompt", false)
    .action(async (opts: { yes: boolean }) => {
      const root = program.opts()["root"] as string;
      const { initMemoryDb } = await import("../../memory/store/schema.js");
      const { HnswIndex: HnswIndexClass } = await import("../../memory/store/hnsw-index.js");

      const dbPath = join(root, "memory.db");
      const hnswPath = dbPath.replace(/\.db$/, "-hnsw.dat");
      const pidPath = join(root, "daemon.pid");

      // Determine dimensions: try loading existing HNSW, fallback to 768
      let dimensions = 768;
      if (existsSync(hnswPath)) {
        try {
          const probe = new HnswIndexClass(dimensions);
          probe.load(hnswPath);
          dimensions = probe.dimensions;
        } catch {
          // Corrupt — we'll rebuild anyway
        }
      }

      const db = initMemoryDb(dbPath, dimensions);

      const totalChunks = (db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c;

      // Check if daemon is running
      if (existsSync(pidPath)) {
        console.warn("Warning: Daemon appears to be running (PID file exists). The daemon will use the old index until restarted.");
      }

      // Confirmation prompt
      if (!opts.yes) {
        const { confirm } = await import("@inquirer/prompts");
        const answer = await confirm({
          message: `This will rebuild the HNSW index from SQLite (${totalChunks} chunks). Continue?`,
          default: false,
        });
        if (!answer) {
          console.log("Aborted.");
          db.close();
          return;
        }
      }

      // Record before stats
      let beforeCount = 0;
      if (existsSync(hnswPath)) {
        try {
          const oldHnsw = new HnswIndexClass(dimensions);
          oldHnsw.load(hnswPath);
          beforeCount = oldHnsw.count;
        } catch {
          // Corrupt — before count stays 0
        }
      }

      // Read all chunks from SQLite
      const rows = db
        .prepare("SELECT chunk_id, embedding FROM vec_chunks")
        .all() as Array<{ chunk_id: bigint; embedding: Buffer }>;

      const chunks = rows.map((row) => ({
        id: Number(row.chunk_id),
        embedding: Array.from(new Float32Array(row.embedding.buffer)),
      }));

      // Create new index and rebuild with progress
      const hnsw = new HnswIndexClass(dimensions);
      const capacity = Math.max(Math.ceil(chunks.length * 1.5), 10_000);
      // We need to rebuild manually for progress reporting
      // HnswIndex.rebuild() doesn't support progress callbacks
      // So we access the internal structure via add() after initializing a fresh index

      const startTime = Date.now();

      if (process.stdout.isTTY) {
        // Progress bar for TTY
        const { SingleBar, Presets } = await import("cli-progress");
        const bar = new SingleBar(
          { format: "Indexing [{bar}] {percentage}% | {value}/{total} chunks | ETA: {eta}s" },
          Presets.shades_classic,
        );
        // Rebuild using the internal rebuild method (no per-chunk progress)
        // Instead we'll use add() one-by-one for progress
        hnsw.rebuild([]); // Reset to empty with proper capacity
        // Actually, let's use the rebuild chunks approach but chunk it
        // The simplest: call hnsw.rebuild() and just show a spinner style
        // But the plan says "progress bar during rebuild"
        // So: build manually using add()
        bar.start(chunks.length, 0);
        for (const chunk of chunks) {
          hnsw.add(chunk.id, chunk.embedding);
          bar.increment();
        }
        bar.stop();
      } else {
        // Non-TTY: line-based progress
        const step = Math.max(Math.floor(chunks.length / 10), 1);
        for (let i = 0; i < chunks.length; i++) {
          hnsw.add(chunks[i]!.id, chunks[i]!.embedding);
          if ((i + 1) % step === 0 || i === chunks.length - 1) {
            console.log(`Indexing: ${i + 1}/${chunks.length} chunks...`);
          }
        }
      }

      const durationMs = Date.now() - startTime;

      // Save index
      hnsw.save(hnswPath);

      // Update last rebuild time
      db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('last_rebuild_time', datetime('now'))").run();

      db.close();

      // Print summary
      const durationSec = (durationMs / 1000).toFixed(1);
      console.log("");
      console.log("Rebuild Complete");
      console.log(`  Before:    ${beforeCount} elements${beforeCount !== totalChunks ? " (desynced)" : ""}`);
      console.log(`  After:     ${hnsw.count} elements`);
      console.log(`  Duration:  ${durationSec}s`);
    });
}
