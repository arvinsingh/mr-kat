import type { GuildMember, PartialGuildMember, User, PartialUser } from 'discord.js';
import type { App } from './types.js';

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
    `<@${member.id}> ${member.avatar ? 'updated their server profile picture.' : 'removed their server profile picture; their global picture is now used.'}`,
    { image: member.displayAvatarURL({ size: 512 }) },
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
    `<@${user.id}> ${user.avatar ? 'updated their profile picture.' : 'removed their profile picture.'}`,
    { image: user.displayAvatarURL({ size: 512 }) },
  );
}
