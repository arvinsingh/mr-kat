import type { GuildMember, PartialGuildMember, User, PartialUser } from 'discord.js';
import type { App, LogProfile } from './types.js';

// Use event data first, then existing caches. Logging must not fetch every author.
export function logProfile(
  app: App,
  id?: string,
  member?: GuildMember | PartialGuildMember | null,
  user?: User | PartialUser | null,
  mention = false,
): LogProfile {
  member ??= id ? app.client?.guilds?.cache?.get(app.guildId)?.members.cache?.get(id) : undefined;
  user ??= member?.user ?? (id ? app.client?.users?.cache?.get(id) : undefined);
  const name = member?.displayName ?? member?.nickname ?? user?.globalName ?? user?.username;
  return {
    name:
      name
        ?.replace(/[\r\n]/g, ' ')
        .trim()
        .slice(0, 200) || 'Unknown member',
    id,
    iconURL: member?.displayAvatarURL?.({ size: 64 }) ?? user?.displayAvatarURL?.({ size: 64 }),
    ...(mention && id ? { mention: true } : {}),
  };
}

export function systemLogProfile(app: App): LogProfile {
  const user = app.client?.user;
  const profile = logProfile(app, user?.id, undefined, user);
  return { ...profile, name: profile.name === 'Unknown member' ? 'Bot' : profile.name };
}
