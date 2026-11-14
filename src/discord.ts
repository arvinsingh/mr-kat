import { sendModern } from './presentation.js';
import {
  PermissionFlagsBits as P,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
} from 'discord.js';
import type { App, Interaction } from './types.js';
import { assert } from './util.js';
import { botPermission } from './permissions.js';
import { noMentions } from './ui.js';
export function missingChannel(error: unknown): null {
  if ((error as { code?: number }).code === 10003) return null;
  throw error;
}
export async function textChannel(
  app: App,
  guildId: string,
  channelId: string,
): Promise<GuildTextBasedChannel> {
  const channel = await app.client.channels.fetch(channelId);
  assert(
    channel &&
      !channel.isDMBased() &&
      channel.isTextBased() &&
      channel.guildId === guildId &&
      channel.isSendable(),
    'Choose an accessible text channel in this server.',
  );
  await botPermission(channel.guild, P.ViewChannel, channel);
  return channel;
}
export async function destination(
  app: App,
  i: Interaction,
  channelId: string,
): Promise<GuildTextBasedChannel> {
  const channel = await textChannel(app, i.guildId!, channelId);
  const actor = await channel.guild.members.fetch(i.user.id);
  assert(
    channel
      .permissionsFor(actor)
      ?.has([P.ViewChannel, channel.isThread() ? P.SendMessagesInThreads : P.SendMessages]),
    'You cannot post in that channel.',
  );
  await botPermission(
    channel.guild,
    channel.isThread() ? P.SendMessagesInThreads : P.SendMessages,
    channel,
  );
  return channel;
}
export async function send(
  app: App,
  guild: string,
  channelId: string,
  options: string | MessageCreateOptions,
) {
  const channel = await textChannel(app, guild, channelId);
  return sendModern(channel, {
    ...(typeof options === 'string' ? { content: options } : options),
    allowedMentions: noMentions,
  });
}
