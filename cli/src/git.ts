import { simpleGit, SimpleGit } from "simple-git";
import { execa } from "execa";
import type { CommitIdentity } from "./db.js";

// =============================================================================
// Git Operations
// =============================================================================

const git: SimpleGit = simpleGit();

/**
 * Check if we're in a git repository.
 */
export async function isGitRepo(): Promise<boolean> {
  try {
    await git.revparse(["--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we're on a branch (not detached HEAD).
 */
export async function getCurrentBranch(): Promise<string | null> {
  try {
    const result = await git.revparse(["--abbrev-ref", "HEAD"]);
    const branch = result.trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Get the commit identity for a given ref (default: HEAD).
 */
export async function getCommitIdentity(
  ref: string = "HEAD"
): Promise<CommitIdentity> {
  const [treeHash, authorName, authorEmail, timestampStr] = await Promise.all([
    git.revparse([`${ref}^{tree}`]).then((r) => r.trim()),
    git.raw(["log", "-1", "--format=%an", ref]).then((r) => r.trim()),
    git.raw(["log", "-1", "--format=%ae", ref]).then((r) => r.trim()),
    git.raw(["log", "-1", "--format=%at", ref]).then((r) => r.trim()),
  ]);

  return {
    treeHash,
    authorName,
    authorEmail,
    authorTimestamp: parseInt(timestampStr, 10),
  };
}

/**
 * Get the parent commit hash.
 */
export async function getParentHash(ref: string = "HEAD"): Promise<string> {
  const result = await git.revparse([`${ref}^`]);
  return result.trim();
}

/**
 * Check if a commit has a parent.
 */
export async function hasParent(ref: string = "HEAD"): Promise<boolean> {
  try {
    await git.revparse([`${ref}^`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a ref is an ancestor of HEAD.
 */
export async function isAncestor(ref: string): Promise<boolean> {
  try {
    await git.raw(["merge-base", "--is-ancestor", ref, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a ref to a commit hash.
 */
export async function resolveRef(ref: string): Promise<string> {
  const result = await git.revparse([ref]);
  return result.trim();
}

/**
 * Get author info formatted as "Name <email>".
 */
export async function getAuthorString(ref: string = "HEAD"): Promise<string> {
  const [name, email] = await Promise.all([
    git.raw(["log", "-1", "--format=%an", ref]).then((r) => r.trim()),
    git.raw(["log", "-1", "--format=%ae", ref]).then((r) => r.trim()),
  ]);
  return `${name} <${email}>`;
}

/**
 * Get author timestamp and timezone.
 */
export async function getAuthorTime(
  ref: string = "HEAD"
): Promise<{ timestamp: string; timezone: string }> {
  const [timestamp, dateStr] = await Promise.all([
    git.raw(["log", "-1", "--format=%at", ref]).then((r) => r.trim()),
    git.raw(["log", "-1", "--format=%ai", ref]).then((r) => r.trim()),
  ]);

  // dateStr is like "2024-01-17 12:34:56 -0500"
  const timezone = dateStr.split(" ")[2] || "+0000";

  return { timestamp, timezone };
}

/**
 * Amend HEAD with a new message, preserving author date.
 */
export async function amendCommit(
  message: string,
  timestamp: string,
  timezone: string
): Promise<void> {
  await execa("git", ["commit", "--amend", "-m", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${timestamp} ${timezone}`,
      GIT_COMMITTER_DATE: `${timestamp} ${timezone}`,
    },
  });
}

/**
 * Get current HEAD hash.
 */
export async function getHead(): Promise<string> {
  const result = await git.revparse(["HEAD"]);
  return result.trim();
}

