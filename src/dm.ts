import { sendModern } from './presentation.js';
import type { App } from './types.js';
import { embed, noMentions } from './ui.js';
import type { Tone } from './ui.js';
import { safe } from './util.js';
import { randomUUID } from 'node:crypto';
import type { ActionRowBuilder, ButtonBuilder, AttachmentBuilder } from 'discord.js';
import { logOutgoingDM, reportDMInboxFailure } from './dm-conversations.js';
import { logProfile } from './log-profile.js';

export type Delivery = 'sent' | 'blocked' | 'failed' | 'uncertain';
// Never log Discord request bodies: they can contain private messages or participant IDs.
export async function directMessage(
  app: App,
  user: string,
  title: string,
  text: string,
  tone: Tone = 'info',
  components: ActionRowBuilder<ButtonBuilder>[] = [],
  files: AttachmentBuilder[] = [],
): Promise<Delivery> {
  let delivery: Delivery;
  const relay =
    tone !== 'confession' &&
    !!app.guildId &&
    app.store.config(app.guildId).modules.messages &&
    !!app.store.config(app.guildId).logs.dm;
  try {
    const recipient = await app.client.users.fetch(user);
    const sent = await sendModern(recipient, {
      embeds: [
        embed(title, `${text}${relay ? '\n\nReplies are shared with server staff.' : ''}`, tone),
      ],
      components,
      ...(files.length ? { files } : {}),
      allowedMentions: noMentions,
      nonce: randomUUID().replaceAll('-', '').slice(0, 24),
      enforceNonce: true,
    });
    if (tone === 'confession' && sent?.id && app.guildId)
      app.store.put(app.guildId, 'privateDM', sent.id, { user, kind: 'confession' });
    delivery = 'sent';
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    delivery =
      code === 50007 || code === 50278
        ? 'blocked'
        : typeof code === 'number'
          ? 'failed'
          : 'uncertain';
  }
  if (relay)
    await logOutgoingDM(
      app,
      user,
      title,
      text,
      delivery,
      files.map((file) => file.name ?? 'Attachment'),
    ).catch((error) => reportDMInboxFailure(app, error));
  return delivery;
}

export async function moderationNotice(
  app: App,
  guild: string,
  server: string,
  user: string,
  action: string,
  reason: string,
  details = '',
  logDelivery = true,
): Promise<Delivery> {
  const result = await directMessage(
    app,
    user,
    `${server.slice(0, 180)} · moderation notice`,
    `Action: **${safe(action, 70)}**\nReason: ${safe(reason, 1500)}${details ? `\n${details}` : ''}${app.store.config(guild).logs.dm ? '' : '\n\nContact the server staff for help.'}`,
    'moderation',
  );
  if (logDelivery)
    await app
      .audit(
        guild,
        'moderation',
        'Moderation DM delivery',
        `Action: ${safe(action, 70)}\nDelivery: ${result}.`,
        { profile: logProfile(app, user) },
      )
      .catch(() => undefined);
  return result;
}
