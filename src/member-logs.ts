import type { GuildMember, PartialGuildMember, User, PartialUser } from 'discord.js';
import type { App, LogProfile } from './types.js';
import { logError, safe } from './util.js';
import { logProfile } from './log-profile.js';

interface RoleChanges {
  user: string;
  profile: LogProfile;
  first: Set<string>;
  latest: Set<string>;
  touched: Set<string>;
  at: number;
  timer?: ReturnType<typeof setTimeout>;
}
const pending = new WeakMap<App, Map<string, RoleChanges>>();
const sending = new WeakMap<App, Set<Promise<void>>>();
function sendRoles(app: App, change: RoleChanges) {
  pending.get(app)?.delete(change.user);
  if (change.timer) clearTimeout(change.timer);
  const added = [...change.latest].filter((id) => !change.first.has(id));
  const removed = [...change.first].filter((id) => !change.latest.has(id));
  const reversed = [...change.touched].filter(
    (id) => change.first.has(id) === change.latest.has(id),
  );
  if (!added.length && !removed.length && !reversed.length) return Promise.resolve();
  const roles = (ids: string[]) => ids.map((id) => `<@&${id}>`).join(', ');
  const title =
    reversed.length || (added.length && removed.length)
      ? 'Roles changed'
      : added.length
        ? 'Roles added'
        : 'Roles removed';
  const text = [
    added.length ? `Added: ${roles(added)}` : '',
    removed.length ? `Removed: ${roles(removed)}` : '',
    reversed.length ? `Changed then restored: ${roles(reversed)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  let work: Set<Promise<void>> | undefined = sending.get(app);
  if (!work) sending.set(app, (work = new Set()));
  const task = app
    .audit(app.guildId, 'members', title, text, { at: change.at, profile: change.profile })
    .then(() => undefined)
    .catch((error) => logError('member role log', error));
  work.add(task);
  void task.finally(() => work.delete(task));
  return task;
}
// Capture synchronously: discord.js reuses the live member object for later updates.
export function captureMemberChanges(
  app: App,
  old: GuildMember | PartialGuildMember,
  member: GuildMember,
) {
  const nickname =
    !old.partial && old.nickname !== member.nickname
      ? `Before: ${safe(old.nickname ?? old.user.username)}\n---\nAfter: ${safe(member.nickname ?? member.user.username)}`
      : undefined;
  const profile = logProfile(app, member.id, member);
  if (old.partial) return { nickname, profile };
  const before = new Set(old.roles.cache.keys()),
    after = new Set(member.roles.cache.keys());
  const changed = new Set(
    [...before, ...after].filter(
      (id) => before.has(id) !== after.has(id) && id !== member.guild.id,
    ),
  );
  for (const id of before)
    if (!after.has(id)) app.store.delete(app.guildId, 'roleTimer', `${member.id}:${id}`);
  if (!changed.size || !app.store.config(app.guildId).modules.logging) return { nickname, profile };
  let map = pending.get(app);
  if (!map) pending.set(app, (map = new Map()));
  let item = map.get(member.id);
  if (!item) {
    item = {
      user: member.id,
      profile,
      first: before,
      latest: after,
      touched: new Set(),
      at: Date.now(),
    };
    map.set(member.id, item);
  }
  item.latest = after;
  item.profile = profile;
  for (const id of changed) item.touched.add(id);
  if (item.timer) clearTimeout(item.timer);
  const captured = item;
  item.timer = setTimeout(
    () => void sendRoles(app, captured),
    Math.max(0, Math.min(3000, item.at + 10000 - Date.now())),
  );
  item.timer.unref();
  return { nickname, profile };
}
export async function flushMemberLogs(app: App) {
  await Promise.all([
    ...[...(pending.get(app)?.values() ?? [])].map((item) => sendRoles(app, item)),
    ...(sending.get(app) ?? []),
  ]);
}

export async function memberAvatarChanged(
  app: App,
  old: GuildMember | PartialGuildMember,
  member: GuildMember,
) {
  if (member.guild.id !== app.guildId || old.partial || old.avatar === member.avatar) return;
  await app.audit(
    app.guildId,
    'members',
    'Server profile picture changed',
    member.avatar
      ? 'Updated their server profile picture.'
      : 'Removed their server profile picture; their global picture is now used.',
    { profile: logProfile(app, member.id, member), image: member.displayAvatarURL({ size: 512 }) },
  );
}

export async function userAvatarChanged(app: App, old: User | PartialUser, user: User) {
  if (
    old.partial ||
    old.avatar === user.avatar ||
    !app.client.guilds.cache.get(app.guildId)?.members.cache.has(user.id)
  )
    return;
  await app.audit(
    app.guildId,
    'members',
    'Profile picture changed',
    user.avatar ? 'Updated their profile picture.' : 'Removed their profile picture.',
    {
      profile: logProfile(app, user.id, undefined, user),
      image: user.displayAvatarURL({ size: 512 }),
    },
  );
}
