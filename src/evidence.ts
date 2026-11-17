import { displayText } from './presentation.js';
import { PermissionFlagsBits as P, type Message } from 'discord.js';
import type { App, Interaction } from './types.js';
import { assert, safe, safeMentions } from './util.js';
import { textChannel } from './discord.js';

export interface MessageEvidence {
  id: string;
  channel: string;
  content: string;
  url: string;
  author?: string;
  created?: number;
  capturedAt?: number;
  attachments?: { name: string; url: string }[];
}

export async function evidenceChannelAccess(
  app: App,
  i: Interaction,
  channelId: string,
  actorId = i.user.id,
) {
  const channel = await textChannel(app, i.guildId!, channelId);
  const cfg = app.store.config(i.guildId!);
  assert(
    !cfg.excludedChannels.includes(channel.id) &&
      !(channel.parentId && cfg.excludedChannels.includes(channel.parentId)),
    'Evidence capture is disabled in this channel.',
  );
  const [actor, me] = await Promise.all([
    i.guild!.members.fetch(actorId),
    i.guild!.members.fetchMe(),
  ]);
  for (const who of [actor, me])
    assert(
      channel.permissionsFor(who)?.has([P.ViewChannel, P.ReadMessageHistory]),
      'You and the bot need View Channel and Read Message History for evidence.',
    );
  return channel;
}

export async function captureEvidence(app: App, i: Interaction, source: Message) {
  assert(source.guildId === i.guildId, 'Evidence must come from this server.');
  const channel = await evidenceChannelAccess(app, i, source.channelId);
  // Take a fresh snapshot while the source still exists. Never fetch after deletion.
  const message = await channel.messages.fetch({ message: source.id, force: true });
  assert(!message.system, 'Choose a normal message as evidence.');
  return {
    id: message.id,
    channel: message.channelId,
    author: message.author.id,
    content: message.content || displayText(message),
    created: message.createdTimestamp,
    capturedAt: Date.now(),
    url: message.url,
    attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
  } satisfies MessageEvidence;
}

export async function resolveEvidence(app: App, i: Interaction, reference?: string | null) {
  if (!reference?.trim()) return undefined;
  const text = reference.trim();
  const link =
    /^https:\/\/(?:www\.)?(?:discord\.com|discordapp\.com)\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/.exec(
      text,
    );
  assert(
    link || /^\d{17,22}$/.test(text),
    'Use a Discord message link or a message ID from this channel.',
  );
  if (link) assert(link[1] === i.guildId, 'Evidence must come from this server.');
  const channel = await textChannel(app, i.guildId!, link?.[2] ?? i.channelId!);
  // captureEvidence checks permissions before accessing the content.
  return captureEvidence(app, i, {
    guildId: i.guildId,
    channelId: channel.id,
    id: link?.[3] ?? text,
  } as Message);
}

export function evidenceText(evidence: MessageEvidence) {
  return `Message evidence: ${evidence.url}\nMessage ID: ${evidence.id}\nAuthor ID: ${evidence.author ?? 'not recorded'}\nCaptured: ${evidence.capturedAt ? new Date(evidence.capturedAt).toISOString() : 'legacy record'}\n${safeMentions(evidence.content || '[No text]')}${evidence.attachments?.length ? '\n' + evidence.attachments.map((a) => `Attachment reference: ${safeMentions(a.name)} · ${a.url}`).join('\n') : ''}`;
}
export function evidenceSummary(evidence: MessageEvidence) {
  return `Evidence · ${evidence.url}${evidence.author ? `\nAuthor: <@${evidence.author}>` : ''}\n${safeMentions(evidence.content || '[No text]')}${evidence.attachments?.length ? '\nAttachments:\n' + evidence.attachments.map((file) => `[${safe(file.name, 150)}](<${file.url}>)`).join('\n') : ''}`;
}
