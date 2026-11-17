import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  rename,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assert } from './util.js';
import { inspectDatabase } from './backup-worker.js';

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
async function backupInfo(path: string) {
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
  return info;
}
async function manifestMatches(path: string, sha256: string, bytes: number): Promise<boolean> {
  try {
    const manifestInfo = await lstat(path + '.manifest.json');
    assert(
      manifestInfo.isFile() && !manifestInfo.isSymbolicLink() && manifestInfo.size <= 64000,
      'Checksum manifest must be a regular file of at most 64 KB.',
    );
    const metadata = JSON.parse(await readFile(path + '.manifest.json', 'utf8'));
    assert(
      metadata.sha256 === sha256 && metadata.bytes === bytes && metadata.file === basename(path),
      'Backup checksum manifest does not match its file.',
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}
function unchanged(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
) {
  assert(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs,
    'Backup changed while it was being verified. Try again.',
  );
}
export async function inspectBackup(path: string, guildId?: string): Promise<BackupCheck> {
  const info = await backupInfo(path);
  const metadata = await inspectDatabase(path, guildId);
  const sha256 = await checksum(path);
  const manifest = await manifestMatches(path, sha256, info.size);
  unchanged(info, await backupInfo(path));
  return {
    file: basename(path),
    bytes: info.size,
    modified: info.mtimeMs,
    sha256,
    manifest,
    ...metadata,
  };
}

export async function publishBackup(
  temporary: string,
  path: string,
  guildId: string,
): Promise<BackupCheck> {
  // Inspect SQLite once. After rename, the checksum must still identify those exact verified bytes.
  const inspected = await inspectBackup(temporary, guildId);
  await rename(temporary, path);
  const check = { ...inspected, file: basename(path) };
  const manifest = path + '.manifest.json';
  const staging = manifest + '.partial';
  try {
    await writeFile(staging, JSON.stringify({ ...check, created: Date.now() }, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(staging, manifest);
    const info = await backupInfo(path);
    const hash = await checksum(path);
    assert(
      info.size === check.bytes && hash === check.sha256,
      'Backup changed while being published.',
    );
    assert(await manifestMatches(path, hash, info.size), 'Backup checksum manifest is missing.');
    unchanged(info, await backupInfo(path));
    return { ...check, modified: info.mtimeMs, manifest: true };
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}
