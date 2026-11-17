import {
  AuditLogEvent,
  type GuildAuditLogsEntry,
  type GuildMember,
  type PartialGuildMember,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, LogProfile } from './types.js';
import { logError } from './util.js';
import { logProfile } from './log-profile.js';

type Action = 'ban' | 'kick' | 'unban';
interface Intent {
  target: string;
  action: Action;
  at: number;
  caseId?: number;
  verified?: boolean;
  actionMatched?: boolean;
  departureMatched?: boolean;
  state: 'pending' | 'applied';
}
interface Observed {
  user: string;
  at: number;
  departure?: boolean;
  action?: 'ban' | 'unban';
  profile?: LogProfile;
}
interface Pending {
  events: Observed[];
  timer: ReturnType<typeof setTimeout>;
}
const pending = new WeakMap<App, Map<string, Pending>>();
const running = new WeakMap<App, Set<Promise<void>>>();
function sendPending(app: App, user: string) {
  let work = running.get(app);
  if (!work) running.set(app, (work = new Set()));
  const task = flushOne(app, user).catch((error) => logError('member log flush', error));
  work.add(task);
  void task.finally(() => work.delete(task));
}
export function startModerationEvent(app: App, target: string, action: Action) {
  const token = randomUUID();
  app.store.put(app.guildId, 'moderationEvent', token, {
    target,
    action,
    at: Date.now(),
    state: 'pending',
  } satisfies Intent);
  return token;
}
export function completeModerationEvent(app: App, token: string, caseId: number) {
  const item = app.store.get<Intent>(app.guildId, 'moderationEvent', token);
  if (item)
    app.store.put(app.guildId, 'moderationEvent', token, { ...item, caseId, state: 'applied' });
}
export function observeModerationAudit(app: App, entry: GuildAuditLogsEntry) {
  if (entry.executorId !== app.client.user?.id) return;
  const token = [...(entry.reason ?? '').matchAll(/\[mr-kat:([\w-]+)\]/g)].at(-1)?.[1];
  if (!token) return;
  const intent = app.store.get<Intent>(app.guildId, 'moderationEvent', token);
  const action =
    entry.action === AuditLogEvent.MemberKick
      ? 'kick'
      : entry.action === AuditLogEvent.MemberBanAdd
        ? 'ban'
        : entry.action === AuditLogEvent.MemberBanRemove
          ? 'unban'
          : undefined;
  if (intent && intent.target === entry.targetId && intent.action === action)
    app.store.put(app.guildId, 'moderationEvent', token, { ...intent, verified: true });
}
function queue(app: App, event: Observed) {
  let map = pending.get(app);
  if (!map) pending.set(app, (map = new Map()));
  const existing = map.get(event.user);
  if (existing) {
    existing.events.push(event);
    return;
  }
  const timer = setTimeout(() => sendPending(app, event.user), 3000);
  timer.unref();
  map.set(event.user, { events: [event], timer });
}
export function memberDeparted(app: App, member: GuildMember | PartialGuildMember) {
  queue(app, {
    user: member.id,
    at: Date.now(),
    departure: true,
    profile: logProfile(app, member.id, member, member.user, true),
  });
}
export function banObserved(app: App, user: string, action: 'ban' | 'unban') {
  queue(app, { user, action, at: Date.now() });
}
async function flushOne(app: App, user: string, force = false) {
  const map = pending.get(app),
    batch = map?.get(user);
  if (!batch) return;
  clearTimeout(batch.timer);
  const intents = app.store
    .entriesMatching<Intent>(app.guildId, 'moderationEvent', { target: user }, 20)
    .filter(({ data }) => batch.events.some((event) => Math.abs(event.at - data.at) < 30000));
  if (
    !force &&
    Date.now() - batch.events[0]!.at < 10000 &&
    intents.some(
      ({ data }) =>
        data.state === 'pending' ||
        (data.state === 'applied' && !data.verified && !data.actionMatched),
    )
  ) {
    batch.timer = setTimeout(() => sendPending(app, user), 2000);
    batch.timer.unref();
    return;
  }
  map!.delete(user);
  const matched = (action: Action, type: 'actionMatched' | 'departureMatched') => {
    const row = intents.find(
      ({ data }) =>
        !data[type] &&
        data.action === action &&
        data.state === 'applied' &&
        data.verified &&
        data.caseId,
    );
    if (row) {
      row.data[type] = true;
      app.store.put(app.guildId, 'moderationEvent', row.key, row.data);
    }
    return !!row;
  };
  try {
    const bans = batch.events.filter((event) => event.action);
    for (const event of bans)
      if (!matched(event.action!, 'actionMatched'))
        await app.audit(
          app.guildId,
          'moderation',
          event.action === 'ban' ? 'Member banned' : 'Ban removed',
          event.action === 'ban' ? 'Banned from the server.' : 'Ban removed.',
          { at: event.at, profile: logProfile(app, user) },
        );
    let removals = bans.filter((event) => event.action === 'ban').length;
    for (const event of batch.events.filter((item) => item.departure)) {
      if (removals > 0) {
        removals--;
        matched('ban', 'departureMatched');
        continue;
      }
      if (matched('kick', 'departureMatched') || matched('ban', 'departureMatched')) continue;
      await app.audit(app.guildId, 'members', 'Member departed', 'No longer in the server.', {
        at: event.at,
        profile: event.profile,
      });
    }
  } catch (error) {
    logError('member departure log', error);
  }
}
export async function flushModerationEvents(app: App) {
  await Promise.all([
    ...[...(pending.get(app)?.keys() ?? [])].map((user) => flushOne(app, user, true)),
    ...(running.get(app) ?? []),
  ]);
}
