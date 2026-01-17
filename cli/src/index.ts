#!/usr/bin/env node

import { program } from "commander";
import { boss } from "./commands/boss.js";
import { rebase } from "./commands/rebase.js";
import { history } from "./commands/history.js";
import { closeDb } from "./db.js";

// =============================================================================
// CLI Definition
// =============================================================================

program
  .name("codeboss")
  .description("Vanity git commit hash miner")
  .version("1.0.0");

program
  .command("boss <template>")
  .description("Make HEAD commit have a vanity hash")
  .action(async (template: string) => {
    try {
      await boss(template);
    } catch (error: any) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command("rebase <commit> <template>")
  .description("Make a commit in the chain have a vanity hash, replaying subsequent commits")
  .requiredOption(
    "--time <mode>",
    "Time handling: 'preserve' keeps original timestamps, 'now' uses current time"
  )
  .action(async (commit: string, template: string, options: { time: string }) => {
    if (options.time !== "preserve" && options.time !== "now") {
      console.error("❌ --time must be 'preserve' or 'now'");
      process.exit(1);
    }
    try {
      await rebase(commit, template, options.time as "preserve" | "now");
    } catch (error: any) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command("history")
  .description("Show bossification history")
  .action(async () => {
    try {
      await history();
    } catch (error: any) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// =============================================================================
// Run
// =============================================================================

program.parse();

