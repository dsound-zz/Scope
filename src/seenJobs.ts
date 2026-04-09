/**
 * SCOPE — Persistent seen-job deduplication store
 *
 * Uses the same scope_memory.db file (separate table) so no new file is needed.
 * Tracks job IDs that have already been included in a digest email, preventing
 * duplicate outreach drafts across multiple daily runs.
 */
import Database from "better-sqlite3";
import * as path from "path";
import { fileURLToPath } from "url";
import type { MatchedJob } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "scope_memory.db");

function openDb(): InstanceType<typeof Database> {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_jobs (
      id         TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL
    )
  `);
  return db;
}

/** Returns only jobs whose IDs have not been seen before. */
export function filterNewJobs(jobs: MatchedJob[]): MatchedJob[] {
  if (jobs.length === 0) return [];
  const db = openDb();
  try {
    const placeholders = jobs.map(() => "?").join(",");
    const ids = jobs.map((j) => j.id);
    const rows = db
      .prepare(`SELECT id FROM seen_jobs WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string }[];
    const seen = new Set(rows.map((r) => r.id));
    return jobs.filter((j) => !seen.has(j.id));
  } finally {
    db.close();
  }
}

/** Marks jobs as seen so they are excluded from future digest emails. */
export function markJobsSeen(jobs: MatchedJob[]): void {
  if (jobs.length === 0) return;
  const db = openDb();
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO seen_jobs (id, first_seen) VALUES (?, ?)"
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const job of jobs) insert.run(job.id, now);
    })();
  } finally {
    db.close();
  }
}
