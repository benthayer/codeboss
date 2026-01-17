import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { CONFIG } from "./config.js";

// =============================================================================
// Types
// =============================================================================

export interface CommitIdentity {
  treeHash: string;
  authorName: string;
  authorEmail: string;
  authorTimestamp: number;
}

export interface Bossification extends CommitIdentity {
  template: string;
  createdAt: number;
}

// =============================================================================
// Database Setup
// =============================================================================

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    // Ensure directory exists
    mkdirSync(dirname(CONFIG.dbPath), { recursive: true });

    db = new Database(CONFIG.dbPath);

    // Create table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS bossifications (
        tree_hash TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        author_timestamp INTEGER NOT NULL,
        template TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tree_hash, author_name, author_email, author_timestamp)
      )
    `);
  }

  return db;
}

// =============================================================================
// Operations
// =============================================================================

/**
 * Save or update a bossification for a commit.
 * Uses INSERT OR REPLACE for upsert behavior.
 */
export function saveBossification(
  commit: CommitIdentity,
  template: string
): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO bossifications 
    (tree_hash, author_name, author_email, author_timestamp, template, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    commit.treeHash,
    commit.authorName,
    commit.authorEmail,
    commit.authorTimestamp,
    template,
    Math.floor(Date.now() / 1000)
  );
}

/**
 * Look up the saved template for a commit, if it exists.
 */
export function lookupSavedTemplate(
  commit: CommitIdentity
): Bossification | null {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT * FROM bossifications
    WHERE tree_hash = ? AND author_name = ? AND author_email = ? AND author_timestamp = ?
  `);

  const row = stmt.get(
    commit.treeHash,
    commit.authorName,
    commit.authorEmail,
    commit.authorTimestamp
  ) as any;

  if (!row) return null;

  return {
    treeHash: row.tree_hash,
    authorName: row.author_name,
    authorEmail: row.author_email,
    authorTimestamp: row.author_timestamp,
    template: row.template,
    createdAt: row.created_at,
  };
}

/**
 * Get all bossifications, ordered by creation time (newest first).
 */
export function getAllBossifications(): Bossification[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT * FROM bossifications
    ORDER BY created_at DESC
  `);

  const rows = stmt.all() as any[];

  return rows.map((row) => ({
    treeHash: row.tree_hash,
    authorName: row.author_name,
    authorEmail: row.author_email,
    authorTimestamp: row.author_timestamp,
    template: row.template,
    createdAt: row.created_at,
  }));
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

