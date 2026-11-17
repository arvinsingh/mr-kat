import { DatabaseSync, backup } from 'node:sqlite';
import { statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assert } from './util.js';
import { databaseMetadata } from './database-schema.js';
import type { BackupContext } from './backup-health.js';

// A narrow, non-migrating connection. Only backup-health entries are writable here.
type BackupStore = BackupContext['store'];
export class BackupSource implements BackupStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly guildId: string,
  ) {
    assert(statSync(path).isFile(), 'The backup source must be an existing database file.');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
      databaseMetadata(this.db, guildId);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(guild: string, kind: string, key: string): T | undefined {
    this.healthEntry(guild, kind, key);
    const row = this.db
      .prepare('SELECT data FROM entries WHERE guild=? AND kind=? AND key=?')
      .get(guild, kind, key);
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }
  put(guild: string, kind: string, key: string, data: unknown): void {
    this.healthEntry(guild, kind, key);
    this.db
      .prepare(
        'INSERT INTO entries VALUES(?,?,?,?,?) ON CONFLICT(guild,kind,key) DO UPDATE SET data=excluded.data,updated=excluded.updated',
      )
      .run(guild, kind, key, JSON.stringify(data), Date.now());
  }
  private healthEntry(guild: string, kind: string, key: string) {
    assert(
      guild === this.guildId && kind === 'system' && ['backup', 'backupHealth'].includes(key),
      'The backup connection can only access this server’s backup-health records.',
    );
  }
  async backup(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await backup(this.db, path);
  }
  close() {
    this.db.close();
  }
}
