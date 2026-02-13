/**
 * AOF Init Command
 * Interactive installation wizard for new AOF setups.
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { runWizard, detectOpenClaw, type WizardOptions } from "../packaging/wizard.js";

export interface InitOptions {
  /** Installation directory (defaults to ~/Projects/AOF) */
  dir?: string;
  /** Template name (minimal or full) */
  template?: "minimal" | "full";
  /** Non-interactive mode (use defaults) */
  yes?: boolean;
  /** Skip OpenClaw integration check */
  skipOpenclaw?: boolean;
  /** Force overwrite existing installation */
  force?: boolean;
}

/**
 * Run the init command (interactive or non-interactive).
 */
export async function init(options: InitOptions): Promise<void> {
  const {
    dir,
    template,
    yes = false,
    skipOpenclaw = false,
    force = false,
  } = options;

  console.log("🚀 AOF Installation Wizard\n");

  // Non-interactive mode: use provided options or defaults
  if (yes) {
    const installDir = dir ?? resolve(homedir(), "Projects", "AOF");
    const selectedTemplate = template ?? "minimal";

    console.log("Running in non-interactive mode...");
    console.log(`  Install directory: ${installDir}`);
    console.log(`  Template: ${selectedTemplate}`);
    console.log();

    const wizardOpts: WizardOptions = {
      installDir,
      template: selectedTemplate,
      interactive: false,
      skipOpenClaw: skipOpenclaw,
      healthCheck: true,
      force,
    };

    const result = await runWizard(wizardOpts);

    if (result.success) {
      console.log("✅ Installation complete!\n");
      console.log(`Installation directory: ${result.installDir}`);
      console.log(`Org chart: ${result.orgChartPath}`);
      console.log(`\nCreated ${result.created.length} files and directories.`);
      
      if (result.warnings && result.warnings.length > 0) {
        console.log("\n⚠️  Warnings:");
        for (const warning of result.warnings) {
          console.log(`  - ${warning}`);
        }
      }

      console.log("\n📚 Next steps:");
      console.log(`  1. cd ${result.installDir}`);
      console.log("  2. Review org/org-chart.yaml");
      console.log("  3. Run 'aof scan' to verify setup");
    } else {
      console.error("❌ Installation failed");
      process.exit(1);
    }

    return;
  }

  // Interactive mode: prompt for options
  const rl = readline.createInterface({ input, output });

  try {
    // Detect OpenClaw
    if (!skipOpenclaw) {
      const detection = await detectOpenClaw();
      if (detection.detected) {
        console.log(`✅ OpenClaw detected at ${detection.configPath}`);
        if (detection.workspaceDir) {
          console.log(`   Workspace: ${detection.workspaceDir}`);
        }
        console.log();
      }
    }

    // Prompt for installation directory
    const defaultDir = dir ?? resolve(homedir(), "Projects", "AOF");
    const installDirAnswer = await rl.question(
      `Installation directory [${defaultDir}]: `,
    );
    const installDir = installDirAnswer.trim() || defaultDir;

    // Prompt for template
    console.log("\nAvailable templates:");
    console.log("  1. minimal - Single agent, simple setup (recommended for getting started)");
    console.log("  2. full - Multi-agent team with delegation");
    
    const templateAnswer = await rl.question(
      "\nSelect template [1]: ",
    );
    const selectedTemplate = 
      templateAnswer.trim() === "2" ? "full" : "minimal";

    console.log();

    // Confirm and run wizard
    const wizardOpts: WizardOptions = {
      installDir,
      template: selectedTemplate,
      interactive: true,
      skipOpenClaw: skipOpenclaw,
      healthCheck: true,
      force,
    };

    console.log("Starting installation...\n");
    const result = await runWizard(wizardOpts);

    if (result.success) {
      console.log("\n✅ Installation complete!\n");
      console.log(`Installation directory: ${result.installDir}`);
      console.log(`Org chart: ${result.orgChartPath}`);
      console.log(`\nCreated ${result.created.length} files and directories:`);
      
      for (const item of result.created) {
        console.log(`  ✓ ${item}`);
      }

      if (result.warnings && result.warnings.length > 0) {
        console.log("\n⚠️  Warnings:");
        for (const warning of result.warnings) {
          console.log(`  - ${warning}`);
        }
      }

      if (result.openclawDetected) {
        console.log("\n🔗 OpenClaw Integration:");
        console.log("  OpenClaw detected. You can configure AOF to work with OpenClaw agents.");
        console.log("  Edit org/org-chart.yaml to add openclawAgentId fields.");
      }

      console.log("\n📚 Next steps:");
      console.log(`  1. cd ${result.installDir}`);
      console.log("  2. Review org/org-chart.yaml");
      console.log("  3. Create your first task in tasks/ready/");
      console.log("  4. Run 'aof scheduler run' to test the setup");
      console.log("\n📖 Documentation: https://github.com/xavierxeon/aof");
    } else {
      console.error("\n❌ Installation failed");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}
