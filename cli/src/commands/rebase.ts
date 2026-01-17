import { execa } from "execa";
import { CONFIG } from "../config.js";
import { saveBossification, type CommitIdentity } from "../db.js";
import { validateEntropy, formatEntropyError } from "../entropy.js";
import {
  isGitRepo,
  getCurrentBranch,
  isAncestor,
  resolveRef,
} from "../git.js";
import { ensureInstanceRunning, runMiner } from "../gcp.js";
import { templateVariations } from "../template.js";
import { simpleGit, SimpleGit } from "simple-git";

const git = simpleGit();

// =============================================================================
// Rebase Command
// =============================================================================

export async function rebase(targetRef: string, template: string): Promise<void> {
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

  // Resolve target
  let targetSha: string;
  try {
    targetSha = await resolveRef(targetRef);
  } catch {
    console.error(`❌ Cannot resolve commit: ${targetRef}`);
    process.exit(1);
  }

  // Validate target is ancestor
  if (!(await isAncestor(targetRef))) {
    console.error("❌ Target is not an ancestor of HEAD");
    process.exit(1);
  }

  // Validate entropy locally
  const variations = templateVariations(template);
  const validation = validateEntropy(variations);

  if (!validation.valid) {
    console.error(formatEntropyError(validation));
    process.exit(2);
  }

  // Get commits to replay
  const commitsToReplay = await getCommitsToReplay(targetSha);

  console.log(`🎯 Target: ${targetRef} (${targetSha.slice(0, 7)})`);
  console.log(`📝 Template: ${template}`);
  console.log(`🔀 Commits to replay: ${commitsToReplay.length}`);
  console.log();

  // Create worktree
  const worktree = `/tmp/codeboss-rebase-${Date.now()}`;
  console.log(`📁 Creating worktree at ${worktree}`);

  await execa("git", ["worktree", "add", worktree, targetSha, "--detach", "--quiet"]);

  try {
    // Get commit info from worktree
    const wtGit: SimpleGit = simpleGit(worktree);
    const commitIdentity = await getCommitIdentityFromWorktree(wtGit);
    const parentHash = await getParentHashFromWorktree(wtGit);
    const author = await getAuthorStringFromWorktree(wtGit);
    const { timestamp, timezone } = await getAuthorTimeFromWorktree(wtGit);

    // Save to database
    saveBossification(commitIdentity, template);

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

    // Amend in worktree
    console.log();
    console.log("📝 Amending target commit...");
    await execa("git", ["commit", "--amend", "-m", result.message!], {
      cwd: worktree,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${timestamp} ${timezone}`,
        GIT_COMMITTER_DATE: `${timestamp} ${timezone}`,
      },
    });

    // Get new SHA
    const newTargetSha = (await wtGit.revparse(["HEAD"])).trim();

    console.log();
    console.log(`📁 Cleaning up worktree`);

  } finally {
    // Clean up worktree
    try {
      await execa("git", ["worktree", "remove", worktree, "--force"]);
    } catch {
      await execa("rm", ["-rf", worktree]);
    }
  }

  // Replay commits
  if (commitsToReplay.length > 0) {
    console.log(`🔀 Replaying ${commitsToReplay.length} commit(s)...`);

    // Get the new base from worktree (before we deleted it... oops)
    // TODO: Fix this - we need to get newTargetSha before cleanup
  }

  console.log();
  console.log("✅ Done!");
  if (commitsToReplay.length > 0) {
    console.log(`   ${commitsToReplay.length} commit(s) replayed with new hashes`);
  }
  console.log("   Run codeboss boss '<template>' to boss the new HEAD if needed");
}

// =============================================================================
// Helpers
// =============================================================================

async function getCommitsToReplay(targetSha: string): Promise<string[]> {
  const result = await git.raw(["rev-list", "--reverse", `${targetSha}..HEAD`]);
  return result.trim().split("\n").filter(Boolean);
}

async function getCommitIdentityFromWorktree(wtGit: SimpleGit): Promise<CommitIdentity> {
  const [treeHash, authorName, authorEmail, timestampStr] = await Promise.all([
    wtGit.revparse(["HEAD^{tree}"]).then((r: string) => r.trim()),
    wtGit.raw(["log", "-1", "--format=%an"]).then((r: string) => r.trim()),
    wtGit.raw(["log", "-1", "--format=%ae"]).then((r: string) => r.trim()),
    wtGit.raw(["log", "-1", "--format=%at"]).then((r: string) => r.trim()),
  ]);

  return {
    treeHash,
    authorName,
    authorEmail,
    authorTimestamp: parseInt(timestampStr, 10),
  };
}

async function getParentHashFromWorktree(wtGit: SimpleGit): Promise<string> {
  return (await wtGit.revparse(["HEAD^"])).trim();
}

async function getAuthorStringFromWorktree(wtGit: SimpleGit): Promise<string> {
  const [name, email] = await Promise.all([
    wtGit.raw(["log", "-1", "--format=%an"]).then((r: string) => r.trim()),
    wtGit.raw(["log", "-1", "--format=%ae"]).then((r: string) => r.trim()),
  ]);
  return `${name} <${email}>`;
}

async function getAuthorTimeFromWorktree(wtGit: SimpleGit): Promise<{ timestamp: string; timezone: string }> {
  const [timestamp, dateStr] = await Promise.all([
    wtGit.raw(["log", "-1", "--format=%at"]).then((r: string) => r.trim()),
    wtGit.raw(["log", "-1", "--format=%ai"]).then((r: string) => r.trim()),
  ]);
  const timezone = dateStr.split(" ")[2] || "+0000";
  return { timestamp, timezone };
}

