import {
  PermissionFlagsBits as P,
  type Guild,
  type GuildMember,
  type GuildBasedChannel,
  type PermissionResolvable,
  type Role,
} from 'discord.js';
import type { App, Interaction } from './types.js';
import { assert } from './util.js';

export const privileged = [
  P.Administrator,
  P.ManageGuild,
  P.ManageRoles,
  P.ManageChannels,
  P.KickMembers,
  P.BanMembers,
  P.ModerateMembers,
  P.ManageWebhooks,
  P.ManageMessages,
  P.MentionEveryone,
  P.ViewAuditLog,
  P.MoveMembers,
  P.MuteMembers,
  P.DeafenMembers,
  P.ManageNicknames,
  P.ManageThreads,
  P.ManageEvents,
  P.ManageGuildExpressions,
];
export function owner(i: Interaction): void {
  assert(i.user.id === i.guild!.ownerId, 'Only the server owner can change this setting.');
}
export async function requirePermission(
  app: App,
  i: Interaction,
  permission: PermissionResolvable,
  channel?: GuildBasedChannel,
): Promise<GuildMember> {
  const member = await i.guild!.members.fetch(i.user.id);
  const effective = channel ? channel.permissionsFor(member) : member.permissions;
  assert(
    effective?.has(permission),
    'You do not have the Discord permission required for this action.',
  );
  const roles = app.store.config(i.guildId!).staffRoles;
  assert(
    member.id === i.guild!.ownerId || !roles.length || roles.some((r) => member.roles.cache.has(r)),
    'Your role is not on the configured staff allowlist.',
  );
  return member;
}
export async function botPermission(
  guild: Guild,
  permission: PermissionResolvable,
  channel?: GuildBasedChannel,
): Promise<GuildMember> {
  const me = await guild.members.fetchMe();
  assert(
    (channel ? channel.permissionsFor(me) : me.permissions)?.has(permission),
    'The bot is missing a required permission. Run /diagnose.',
  );
  return me;
}
export function checkHierarchy(
  actor: Pick<GuildMember, 'id' | 'roles'>,
  target: Pick<GuildMember, 'id' | 'roles'>,
  bot: Pick<GuildMember, 'id' | 'roles'>,
  ownerId: string,
  protectedRoles: string[],
): void {
  assert(
    target.id !== ownerId && target.id !== bot.id && target.id !== actor.id,
    'This member is protected from this action.',
  );
  assert(
    !protectedRoles.some((r) => target.roles.cache.has(r)),
    'This member has a protected role.',
  );
  assert(
    actor.id === ownerId || actor.roles.highest.comparePositionTo(target.roles.highest) > 0,
    'Your highest role must be above the target member.',
  );
  assert(
    bot.roles.highest.comparePositionTo(target.roles.highest) > 0,
    'The bot role must be above the target member.',
  );
}
export async function manageableMember(
  app: App,
  i: Interaction,
  targetId: string,
  permission: PermissionResolvable,
): Promise<GuildMember> {
  const actor = await requirePermission(app, i, permission);
  const bot = await botPermission(i.guild!, permission);
  const target = await i.guild!.members.fetch(targetId);
  checkHierarchy(actor, target, bot, i.guild!.ownerId, app.store.config(i.guildId!).protectedRoles);
  return target;
}
export function safeRole(role: Role): void {
  assert(
    !role.managed && role.id !== role.guild.id && !role.permissions.any(privileged),
    'This role is managed, privileged, or @everyone and cannot be used for this automation.',
  );
}
export async function manageableRole(
  app: App,
  i: Interaction,
  role: Role,
  targetId?: string,
): Promise<void> {
  const actor = await requirePermission(app, i, P.ManageRoles);
  const bot = await botPermission(i.guild!, P.ManageRoles);
  assert(!role.managed && role.id !== i.guildId, 'This role cannot be assigned manually.');
  assert(!app.store.config(i.guildId!).protectedRoles.includes(role.id), 'This role is protected.');
  assert(
    bot.roles.highest.comparePositionTo(role) > 0,
    'Move the bot role above the role it needs to manage.',
  );
  assert(
    actor.id === i.guild!.ownerId ||
      (actor.roles.highest.comparePositionTo(role) > 0 && actor.permissions.has(role.permissions)),
    'You cannot grant or remove this role through the bot.',
  );
  // Role edits on oneself are allowed only for roles already below the actor; other targets require hierarchy checks.
  if (targetId && targetId !== actor.id) await manageableMember(app, i, targetId, P.ManageRoles);
}
export function enabled(
  app: App,
  guild: string,
  module: keyof ReturnType<App['store']['config']>['modules'],
): void {
  assert(app.store.config(guild).modules[module], `The ${module} module is disabled.`);
}
