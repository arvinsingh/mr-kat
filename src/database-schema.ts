import type { DatabaseSync } from 'node:sqlite';
import { configSchema } from './config.js';
import { assert } from './errors.js';

export const schemaVersion = 3;

// Read metadata only; opening a backup connection must never initialize or migrate schema.
export function databaseMetadata(db: DatabaseSync, guildId?: string) {
  for (const table of [
    'settings',
    'entries',
    'jobs',
    'cases',
    'migrations',
    'snapshots',
    'counters',
  ]) {
    const row = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(table);
    assert(row?.type === 'table', 'This is not a compatible mr-kat backup.');
    if (guildId && table !== 'migrations') {
      assert(
        !db.prepare(`SELECT 1 FROM ${table} WHERE guild!=? LIMIT 1`).get(guildId),
        'The backup contains records for another server.',
      );
    }
  }
  const schema = Number(
    db.prepare('SELECT MAX(version) AS version FROM migrations').get()?.version,
  );
  assert(
    schema >= 1 && schema <= schemaVersion,
    'The backup schema is not supported by this bot version.',
  );
  if (schema >= 3) {
    assert(
      db.prepare("SELECT type FROM sqlite_master WHERE name='settings_revisions'").get()?.type ===
        'table',
      'Backup settings revisions are missing.',
    );
    if (guildId)
      assert(
        !db.prepare('SELECT 1 FROM settings_revisions WHERE guild!=? LIMIT 1').get(guildId),
        'The backup contains settings revisions for another server.',
      );
  }
  for (const row of db.prepare('SELECT data FROM settings').all())
    configSchema.parse(JSON.parse(String(row.data)));
  const settings = Number(db.prepare('SELECT COUNT(*) AS n FROM settings').get()!.n);
  const pendingJobs = Number(
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('ready','running')").get()!.n,
  );
  const pendingKinds: Record<string, number> = Object.fromEntries(
    db
      .prepare(
        "SELECT kind,COUNT(*) AS n FROM jobs WHERE state IN ('ready','running') GROUP BY kind",
      )
      .all()
      .map((row) => [String(row.kind), Number(row.n)]),
  );
  return { schema, pendingJobs, pendingKinds, settings };
}
