import path from "node:path";
import Database from "better-sqlite3";
import type { SeenRow, CiState } from "./types";

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = process.env.DASHBOARD_DB_PATH ?? path.join(process.cwd(), "data.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_seen (
      pr_id                        TEXT PRIMARY KEY,
      seen_at                      INTEGER NOT NULL,
      reviews_count_at_seen        INTEGER NOT NULL,
      comments_count_at_seen       INTEGER NOT NULL,
      ci_state_at_seen             TEXT,
      was_review_requested_at_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merged_seen (
      pr_id                  TEXT PRIMARY KEY,
      first_seen_after_merge INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pr_checkpoint (
      pr_id        TEXT PRIMARY KEY,
      updated_at   TEXT NOT NULL,
      recorded_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dashboard_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Migration: add `section` column to pr_checkpoint if it doesn't exist yet.
  const cols = db.pragma("table_info(pr_checkpoint)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "section")) {
    db.exec("ALTER TABLE pr_checkpoint ADD COLUMN section TEXT");
  }
  dbInstance = db;
  return db;
}

export function getAllSeen(): Map<string, SeenRow> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM pr_seen").all() as SeenRow[];
  return new Map(rows.map((r) => [r.pr_id, r]));
}

export function getAllMergedSeen(): Map<string, number> {
  const db = getDb();
  const rows = db.prepare("SELECT pr_id, first_seen_after_merge FROM merged_seen").all() as Array<{
    pr_id: string;
    first_seen_after_merge: number;
  }>;
  return new Map(rows.map((r) => [r.pr_id, r.first_seen_after_merge]));
}

export function upsertSeen(args: {
  prId: string;
  reviewsCount: number;
  commentsCount: number;
  ciState: CiState;
  wasReviewRequested: boolean;
  isMerged: boolean;
}): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO pr_seen (pr_id, seen_at, reviews_count_at_seen, comments_count_at_seen, ci_state_at_seen, was_review_requested_at_seen)
     VALUES (@prId, @now, @reviewsCount, @commentsCount, @ciState, @wasReviewRequested)
     ON CONFLICT(pr_id) DO UPDATE SET
       seen_at = excluded.seen_at,
       reviews_count_at_seen = excluded.reviews_count_at_seen,
       comments_count_at_seen = excluded.comments_count_at_seen,
       ci_state_at_seen = excluded.ci_state_at_seen,
       was_review_requested_at_seen = excluded.was_review_requested_at_seen`,
  ).run({
    prId: args.prId,
    now,
    reviewsCount: args.reviewsCount,
    commentsCount: args.commentsCount,
    ciState: args.ciState,
    wasReviewRequested: args.wasReviewRequested ? 1 : 0,
  });

  if (args.isMerged) {
    db.prepare(
      `INSERT INTO merged_seen (pr_id, first_seen_after_merge)
       VALUES (?, ?)
       ON CONFLICT(pr_id) DO NOTHING`,
    ).run(args.prId, now);
  }
}

export type CheckpointEntry = { updatedAt: string; section: string | null };

export function getAllCheckpoints(): Map<string, CheckpointEntry> {
  const db = getDb();
  const rows = db
    .prepare("SELECT pr_id, updated_at, section FROM pr_checkpoint")
    .all() as Array<{ pr_id: string; updated_at: string; section: string | null }>;
  return new Map(
    rows.map((r) => [r.pr_id, { updatedAt: r.updated_at, section: r.section }]),
  );
}

export function getMeta(key: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM dashboard_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO dashboard_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// Replace the entire checkpoint with the supplied snapshot, in one transaction.
export function replaceCheckpoint(
  snapshot: Array<{ id: string; updatedAt: string; section: string }>,
): void {
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(
    (items: Array<{ id: string; updatedAt: string; section: string }>) => {
      db.prepare("DELETE FROM pr_checkpoint").run();
      const ins = db.prepare(
        "INSERT INTO pr_checkpoint (pr_id, updated_at, recorded_at, section) VALUES (?, ?, ?, ?)",
      );
      for (const { id, updatedAt, section } of items) ins.run(id, updatedAt, now, section);
    },
  );
  tx(snapshot);
  setMeta("checkpoint_initialized", "1");
}
