import { CONFIG } from "../config.js";
import { saveBossification } from "../db.js";
import { validateEntropy, formatEntropyError } from "../entropy.js";
import {
  isGitRepo,
  getCurrentBranch,
  hasParent,
  getCommitIdentity,
  getParentHash,
  getAuthorString,
  getAuthorTime,
  getHead,
  amendCommit,
} from "../git.js";
import { ensureInstanceRunning, runMiner } from "../gcp.js";
import { templateVariations } from "../template.js";

// =============================================================================
// Boss Command
// =============================================================================

export async function boss(template: string): Promise<void> {
  // Validate git state
  if (!(await isGitRepo())) {
    console.error("❌ Not in a git repository");
    process.exit(1);
  }

  const branch = await getCurrentBranch();
  if (!branch) {
    console.error("❌ Must be on a branch (not detached HEAD)");
    process.exit(1);
  }

  if (!(await hasParent())) {
    console.error("❌ Need at least 2 commits (current commit has no parent)");
    process.exit(1);
  }

  // Get commit info
  const commitIdentity = await getCommitIdentity();
  const parentHash = await getParentHash();
  const author = await getAuthorString();
  const { timestamp, timezone } = await getAuthorTime();

  // Validate entropy locally
  const variations = templateVariations(template);
  const validation = validateEntropy(variations);

  if (!validation.valid) {
    console.error(formatEntropyError(validation));
    process.exit(2);
  }

  // Save to database (will be overwritten if same commit bossed again)
  saveBossification(commitIdentity, template);

  // Print info
  console.log(`🎯 Target: ${CONFIG.target}`);
  console.log(`📝 Template: ${template}`);
  console.log(`🌳 Tree: ${commitIdentity.treeHash}`);
  console.log(`👆 Parent: ${parentHash}`);
  console.log(`👤 Author: ${author}`);
  console.log(`⏰ Time: ${timestamp} ${timezone}`);
  console.log(
    `🎲 Entropy: ${validation.entropyBits.toFixed(1)} bits (${variations.toLocaleString()} variations)`
  );
  console.log();

  // Ensure instance is running
  await ensureInstanceRunning();

  // Mine
  console.log("⛏️  Mining...");
  console.log();

  const result = await runMiner({
    template,
    treeHash: commitIdentity.treeHash,
    parentHash,
    author,
    timestamp,
    timezone,
  });

  if (!result.success) {
    console.error(`❌ Mining failed: ${result.error}`);
    process.exit(1);
  }

  // Amend commit
  console.log();
  console.log("📝 Amending commit...");
  await amendCommit(result.message!, timestamp, timezone);

  // Verify
  const newHash = await getHead();
  console.log();
  console.log("✅ Done!");
  console.log(`   Hash: ${newHash}`);

  if (newHash.startsWith(CONFIG.target)) {
    console.log("   🎉 Vanity hash achieved!");
  } else {
    console.log("   ⚠️  Hash doesn't match target (check timestamps)");
  }
}

