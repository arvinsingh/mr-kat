import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { databaseMetadata } from './database-schema.js';
import { assert, UserError } from './errors.js';

export type InspectionResult =
  | { ok: true; metadata: ReturnType<typeof databaseMetadata> }
  | { ok: false; error: string; userError: boolean };

const { path, guildId } = workerData as { path: string; guildId?: string };
try {
  const db = new DatabaseSync(path, { readOnly: true });
  let metadata: ReturnType<typeof databaseMetadata>;
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const rows = db.prepare('PRAGMA integrity_check').all();
    assert(
      rows.length === 1 && Object.values(rows[0]!)[0] === 'ok',
      'SQLite integrity verification failed.',
    );
    assert(
      db.prepare('PRAGMA foreign_key_check').all().length === 0,
      'SQLite foreign-key verification failed.',
    );
    metadata = databaseMetadata(db, guildId);
  } finally {
    db.close();
  }
  parentPort!.postMessage({ ok: true, metadata } satisfies InspectionResult);
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    userError: error instanceof UserError,
  } satisfies InspectionResult);
} finally {
  parentPort!.close();
}
