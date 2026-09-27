import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getDb, openDb, closeDb } from "../src/db/index.js";

/**
 * One-time migration of old owner-facing kanban cards into the Owner Board (spec §5b). READ-ONLY on
 * kanban_cards — this never writes to it. Idempotent via source_kanban_id UNIQUE + ON CONFLICT DO NOTHING,
 * so a second run migrates 0.
 */
export interface MigrationResult {
  migrated: number;
  open: number;
  closed: number;
  skipped: number;
}

interface OldKanbanRow {
  id: string;
  title: string;
  description: string | null;
  project: string | null;
  status: string;
  created_at: number;
  archived_at: number | null;
}

export function migrateOwnerCards(): MigrationResult {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, title, description, project, status, created_at, archived_at FROM kanban_cards WHERE assignee='szoszo'`)
    .all() as OldKanbanRow[];

  const insert = db.prepare(
    `INSERT INTO owner_cards (id, kind, agent, project, title, body, status, closed_via, source_kanban_id, created_at, updated_at)
     VALUES (?, 'task', 'marveen', ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(source_kanban_id) DO NOTHING`
  );

  let migrated = 0;
  let open = 0;
  let closed = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      const isClosed = r.status === "done" || r.archived_at !== null;
      const status = isClosed ? "closed" : "open";
      const closedVia = isClosed ? "kanban" : null;
      const id = randomBytes(4).toString("hex");
      const info = insert.run(id, r.project, r.title, r.description, status, closedVia, r.id, r.created_at);
      if (info.changes > 0) {
        migrated++;
        if (status === "open") open++;
        else closed++;
      } else {
        skipped++;
      }
    }
  });
  tx();

  return { migrated, open, closed, skipped };
}

async function main() {
  const tenantRoot = process.env.OFFICE_TENANT_ROOT ?? join(process.cwd(), "tenant");
  const dbFile = join(tenantRoot, "store", "theoffice.db");
  openDb(dbFile);
  try {
    const r = migrateOwnerCards();
    console.log(`migrated ${r.migrated} (open ${r.open}, closed ${r.closed}), skipped ${r.skipped} already present`);
  } finally {
    closeDb();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
