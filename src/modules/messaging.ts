import { auditChange } from '../change-receipts.js';
import { replyToDM } from '../dm-conversations.js';
import { logProfile } from '../log-profile.js';
import { sendModern, modernModal } from '../presentation.js';
import {
  PermissionFlagsBits as P,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { enabled, requirePermission } from '../permissions.js';
import { assert, safe, safeMentions, renderTemplate } from '../util.js';
import { confirm, reply, type Confirmation } from '../ui.js';
import { directMessage } from '../dm.js';
import { destination } from '../discord.js';
import { noMentions } from '../ui.js';
import { randomUUID } from 'node:crypto';

async function sendChannelText(app: App, i: Interaction, channelId: string, text: string) {
  enabled(app, i.guildId!, 'messages');
  assert(text.trim().length > 0 && text.length <= 2000, 'Use 1–2,000 characters.');
  const channel = await destination(app, i, channelId);
  await requirePermission(app, i, P.ManageMessages, channel);
  const key = i.id ?? randomUUID();
  assert(
    !app.store.get(i.guildId!, 'channelSendReceipt', key),
    'This send has already been attempted; inspect the destination before retrying.',
  );
  app.store.put(i.guildId!, 'channelSendReceipt', key, {
    channel: channelId,
    state: 'sending',
    actor: i.user.id,
  });
  try {
    const message = await sendModern(channel, {
      content: text,
      allowedMentions: noMentions,
      nonce: key.slice(-24),
      enforceNonce: true,
    });
    app.store.put(i.guildId!, 'channelSendReceipt', key, {
      channel: channelId,
      state: 'sent',
      message: message.id,
      actor: i.user.id,
    });
  } catch (error) {
    const rejected = typeof (error as { code?: unknown }).code === 'number';
    app.store.put(i.guildId!, 'channelSendReceipt', key, {
      channel: channelId,
      state: rejected ? 'failed' : 'uncertain',
      actor: i.user.id,
    });
    await reply(
      i,
      rejected
        ? 'Discord rejected the message. Check destination permissions and retry after correcting the issue.'
        : 'Delivery could not be confirmed. Inspect the destination before sending again; the message may have arrived.',
    );
    return;
  }
  await auditChange(
    app,
    i,
    'Channel message sent',
    'Message body is not copied into this record.',
    { profile: logProfile(app, i.user.id, i.member, i.user), reference: `<#${channelId}>` },
  );
  await reply(i, `Message sent in <#${channelId}>.`);
}

export async function deliverStaffDM(app: App, i: Interaction, pending: Confirmation) {
  enabled(app, i.guildId!, 'messages');
  await requirePermission(app, i, P.ManageGuild);
  const target = await i.guild!.members.fetch(String(pending.payload.target));
  assert(!target.user.bot, 'Choose a human server member.');
  const result = await directMessage(
    app,
    target.id,
    `${i.guild!.name.slice(0, 180)} · staff notice`,
    `${safe(pending.payload.text, 2200)}\n\nSent by the server staff.`,
  );
  await app.audit(
    i.guildId!,
    'moderation',
    'Staff DM delivery',
    `Staff: <@${i.user.id}>\nDelivery: ${result}\nReason: ${safeMentions(pending.payload.reason)}\nMessage body is kept only in the configured private DM inbox.`,
    { profile: logProfile(app, target.id, target) },
  );
  await reply(i, {
    content: `DM delivery: ${result}. ${result === 'uncertain' ? 'Check with the recipient before retrying; it may have arrived.' : ''}`,
    components: [],
  });
}
export const messaging: Module = {
  commands: {
    say: async (app, i) => {
      const channel = await destination(app, i, i.options.getChannel('channel')?.id ?? i.channelId);
      await requirePermission(app, i, P.ManageMessages, channel);
      enabled(app, i.guildId, 'messages');
      const text = i.options.getString('message');
      if (text) return sendChannelText(app, i, channel.id, text);
      await i.showModal(
        modernModal(
          new ModalBuilder()
            .setCustomId(`say:${channel.id}`)
            .setTitle('Send a channel message')
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId('message')
                  .setLabel('Message (Markdown; no mention pings)')
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
                  .setMaxLength(2000),
              ),
            ),
        ),
      );
    },
    dm: async (app, i) => {
      enabled(app, i.guildId, 'messages');
      await requirePermission(app, i, P.ManageGuild);
      if (i.options.getSubcommand() === 'reply') {
        await replyToDM(app, i, i.options.getString('message', true));
        return;
      }
      const action = i.options.getSubcommand();
      const name = i.options.getString('name');
      if (name)
        assert(
          /^[a-z0-9_-]{1,32}$/i.test(name),
          'Use a template name with 1–32 letters, digits, underscores or hyphens.',
        );
      if (action === 'template') {
        assert(
          app.store.get(i.guildId, 'dmTemplate', name!) ||
            app.store.entries(i.guildId, 'dmTemplate', 101).length < 100,
          'Maximum 100 templates.',
        );
        app.store.put(i.guildId, 'dmTemplate', name!, { text: i.options.getString('text', true) });
        await reply(i, 'Template saved. Placeholders: {name}, {user}, {server}.');
        return;
      }
      if (action === 'templates') {
        await reply(
          i,
          app.store
            .entries(i.guildId, 'dmTemplate', 100)
            .map((e) => safe(e.key))
            .join('\n') || 'No DM templates saved.',
        );
        return;
      }
      assert(action === 'send' || action === 'from-template', 'Unknown DM action.');
      const target = i.options.getUser('member', true);
      assert(!target.bot, 'Choose a human server member.');
      await i.guild.members.fetch(target.id);
      const template =
        action === 'from-template'
          ? app.store.get<{ text: string }>(i.guildId, 'dmTemplate', name!)
          : undefined;
      assert(action !== 'from-template' || template, 'Template not found.');
      const text = template
        ? renderTemplate(template.text, target, i.guild.name)
        : i.options.getString('message', true);
      await confirm(
        app,
        i,
        `Send one DM to ${safe(target.tag)}?\n\n${safe(text, 1200)}`,
        'staffDM',
        { target: target.id, text, reason: i.options.getString('reason', true) },
      );
    },
  },
  component: async (app, i) => {
    if (!i.isModalSubmit() || !i.customId.startsWith('say:')) return false;
    await sendChannelText(app, i, i.customId.split(':')[1]!, i.fields.getTextInputValue('message'));
    return true;
  },
};
