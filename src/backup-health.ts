import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { App } from './types.js';
import { configSchema } from './config.js';
import { assert, errorText } from './util.js';
import { databaseLock } from './database-lock.js';

export interface BackupCheck {
  file: string;
  bytes: number;
  modified: number;
  sha256: string;
  manifest: boolean;
  schema: number;
  pendingJobs: number;
  pendingKinds: Record<string, number>;
  settings: number;
}
export interface BackupState {
  lastAttempt?: number;
  lastSuccess?: number;
  lastFile?: string;
  lastVerified?: number;
  lastError?: string;
  lastVerification?: { file: string; at: number; ok: boolean; error?: string };
}
const backupName = /^(?:automatic|manual|bot)-\d+(?:-[a-f0-9]+)?\.sqlite$/;
export async function checksum(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function backupPath(folder: string, file: string) {
  assert(
    backupName.test(file) && basename(file) === file,
    'Choose a backup filename from the backup list.',
  );
  const path = join(resolve(folder), file);
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), 'Backup must be a regular file, not a link.');
  assert(
    dirname(await realpath(path)) === (await realpath(folder)),
    'Backup is outside the configured directory.',
  );
  assert(
    info.size > 0 && info.size <= 512 * 1024 * 1024,
    'Backup is empty or exceeds the 512 MB verification limit.',
  );
  return path;
}
export async function listBackups(folder: string, limit = 25) {
  await mkdir(folder, { recursive: true });
  const names = (await readdir(folder)).filter((file) => backupName.test(file));
  const items = await Promise.all(
    names.map(async (file) => {
      const info = await lstat(join(folder, file));
      return {
        file,
        bytes: info.size,
        modified: info.mtimeMs,
        regular: info.isFile() && !info.isSymbolicLink(),
      };
    }),
  );
  return items
    .filter((item) => item.regular)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit);
}
export async function inspectBackup(path: string, guildId?: string): Promise<BackupCheck> {
  const info = await lstat(path);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 512 * 1024 * 1024,
    'Choose a regular nonempty SQLite backup of at most 512 MB.',
  );
  try {
    assert(
      (await stat(path + '-wal')).size === 0,
      'This file has a nonempty WAL. Create a consistent backup first; do not copy a live database alone.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  let schema = 0,
    pendingJobs = 0,
    settings = 0;
  let pendingKinds: Record<string, number> = {};
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
    schema = Number(db.prepare('SELECT MAX(version) AS version FROM migrations').get()?.version);
    assert(schema >= 1 && schema <= 2, 'The backup schema is not supported by this bot version.');
    for (const row of db.prepare('SELECT data FROM settings').all())
      configSchema.parse(JSON.parse(String(row.data)));
    settings = Number(db.prepare('SELECT COUNT(*) AS n FROM settings').get()!.n);
    pendingJobs = Number(
      db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('ready','running')").get()!.n,
    );
    pendingKinds = Object.fromEntries(
      db
        .prepare(
          "SELECT kind,COUNT(*) AS n FROM jobs WHERE state IN ('ready','running') GROUP BY kind",
        )
        .all()
        .map((row) => [String(row.kind), Number(row.n)]),
    );
  } finally {
    db.close();
  }
  const sha256 = await checksum(path);
  let manifest = false;
  try {
    const manifestInfo = await lstat(path + '.manifest.json');
    assert(
      manifestInfo.isFile() && !manifestInfo.isSymbolicLink() && manifestInfo.size <= 64000,
      'Checksum manifest must be a regular file of at most 64 KB.',
    );
    const metadata = JSON.parse(await readFile(path + '.manifest.json', 'utf8'));
    assert(
      metadata.sha256 === sha256 &&
        metadata.bytes === info.size &&
        metadata.file === basename(path),
      'Backup checksum manifest does not match its file.',
    );
    manifest = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    file: basename(path),
    bytes: info.size,
    modified: info.mtimeMs,
    sha256,
    manifest,
    schema,
    pendingJobs,
    pendingKinds,
    settings,
  };
}
const busy = new WeakSet<App>();
export async function verifyLocalBackup(app: App, file: string) {
  const state = app.store.get<BackupState>(app.guildId, 'system', 'backupHealth') ?? {};
  try {
    const check = await inspectBackup(await backupPath(app.backupDir, file), app.guildId);
    app.store.put(app.guildId, 'system', 'backupHealth', {
      ...state,
      lastVerified: Date.now(),
      lastVerification: { file, at: Date.now(), ok: true },
    } satisfies BackupState);
    return check;
  } catch (error) {
    app.store.put(app.guildId, 'system', 'backupHealth', {
      ...state,
      lastVerification: {
        file: basename(file),
        at: Date.now(),
        ok: false,
        error: errorText(error),
      },
    } satisfies BackupState);
    throw error;
  }
}
export async function createVerifiedBackup(app: App, automatic = false) {
  assert(!busy.has(app), 'A backup is already being created. Refresh its status shortly.');
  busy.add(app);
  const state = app.store.get<BackupState>(app.guildId, 'system', 'backupHealth') ?? {};
  state.lastAttempt = Date.now();
  app.store.put(app.guildId, 'system', 'backupHealth', state);
  const file = `${automatic ? 'automatic' : 'manual'}-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`;
  const path = join(app.backupDir, file),
    temporary = path + '.partial';
  try {
    await app.store.backup(temporary);
    await chmod(temporary, 0o600);
    await inspectBackup(temporary, app.guildId);
    await rename(temporary, path);
    const check = await inspectBackup(path, app.guildId);
    await writeFile(
      path + '.manifest.json',
      JSON.stringify({ ...check, created: Date.now() }, null, 2),
      { mode: 0o600 },
    );
    const verified = await inspectBackup(path, app.guildId);
    app.store.put(app.guildId, 'system', 'backupHealth', {
      lastAttempt: state.lastAttempt,
      lastSuccess: Date.now(),
      lastVerified: Date.now(),
      lastFile: file,
    } satisfies BackupState);
    app.store.put(app.guildId, 'system', 'backup', { at: Date.now() });
    return verified;
  } catch (error) {
    app.store.put(app.guildId, 'system', 'backupHealth', { ...state, lastError: errorText(error) });
    throw error;
  } finally {
    busy.delete(app);
    await unlink(temporary).catch(() => undefined);
  }
}
export async function maintainBackups(app: App) {
  if (busy.has(app)) return;
  const last = app.store.get<{ at: number }>(app.guildId, 'system', 'backup');
  const state = app.store.get<BackupState>(app.guildId, 'system', 'backupHealth');
  if (!last || last.at < Date.now() - 86400000 || !state?.lastSuccess) {
    try {
      await createVerifiedBackup(app, true);
    } catch (error) {
      if (state?.lastError !== errorText(error))
        await app.audit(
          app.guildId,
          'admin',
          'Automatic backup failed',
          `No verified backup was created. ${errorText(error)}\nUse /backup to inspect recovery health.`,
          { force: true },
        );
      throw error;
    }
  }
  for (const item of await listBackups(app.backupDir, Number.MAX_SAFE_INTEGER)) {
    if (!item.file.startsWith('automatic-') || item.modified >= Date.now() - 7 * 86400000) continue;
    await unlink(await backupPath(app.backupDir, item.file));
    await unlink(join(app.backupDir, item.file) + '.manifest.json').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export function recoveryGuide(file = 'YOUR_BACKUP.sqlite') {
  return `# Recover mr-kat\n\n1. Download the selected backup and its matching .manifest.json from the private host filesystem to storage you control. Keep them together. These files contain private bot data; do not post them in Discord or GitHub. Local copies on the same host do not protect against losing that host.\n2. Stop the bot using your host or process manager and wait until its process exits. Keep one bot instance only.\n3. Use the recovery CLI from the same working directory and release as the bot. For the standard built project:\n\nnode --env-file-if-exists=.env dist/src/recover.js --source backups/${file} --target data/bot.sqlite\n\nThis checks the backup and displays a plan; it changes no database. Adjust source/target if DATABASE_PATH or BACKUP_DIR was customized.\n4. Review the server ID, schema, integrity/checksum result and pending job count. The dry-run includes pendingKinds. Apply refuses pending work until you explicitly add --allow-pending-jobs after review. Inspect historical timers before restoring an old snapshot: roles, bans and scheduled work can return to an earlier state.\n5. Repeat the command with --apply --stopped to restore. The tool requires the bot to be stopped, takes a database lock, preserves existing database/WAL/SHM files in a sibling recovery-before-* folder and installs a validated copy. It does not change .env or Discord channel/message history.\n6. Start ONE bot instance. Run /diagnose, /backup and /jobs list. Reconcile pending jobs and managed rooms with current server state.\n\nBackups without a manifest can pass SQLite checks but lack a recorded checksum for comparison. Verification is not evidence of an off-host copy.\n`;
}

export async function restoreBackup(
  source: string,
  target: string,
  guildId: string | undefined,
  apply = false,
  stopped = false,
  allowPending = false,
) {
  const original = resolve(source),
    destination = resolve(target);
  assert(original !== destination, 'Source and target must be different files.');
  const check = await inspectBackup(original, guildId);
  if (!apply) return { ...check, applied: false, preserved: undefined as string | undefined };
  assert(stopped, 'Stop the bot, then explicitly add --stopped with --apply.');
  assert(
    guildId,
    'Set DISCORD_GUILD_ID before applying recovery so the backup server can be checked.',
  );
  assert(
    !check.pendingJobs || allowPending,
    'This snapshot contains pending jobs. Review pendingKinds and their current server effects, then add --allow-pending-jobs only if you intend to restore that work.',
  );
  const release = await databaseLock(destination);
  const staging = destination + `.restore-${randomUUID()}`;
  const preserved = join(
    dirname(destination),
    `recovery-before-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  const moved: [string, string][] = [];
  try {
    await copyFile(original, staging);
    await chmod(staging, 0o600);
    const staged = await inspectBackup(staging, guildId);
    assert(staged.sha256 === check.sha256, 'Backup changed while preparing recovery.');
    await mkdir(preserved, { recursive: true, mode: 0o700 });
    for (const suffix of ['', '-wal', '-shm']) {
      const from = destination + suffix;
      try {
        const info = await lstat(from);
        assert(
          info.isFile() && !info.isSymbolicLink(),
          'Recovery target and sidecars must be regular files.',
        );
        const to = join(preserved, basename(from));
        await rename(from, to);
        moved.push([from, to]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(staging, destination);
    return { ...check, applied: true, preserved };
  } catch (error) {
    for (const [from, to] of moved.reverse()) await rename(to, from);
    throw error;
  } finally {
    await unlink(staging).catch(() => undefined);
    await release();
  }
}
