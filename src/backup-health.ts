import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { App } from './types.js';
import type { Store } from './store.js';
import { assert, errorText } from './util.js';
import { databaseLock } from './database-lock.js';
import { inspectBackup, backupPath, listBackups, publishBackup } from './backup-files.js';

export interface BackupContext {
  store: Pick<Store, 'get' | 'put' | 'backup'>;
  guildId: string;
  backupDir: string;
}

export interface BackupState {
  lastAttempt?: number;
  lastSuccess?: number;
  lastFile?: string;
  lastVerified?: number;
  lastError?: string;
  lastVerification?: { file: string; at: number; ok: boolean; error?: string };
}
const busy = new WeakSet<BackupContext>();
export async function verifyLocalBackup(app: BackupContext, file: string) {
  try {
    const check = await inspectBackup(await backupPath(app.backupDir, file), app.guildId);
    app.store.put(app.guildId, 'system', 'backupHealth', {
      ...app.store.get<BackupState>(app.guildId, 'system', 'backupHealth'),
      lastVerified: Date.now(),
      lastVerification: { file, at: Date.now(), ok: true },
    } satisfies BackupState);
    return check;
  } catch (error) {
    try {
      app.store.put(app.guildId, 'system', 'backupHealth', {
        ...app.store.get<BackupState>(app.guildId, 'system', 'backupHealth'),
        lastVerification: {
          file: basename(file),
          at: Date.now(),
          ok: false,
          error: errorText(error),
        },
      } satisfies BackupState);
    } catch {
      /* Preserve the verification error when health storage is unavailable too. */
    }
    throw error;
  }
}
export async function createVerifiedBackup(app: BackupContext, automatic = false) {
  assert(!busy.has(app), 'A backup is already being created. Refresh its status shortly.');
  busy.add(app);
  const attempted = Date.now();
  const file = `${automatic ? 'automatic' : 'manual'}-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`;
  const path = join(app.backupDir, file),
    temporary = path + '.partial';
  try {
    app.store.put(app.guildId, 'system', 'backupHealth', {
      ...app.store.get<BackupState>(app.guildId, 'system', 'backupHealth'),
      lastAttempt: attempted,
    } satisfies BackupState);
    await app.store.backup(temporary);
    await chmod(temporary, 0o600);
    const verified = await publishBackup(temporary, path, app.guildId);
    app.store.put(app.guildId, 'system', 'backupHealth', {
      ...app.store.get<BackupState>(app.guildId, 'system', 'backupHealth'),
      lastSuccess: Date.now(),
      lastVerified: Date.now(),
      lastFile: file,
      lastError: undefined,
    } satisfies BackupState);
    app.store.put(app.guildId, 'system', 'backup', { at: Date.now() });
    return verified;
  } catch (error) {
    try {
      app.store.put(app.guildId, 'system', 'backupHealth', {
        ...app.store.get<BackupState>(app.guildId, 'system', 'backupHealth'),
        lastError: errorText(error),
      });
    } catch {
      /* Preserve the original error if health storage is unavailable too. */
    }
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
