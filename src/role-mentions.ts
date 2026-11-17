import { modernMessage } from './presentation.js';
import { randomInt } from 'node:crypto';
import { PermissionFlagsBits as P, type Message } from 'discord.js';
import type { App } from './types.js';
import { safe } from './util.js';
import { logProfile } from './log-profile.js';

interface Window {
  times: number[];
  replyAt: number;
  alertAt: number;
}
const windows = new WeakMap<App, Map<string, Window>>();

export async function roleMentionReply(app: App, message: Message): Promise<boolean> {
  const cfg = app.store.config(app.guildId),
    guard = cfg.roleMentions,
    channel = message.channel;
  if (
    !guard.enabled ||
    !cfg.modules.automod ||
    !message.guild ||
    channel.isDMBased() ||
    message.guildId !== app.guildId ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    (guard.channel && channel.id !== guard.channel && channel.parentId !== guard.channel) ||
    cfg.excludedChannels.includes(channel.id) ||
    (channel.parentId && cfg.excludedChannels.includes(channel.parentId)) ||
    !message.mentions.roles.size
  )
    return false;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id));
  if (
    member.permissions.has(P.Administrator) ||
    guard.exemptRoles.some((id) => member.roles.cache.has(id))
  )
    return false;
  const now = Date.now(),
    cutoff = now - guard.windowSeconds * 1000;
  let tracked = windows.get(app);
  if (!tracked) windows.set(app, (tracked = new Map()));
  if (tracked.size >= 1000)
    for (const [id, row] of tracked) if (!row.times.some((t) => t > cutoff)) tracked.delete(id);
  if (tracked.size >= 1000 && !tracked.has(member.id)) tracked.delete(tracked.keys().next().value!);
  const row = tracked.get(member.id) ?? { times: [], replyAt: 0, alertAt: 0 };
  row.times = row.times.filter((t) => t > cutoff).slice(-50);
  row.times.push(now);
  tracked.set(member.id, row);
  const protectedPing = guard.roles.some((id) => message.mentions.roles.has(id));
  const repeated =
    row.times.length >= guard.repeatLimit || message.mentions.roles.size >= guard.repeatLimit;
  if (!protectedPing && !repeated) return false;
  if (repeated && row.alertAt < cutoff) {
    row.alertAt = now;
    app.store.put(app.guildId, 'roleMentionIncident', message.id, {
      author: member.id,
      channel: channel.id,
      roles: [...message.mentions.roles.keys()],
      content: message.content,
      created: now,
    });
    await app.audit(
      app.guildId,
      'automod',
      'Repeated role mentions',
      `${row.times.length} messages in ${guard.windowSeconds}s.\nThe redirect guard did not delete the message or retract notifications.`,
      { profile: logProfile(app, member.id, member), reference: message.url },
    );
  }
  // Bound automatic replies without imposing a cooldown on any user command.
  if (row.replyAt > now - 15000) return true;
  if (
    !channel.isSendable() ||
    channel.isDMBased() ||
    (channel.isThread() && (channel.archived || channel.locked))
  )
    return true;
  const me = await message.guild.members.fetchMe();
  if (
    !channel
      .permissionsFor(me)
      ?.has([P.ViewChannel, channel.isThread() ? P.SendMessagesInThreads : P.SendMessages])
  )
    return true;
  let support = 'Use `/ticket open` to contact staff privately.';
  if (guard.supportChannel) {
    const destination = await message.guild.channels.fetch(guard.supportChannel).catch(() => null);
    if (
      destination?.permissionsFor(member)?.has(P.ViewChannel) &&
      destination.permissionsFor(me)?.has(P.ViewChannel)
    )
      support = `Please use <#${destination.id}> to contact staff.`;
  }
  row.replyAt = now;
  await message.reply(
    modernMessage({
      content: `${safe(guard.responses[randomInt(guard.responses.length)]!, 250)}\n${support}`,
      allowedMentions: { parse: [], repliedUser: false },
    }),
  );
  return true;
}
