import { execa } from "execa";
import { CONFIG } from "./config.js";

// =============================================================================
// Instance Management
// =============================================================================

type InstanceStatus =
  | "RUNNING"
  | "SUSPENDED"
  | "SUSPENDING"
  | "STAGING"
  | "TERMINATED"
  | "STOPPED"
  | "NOT_FOUND";

/**
 * Get the current status of the mining instance.
 */
export async function getInstanceStatus(): Promise<InstanceStatus> {
  try {
    const { stdout } = await execa("gcloud", [
      "compute",
      "instances",
      "describe",
      CONFIG.gcpInstance,
      `--zone=${CONFIG.gcpZone}`,
      "--format=get(status)",
    ]);
    return stdout.trim() as InstanceStatus;
  } catch {
    return "NOT_FOUND";
  }
}

/**
 * Resume a suspended instance.
 */
export async function resumeInstance(): Promise<void> {
  console.log("🔄 Resuming instance...");
  await execa("gcloud", [
    "compute",
    "instances",
    "resume",
    CONFIG.gcpInstance,
    `--zone=${CONFIG.gcpZone}`,
    "--quiet",
  ]);
  console.log("⏳ Waiting for SSH...");
  await sleep(15000);
}

/**
 * Start a stopped instance.
 */
export async function startInstance(): Promise<void> {
  console.log("🚀 Starting instance...");
  await execa("gcloud", [
    "compute",
    "instances",
    "start",
    CONFIG.gcpInstance,
    `--zone=${CONFIG.gcpZone}`,
    "--quiet",
  ]);
  console.log("⏳ Waiting for SSH...");
  await sleep(15000);
}

/**
 * Wait for instance to reach a stable state.
 */
export async function waitForStableState(): Promise<InstanceStatus> {
  const transitionalStates = ["SUSPENDING", "STAGING", "STOPPING"];

  while (true) {
    const status = await getInstanceStatus();

    if (!transitionalStates.includes(status)) {
      return status;
    }

    console.log(`⏳ Instance is ${status}, waiting...`);
    await sleep(5000);
  }
}

/**
 * Ensure the instance is running, resuming/starting if needed.
 */
export async function ensureInstanceRunning(): Promise<void> {
  const status = await waitForStableState();

  switch (status) {
    case "RUNNING":
      return;
    case "SUSPENDED":
      await resumeInstance();
      return;
    case "STOPPED":
    case "TERMINATED":
      await startInstance();
      return;
    default:
      throw new Error(`Instance not available (status: ${status})`);
  }
}

// =============================================================================
// Mining
// =============================================================================

export interface MiningParams {
  template: string;
  treeHash: string;
  parentHash: string;
  author: string;
  timestamp: string;
  timezone: string;
}

export interface MiningResult {
  success: boolean;
  message?: string;
  hash?: string;
  error?: string;
}

/**
 * Run the miner on the remote instance.
 */
export async function runMiner(params: MiningParams): Promise<MiningResult> {
  const command = `./run-codeboss '${params.template}' '${params.treeHash}' '${params.parentHash}' '${params.author}' '${params.timestamp}' '${params.timezone}' '${CONFIG.target}'`;

  try {
    const { stdout, stderr } = await execa("gcloud", [
      "compute",
      "ssh",
      CONFIG.gcpInstance,
      `--zone=${CONFIG.gcpZone}`,
      `--command=${command}`,
    ]);

    const output = stdout + "\n" + stderr;

    // Check for entropy error
    if (output.includes("not enough entropy") || output.includes("ERROR: Template has only")) {
      return {
        success: false,
        error: "Not enough entropy",
      };
    }

    // Check for success
    if (output.includes("Found in")) {
      // Last line is the message
      const lines = stdout.trim().split("\n");
      const message = lines[lines.length - 1];

      // Extract hash from output
      const hashMatch = output.match(/Hash: ([a-f0-9]+)/);
      const hash = hashMatch ? hashMatch[1] : undefined;

      return {
        success: true,
        message,
        hash,
      };
    }

    return {
      success: false,
      error: "Mining failed",
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "SSH command failed",
    };
  }
}

// =============================================================================
// Utilities
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

