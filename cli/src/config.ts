import { config } from "dotenv";
import { resolve } from "path";
import { homedir } from "os";

// Load .env from project root
config({ path: resolve(import.meta.dirname, "../../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function expandHome(path: string): string {
  if (path.startsWith("~")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

// =============================================================================
// Configuration
// =============================================================================

export const CONFIG = {
  // Database
  dbPath: expandHome(optional("DB_PATH", "~/.ben/data/codeboss.db")),

  // Mining parameters
  inverseDesiredFailureRate: parseInt(
    optional("INVERSE_DESIRED_FAILURE_RATE", "100_000").replace(/_/g, ""),
    10
  ),
  target: optional("TARGET", "c0deb055"),

  // GCP
  gcpInstance: optional("GCP_INSTANCE", "c0deb055-miner"),
  gcpZone: optional("GCP_ZONE", "us-central1-a"),
} as const;

// Derived: target bits (4 bits per hex char)
export const TARGET_BITS = CONFIG.target.length * 4;

