import { assert } from './util.js';

const queues = new WeakMap<object, Map<string, Promise<unknown>>>();
const locks = new WeakMap<object, Set<string>>();
const renders = new WeakMap<object, Map<string, Promise<void>>>();

// Keys include the feature namespace. Owners isolate independent bot instances.
export async function serial<T>(owner: object, key: string, work: () => Promise<T>): Promise<T> {
  let pending = queues.get(owner);
  if (!pending) queues.set(owner, (pending = new Map()));
  const next = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  pending.set(key, next);
  try {
    return await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}

// Keep one queued refresh behind the active refresh; votes/state are persisted by callers.
export function coalesced(owner: object, key: string, work: () => Promise<void>): Promise<void> {
  let pending = renders.get(owner);
  if (!pending) renders.set(owner, (pending = new Map()));
  const queued = pending.get(key);
  if (queued) return queued;
  const next = serial(owner, key, async () => {
    pending.delete(key);
    await work();
  });
  pending.set(key, next);
  return next;
}

// User actions that should fail while busy must not silently turn into a queue.
export async function exclusive<T>(
  owner: object,
  key: string,
  busyMessage: string,
  work: () => Promise<T>,
): Promise<T> {
  let busy = locks.get(owner);
  if (!busy) locks.set(owner, (busy = new Set()));
  assert(!busy.has(key), busyMessage);
  busy.add(key);
  try {
    return await work();
  } finally {
    busy.delete(key);
  }
}
