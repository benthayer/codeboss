import { execa } from "execa";
import { CONFIG } from "../config.js";
import { saveBossification, lookupSavedTemplate, type CommitIdentity } from "../db.js";
import { validateEntropy, formatEntropyError } from "../entropy.js";
import {
  isGitRepo,
  getCurrentBranch,
} from "../git.js";
import { ensureInstanceRunning, runMiner, warmUpInstance } from "../gcp.js";
import { templateVariations } from "../template.js";
import { simpleGit, SimpleGit } from "simple-git";

const git = simpleGit();

// =============================================================================
// Rebase All Command
// =============================================================================

export async function rebaseAll(timeMode: "preserve" | "now"): Promise<void> {
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

  // Start warming up instance in background
  warmUpInstance();

  // Get all commits from oldest to newest
  const allCommits = await getAllCommits();
  
  console.log(`📜 Total commits in history: ${allCommits.length}`);
  console.log(`⏰ Time mode: ${timeMode}`);
  console.log();

  // Find commits that need bossing (don't have c0deb055 prefix)
  const commitsToBoss: { sha: string; template: string }[] = [];
  
  for (const sha of allCommits) {
    if (sha.startsWith(CONFIG.target)) {
      console.log(`✓ ${sha.slice(0, 7)} already bossed`);
      continue;
    }

    const identity = await getCommitIdentityFromRef(sha);
    const saved = lookupSavedTemplate(identity);
    
    if (!saved) {
      console.error(`❌ ${sha.slice(0, 7)} has no saved template - cannot boss`);
      process.exit(1);
    }

    // Validate entropy
    const variations = templateVariations(saved.template);
    const validation = validateEntropy(variations);
    
    if (!validation.valid) {
      console.error(`❌ ${sha.slice(0, 7)} template has insufficient entropy:`);
      console.error(formatEntropyError(validation));
      process.exit(2);
    }

    commitsToBoss.push({ sha, template: saved.template });
  }

  if (commitsToBoss.length === 0) {
    console.log();
    console.log("✅ All commits already bossed!");
    return;
  }

  console.log();
  console.log(`🎯 Commits to boss: ${commitsToBoss.length}`);
  console.log();

  // Ensure instance is running before we start
  await ensureInstanceRunning();

  // Boss each commit from oldest to newest
  for (let i = 0; i < commitsToBoss.length; i++) {
    const { sha, template } = commitsToBoss[i];
    console.log(`\n[${i + 1}/${commitsToBoss.length}] Bossing ${sha.slice(0, 7)}...`);
    
    await bossCommitInHistory(sha, template, timeMode);
    
    // Update remaining SHAs since they've changed after rebasing
    if (i < commitsToBoss.length - 1) {
      const newCommits = await getAllCommits();
      for (let j = i + 1; j < commitsToBoss.length; j++) {
        // Find the commit with matching identity
        const oldIdentity = await getCommitIdentityFromRef(commitsToBoss[j].sha);
        for (const newSha of newCommits) {
          const newIdentity = await getCommitIdentityFromRef(newSha);
          if (identitiesMatch(oldIdentity, newIdentity)) {
            commitsToBoss[j].sha = newSha;
            break;
          }
        }
      }
    }
  }

  const finalHead = (await git.revparse(["HEAD"])).trim();
  console.log();
  console.log("✅ All commits bossed!");
  console.log(`   HEAD: ${finalHead}`);
}

// =============================================================================
// Helpers
// =============================================================================

async function getAllCommits(): Promise<string[]> {
  // Get all commits from root to HEAD, oldest first
  const result = await git.raw(["rev-list", "--reverse", "HEAD"]);
  return result.trim().split("\n").filter(Boolean);
}

async function getCommitIdentityFromRef(ref: string): Promise<CommitIdentity> {
  const [treeHash, authorName, authorEmail, timestampStr] = await Promise.all([
    git.raw(["rev-parse", `${ref}^{tree}`]).then((r: string) => r.trim()),
    git.raw(["log", "-1", "--format=%an", ref]).then((r: string) => r.trim()),
    git.raw(["log", "-1", "--format=%ae", ref]).then((r: string) => r.trim()),
    git.raw(["log", "-1", "--format=%at", ref]).then((r: string) => r.trim()),
  ]);

  return {
    treeHash,
    authorName,
    authorEmail,
    authorTimestamp: parseInt(timestampStr, 10),
  };
}

function identitiesMatch(a: CommitIdentity, b: CommitIdentity): boolean {
  return (
    a.treeHash === b.treeHash &&
    a.authorName === b.authorName &&
    a.authorEmail === b.authorEmail &&
    a.authorTimestamp === b.authorTimestamp
  );
}

async function bossCommitInHistory(
  targetSha: string,
  template: string,
  timeMode: "preserve" | "now"
): Promise<void> {
  // Get commits to replay
  const commitsToReplay = await getCommitsToReplay(targetSha);

  // Create worktree
  const worktree = `/tmp/codeboss-rebase-${Date.now()}`;

  await execa("git", ["worktree", "add", worktree, targetSha, "--detach", "--quiet"]);

  let newTargetSha: string;

  try {
    const wtGit: SimpleGit = simpleGit(worktree);
    const commitIdentity = await getCommitIdentityFromWorktree(wtGit);
    const parentHash = await getParentHashFromWorktree(wtGit);
    const author = await getAuthorStringFromWorktree(wtGit);
    
    const { timestamp, timezone } = timeMode === "preserve"
      ? await getAuthorTimeFromWorktree(wtGit)
      : getCurrentTime();

    // Save to database
    saveBossification(commitIdentity, template);

    // Mine
    console.log("⛏️  Mining...");

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
    await execa("git", ["commit", "--amend", "-m", result.message!], {
      cwd: worktree,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${timestamp} ${timezone}`,
        GIT_COMMITTER_DATE: `${timestamp} ${timezone}`,
      },
    });

    newTargetSha = (await wtGit.revparse(["HEAD"])).trim();
    console.log(`✓ Bossed: ${newTargetSha}`);

  } finally {
    try {
      await execa("git", ["worktree", "remove", worktree, "--force"]);
    } catch {
      await execa("rm", ["-rf", worktree]);
    }
  }

  // Reset and replay
  await git.reset(["--hard", newTargetSha]);

  if (commitsToReplay.length > 0) {
    for (const sha of commitsToReplay) {
      const cherryPickArgs = timeMode === "now"
        ? ["cherry-pick", "--ignore-date", sha]
        : ["cherry-pick", sha];
      await git.raw(cherryPickArgs);
    }
  }
}

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
  try {
    return (await wtGit.revparse(["HEAD^"])).trim();
  } catch {
    // Root commit has no parent
    return "0000000000000000000000000000000000000000";
  }
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

function getCurrentTime(): { timestamp: string; timezone: string } {
  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const offsetMinutes = now.getTimezoneOffset();
  const offsetHours = Math.abs(Math.floor(offsetMinutes / 60));
  const offsetMins = Math.abs(offsetMinutes % 60);
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const timezone = `${sign}${offsetHours.toString().padStart(2, "0")}${offsetMins.toString().padStart(2, "0")}`;
  return { timestamp, timezone };
}

