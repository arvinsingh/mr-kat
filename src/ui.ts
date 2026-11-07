import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  EmbedBuilder,
  type InteractionReplyOptions,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Interaction, Component } from './types.js';
import { assert } from './util.js';
import type { LogKind } from './config.js';
import { responsePath } from './response-policy.js';

export const colors = {
  info: 0x5865f2,
  success: 0x2ecc71,
  warning: 0xf1c40f,
  error: 0xe74c3c,
  moderation: 0xed4245,
  messages: 0xfee75c,
  members: 0x57f287,
  voice: 0x9b59b6,
  admin: 0x3498db,
  reports: 0xe67e22,
  automod: 0xe91e63,
  confession: 0xeb459e,
  poll: 0x1abc9c,
  suggestion: 0xf39c12,
  ticket: 0x5865f2,
  announcement: 0x2980b9,
  reminder: 0x8e44ad,
  easteregg: 0xffd166,
  starboard: 0xfee75c,
} as const;
export type Tone = keyof typeof colors;

export const noMentions = { parse: [] as ('roles' | 'users' | 'everyone')[], repliedUser: false };
const dismissedPrompts = new WeakSet<Interaction>();
const publicResponses = new WeakSet<Interaction>();
const previews = new WeakSet<Interaction>();
const outcomes = new WeakMap<Interaction, string>();
export function readOnlyResponse(i: Interaction) {
  previews.add(i);
}
export function publicResponse(i: Interaction) {
  publicResponses.add(i);
}
export function outcome(i: Interaction) {
  return previews.has(i) ? undefined : outcomes.get(i);
}
export async function dismissPrompt(i: Component): Promise<void> {
  await i.deferUpdate();
  await i.deleteReply();
  dismissedPrompts.add(i);
}
export function linkButtons(links: { label: string; url: string }[]) {
  return links.length
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          links
            .slice(0, 5)
            .map(({ label, url }) =>
              new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url),
            ),
        ),
      ]
    : [];
}
export async function reply(
  i: Interaction,
  content: string | InteractionReplyOptions,
): Promise<void> {
  const options: InteractionReplyOptions = typeof content === 'string' ? { content } : content;
  outcomes.set(i, typeof options.content === 'string' ? options.content : 'Completed.');
  if (dismissedPrompts.has(i))
    await i.followUp({ ...options, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
  else if (i.deferred || i.replied)
    await i.editReply({ ...options, allowedMentions: noMentions } as Parameters<
      typeof i.editReply
    >[0]);
  else
    await i.reply({
      ...options,
      flags: publicResponses.has(i) ? undefined : MessageFlags.Ephemeral,
      allowedMentions: noMentions,
    });
}
export function embed(title: string, description: string, tone: Tone = 'info'): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(colors[tone])
    .setTitle(title.slice(0, 256))
    .setDescription(description.slice(0, 4000))
    .setTimestamp();
}
export function auditEmbed(kind: LogKind, title: string, description: string): EmbedBuilder {
  let tone: Tone = kind;
  if (kind === 'messages' && /delet/i.test(title)) tone = 'error';
  if (kind === 'messages' && /edit/i.test(title)) tone = 'warning';
  if (kind === 'members' && /left/i.test(title)) tone = 'reports';
  return embed(title, description, tone);
}
export function auditPages(kind: LogKind, title: string, description: string): EmbedBuilder[] {
  const parts: string[] = [];
  let remaining = description || '[No details]';
  while (remaining.length > 3500) {
    let end = remaining.lastIndexOf('\n', 3500) + 1;
    if (end < 1750) end = 3500;
    // Avoid cutting a surrogate pair or a Discord mention in half.
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--;
    const open = remaining.lastIndexOf('<', end - 1);
    if (open > end - 40 && remaining.indexOf('>', open) >= end) end = open;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts.map((part, index) =>
    auditEmbed(
      kind,
      parts.length > 1 ? `${title.slice(0, 220)} · ${index + 1}/${parts.length}` : title,
      part,
    ),
  );
}
export interface Confirmation {
  command?: string;
  actor: string;
  channel: string;
  expires: number;
  kind: string;
  payload: Record<string, unknown>;
}
export async function confirm(
  app: App,
  i: Interaction,
  title: string,
  kind: string,
  payload: Record<string, unknown>,
  preview: EmbedBuilder[] = [],
): Promise<void> {
  previews.add(i);
  const key = randomUUID();
  app.store.put(i.guildId!, 'confirmation', key, {
    command: responsePath(i),
    actor: i.user.id,
    channel: i.channelId!,
    expires: Date.now() + 300000,
    kind,
    payload,
  } satisfies Confirmation);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${key}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cancel:${key}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
  await reply(i, {
    embeds: [embed('Review action', title, 'warning'), ...preview],
    components: [row],
  });
}
export function takeConfirmation(app: App, i: Component): Confirmation | undefined {
  if (!i.isButton() || !/^(confirm|cancel):/.test(i.customId)) return undefined;
  const [action, key] = i.customId.split(':');
  const pending = app.store.get<Confirmation>(i.guildId, 'confirmation', key!);
  assert(
    pending &&
      pending.actor === i.user.id &&
      pending.channel === i.channelId &&
      pending.expires > Date.now(),
    'This confirmation expired or belongs to another member. Run the command again.',
  );
  app.store.delete(i.guildId, 'confirmation', key!);
  return action === 'cancel' ? { ...pending, kind: 'cancel' } : pending;
}
