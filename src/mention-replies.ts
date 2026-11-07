import { randomInt } from 'node:crypto';
import { PermissionFlagsBits as P, type Message } from 'discord.js';
import type { App } from './types.js';

const previousResponses = new WeakMap<App, string>();

export async function mentionReply(app: App, message: Message): Promise<void> {
  const botId = app.client.user?.id;
  if (
    !botId ||
    !message.guild ||
    message.guildId !== app.guildId ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    !new RegExp(`<@!?${botId}>`).test(message.content) ||
    !message.mentions.users.has(botId)
  )
    return;
  const cfg = app.store.config(message.guildId);
  const channel = message.channel;
  if (
    !cfg.modules.messages ||
    !cfg.mentionReplies.enabled ||
    channel.isDMBased() ||
    !channel.isSendable() ||
    cfg.excludedChannels.includes(channel.id) ||
    (channel.parentId && cfg.excludedChannels.includes(channel.parentId)) ||
    (channel.isThread() && (channel.archived || channel.locked))
  )
    return;
  const me = await message.guild.members.fetchMe();
  if (
    !channel
      .permissionsFor(me)
      ?.has([P.ViewChannel, channel.isThread() ? P.SendMessagesInThreads : P.SendMessages])
  )
    return;

  let help = 'Use `/help` to explore my features.';
  const commandsChannel = cfg.mentionReplies.commandsChannel;
  if (commandsChannel) {
    const destination = await message.guild.channels.fetch(commandsChannel).catch(() => null);
    const member = message.member ?? (await message.guild.members.fetch(message.author.id));
    if (
      destination?.isTextBased() &&
      destination.permissionsFor(me)?.has(P.ViewChannel) &&
      destination.permissionsFor(member)?.has(P.ViewChannel)
    )
      help = `Use \`/help\` to explore my features, or visit <#${destination.id}>.`;
  }

  const previous = previousResponses.get(app);
  const alternatives = cfg.mentionReplies.responses.filter((text) => text !== previous);
  const choices = alternatives.length ? alternatives : cfg.mentionReplies.responses;
  const response = choices[randomInt(choices.length)]!;
  // Choose before sending so simultaneous mentions cannot select the same previous line.
  previousResponses.set(app, response);
  await channel.send({
    content: `<@${message.author.id}> ${response}\n${help}`,
    allowedMentions: { parse: [], users: [message.author.id], roles: [], repliedUser: false },
  });
}
