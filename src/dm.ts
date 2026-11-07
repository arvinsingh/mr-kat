import type { App } from './types.js';
import { embed, noMentions } from './ui.js';
import type { Tone } from './ui.js';
import { safe } from './util.js';
import { randomUUID } from 'node:crypto';
import type { ActionRowBuilder, ButtonBuilder } from 'discord.js';

export type Delivery = 'sent' | 'blocked' | 'failed' | 'uncertain';
// Never log Discord request bodies: they can contain private messages or participant IDs.
export async function directMessage(
  app: App,
  user: string,
  title: string,
  text: string,
  tone: Tone = 'info',
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<Delivery> {
  try {
    const recipient = await app.client.users.fetch(user);
    await recipient.send({
      embeds: [embed(title, text, tone)],
      components,
      allowedMentions: noMentions,
      nonce: randomUUID().replaceAll('-', '').slice(0, 24),
      enforceNonce: true,
    });
    return 'sent';
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 50007 || code === 50278) return 'blocked';
    return typeof code === 'number' ? 'failed' : 'uncertain';
  }
}

export async function moderationNotice(
  app: App,
  guild: string,
  server: string,
  user: string,
  action: string,
  reason: string,
  details = '',
): Promise<Delivery> {
  const result = await directMessage(
    app,
    user,
    `${server.slice(0, 180)} · moderation notice`,
    `Action: **${safe(action, 70)}**\nReason: ${safe(reason, 1500)}${details ? `\n${details}` : ''}\n\nThis is an automated one-way notice. Contact the server staff for help; replies to this bot are not monitored.`,
    'moderation',
  );
  await app
    .audit(
      guild,
      'moderation',
      'Moderation DM delivery',
      `Member: <@${user}> · ${safe(action, 70)} · ${result}.`,
    )
    .catch(() => undefined);
  return result;
}
