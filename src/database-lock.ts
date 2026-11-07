import { open, readFile, readlink, stat, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assert } from './util.js';

export interface LockOwner {
  pid: number;
  nonce: string;
  identity?: string;
  startedAt?: number;
}
interface ProcessProbe {
  pid: number;
  startedAt: number;
  alive(pid: number): boolean;
  identity(pid: number): Promise<string | undefined>;
}
async function linuxIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const [info, boot, namespace] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readlink(`/proc/${pid}/ns/pid`),
    ]);
    // comm (field 2) may contain spaces/parentheses; starttime is field 22.
    const start = info
      .slice(info.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    if (!start || !/^\d+$/.test(start)) return undefined;
    return `linux:${boot.trim()}:${namespace}:${start}`;
  } catch {
    return undefined;
  }
}
const systemProbe: ProcessProbe = {
  pid: process.pid,
  startedAt: performance.timeOrigin,
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  },
  identity: linuxIdentity,
};
export async function lockOwnerIsRunning(
  owner: LockOwner,
  modifiedAt: number,
  probe: ProcessProbe = systemProbe,
): Promise<boolean> {
  if (!probe.alive(owner.pid)) return false;
  const identity = await probe.identity(owner.pid);
  if (owner.identity && identity) return owner.identity === identity;
  if (owner.pid === probe.pid) {
    if (Number.isFinite(owner.startedAt)) return owner.startedAt === probe.startedAt;
    // Legacy locks contain only pid/nonce. A file older than THIS process cannot
    // be owned by it, even when a new container reuses the same PID (e.g. 46).
    return modifiedAt >= probe.startedAt;
  }
  // Without evidence of PID reuse, preserve the other live process's lock.
  return true;
}

export async function databaseLock(path: string): Promise<() => Promise<void>> {
  const lock = resolve(path) + '.bot-lock';
  await mkdir(dirname(lock), { recursive: true });
  const nonce = randomUUID();
  const identity = await systemProbe.identity(process.pid);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const file = await open(lock, 'wx', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            pid: process.pid,
            nonce,
            identity,
            startedAt: systemProbe.startedAt,
          } satisfies LockOwner),
        );
      } finally {
        await file.close();
      }
      return async () => {
        const saved = JSON.parse(await readFile(lock, 'utf8').catch(() => '{}'));
        if (saved.nonce === nonce) await unlink(lock);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let running = true;
      let previous = '';
      try {
        previous = await readFile(lock, 'utf8');
        const saved = JSON.parse(previous) as LockOwner;
        assert(
          Number.isInteger(saved.pid) && saved.pid > 0,
          'Invalid database lock. Stop the bot and inspect its .bot-lock file.',
        );
        running = await lockOwnerIsRunning(saved, (await stat(lock)).mtimeMs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      assert(
        !running,
        'The database is in use. Stop the bot before recovery or starting another instance.',
      );
      // A new owner may have acquired the lock while we inspected the old one.
      if ((await readFile(lock, 'utf8').catch(() => '')) !== previous) continue;
      await unlink(lock).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  throw Error('Could not acquire the database lock. Retry after the other process exits.');
}
