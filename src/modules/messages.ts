import {
  PermissionFlagsBits as P,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { App, Module, Interaction } from '../types.js';
import { randomUUID } from 'node:crypto';
import { requirePermission, botPermission, enabled } from '../permissions.js';
import { assert, duration, safe, UserError } from '../util.js';
import { confirm, reply, noMentions, type Confirmation } from '../ui.js';
import { destination } from '../discord.js';
import { announcementText, announcementEmbed } from '../announcements.js';

async function everyonePermission(app: App, i: Interaction, channel: GuildTextBasedChannel) {
  const member = await requirePermission(app, i, P.ManageMessages, channel);
  assert(
    channel.permissionsFor(member)?.has(P.MentionEveryone),
    'You need the Mention @everyone, @here, and All Roles permission in the announcement channel.',
  );
  const me = await botPermission(i.guild!, P.EmbedLinks, channel);
  assert(
    channel.permissionsFor(me)?.has(P.MentionEveryone),
    'The bot needs the Mention @everyone, @here, and All Roles permission in the announcement channel.',
  );
}
export async function deliverEveryoneAnnouncement(app: App, i: Interaction, pending: Confirmation) {
  enabled(app, i.guildId!, 'messages');
  await requirePermission(app, i, P.ManageMessages);
  const p = pending.payload;
  const channel = await destination(app, i, String(p.channel));
  await everyonePermission(app, i, channel);
  const userReference = typeof p.userReference === 'string' ? p.userReference : undefined;
  const channelReference = typeof p.channelReference === 'string' ? p.channelReference : undefined;
  await validateReferences(i, userReference, channelReference);
  const card = announcementEmbed(String(p.title), String(p.text));
  const key = String(p.deliveryId);
  assert(
    /^[a-f0-9]{24}$/.test(key),
    'Invalid announcement delivery reference. Open a new builder.',
  );
  assert(
    !app.store.get(i.guildId!, 'announcementDelivery', key),
    'This announcement was already attempted. Check the destination before creating a new one.',
  );
  const receipt: { state: string; channel: string; actor: string; message?: string } = {
    state: 'started',
    channel: channel.id,
    actor: i.user.id,
  };
  app.store.put(i.guildId!, 'announcementDelivery', key, receipt);
  let message;
  try {
    // @everyone must be message content to notify; embed-only mentions do not notify.
    message = await channel.send({
      content: '@everyone',
      embeds: [card],
      allowedMentions: { parse: ['everyone'], users: [], roles: [], repliedUser: false },
      nonce: key,
      enforceNonce: true,
    });
  } catch (error) {
    const { status, code } = error as { status?: number; code?: number };
    const rejected =
      (status !== undefined && status >= 400 && status < 500 && status !== 429) ||
      [50001, 50013, 10003, 50035].includes(code ?? 0);
    receipt.state = rejected ? 'failed' : 'uncertain';
    app.store.put(i.guildId!, 'announcementDelivery', key, receipt);
    throw new UserError(
      receipt.state === 'uncertain'
        ? 'Discord did not confirm delivery. The announcement and ping may already have been sent. Check the destination before trying again; this confirmation cannot resend it.'
        : 'Discord rejected the announcement. Check bot permissions and the destination before opening a new builder.',
    );
  }
  receipt.state = 'sent';
  receipt.message = message.id;
  app.store.put(i.guildId!, 'announcementDelivery', key, receipt);
  app.store.put(i.guildId!, 'announcement', message.id, {
    actor: i.user.id,
    channel: channel.id,
    everyone: true,
  });
  await reply(i, `Announcement published in <#${channel.id}> with @everyone.`);
}

async function validateReferences(i: Interaction, user?: string, channel?: string) {
  if (user) await i.guild!.members.fetch(user);
  if (channel) {
    const selected = await i.guild!.channels.fetch(channel);
    const actor = await i.guild!.members.fetch(i.user.id);
    assert(
      selected && selected.permissionsFor(actor)?.has(P.ViewChannel),
      'Choose a server channel you can view for mention_channel.',
    );
  }
}
export const messages: Module = {
  commands: {
    purge: async (app, i) => {
      enabled(app, i.guildId, 'messages');
      assert(i.channel?.isTextBased(), 'Use a text channel.');
      await requirePermission(app, i, P.ManageMessages, i.channel);
      await botPermission(i.guild, [P.ManageMessages, P.ReadMessageHistory], i.channel);
      const count = i.options.getInteger('count', true),
        scan = i.options.getInteger('scan') ?? Math.max(count, 200),
        user = i.options.getUser('member'),
        filter = i.options.getString('filter') ?? 'all',
        contains = i.options.getString('contains')?.toLowerCase(),
        older = i.options.getBoolean('older') ?? false;
      const date = (key: string) => {
        const text = i.options.getString(key);
        if (!text) return undefined;
        const value = Date.parse(text);
        assert(Number.isFinite(value), `Invalid ${key} date. Use ISO format.`);
        return value;
      };
      const after = date('after'),
        before = date('before');
      if (after && before) assert(after < before, 'The after date must precede before.');
      let cursor: string | undefined;
      let inspected = 0;
      let oldSkipped = 0;
      const ids: string[] = [];
      while (inspected < scan && ids.length < count) {
        const page = await i.channel.messages.fetch({
          limit: Math.min(100, scan - inspected),
          ...(cursor ? { before: cursor } : {}),
        });
        if (!page.size) break;
        for (const message of page.values()) {
          inspected++;
          if (
            message.pinned ||
            (user && message.author.id !== user.id) ||
            (contains && !message.content.toLowerCase().includes(contains)) ||
            (after && message.createdTimestamp < after) ||
            (before && message.createdTimestamp > before)
          )
            continue;
          if (
            (filter === 'bots' && !message.author.bot) ||
            (filter === 'links' && !/https?:\/\//i.test(message.content)) ||
            (filter === 'attachments' && !message.attachments.size)
          )
            continue;
          if (!older && message.createdTimestamp < Date.now() - 14 * 86400000) {
            oldSkipped++;
            continue;
          }
          ids.push(message.id);
          if (ids.length >= count) break;
        }
        cursor = page.last()!.id;
      }
      assert(ids.length, 'No matching messages in the scanned range.');
      await confirm(
        app,
        i,
        `Delete ${ids.length} matched messages from <#${i.channelId}>?\nScanned at most ${scan}; skipped ${oldSkipped} older matches. Pinned messages are excluded.\nReason: ${safe(i.options.getString('reason') ?? 'No reason supplied.', 500)}\nDeletion cannot be undone.${older ? ' Older messages will be deleted individually.' : ''}`,
        'purge',
        {
          channel: i.channelId,
          ids,
          older,
          reason: i.options.getString('reason') ?? 'No reason supplied.',
        },
      );
    },
    announce: async (app, i) => {
      enabled(app, i.guildId, 'messages');
      await requirePermission(app, i, P.ManageMessages);
      const channel = await destination(app, i, i.options.getChannel('channel', true).id);
      const action = i.options.getSubcommand();
      const userReference = i.options.getUser('mention_user')?.id;
      const channelReference = i.options.getChannel('mention_channel')?.id;
      await validateReferences(i, userReference, channelReference);
      if (action === 'builder' || action === 'everyone') {
        if (action === 'everyone') await everyonePermission(app, i, channel);
        // The router leaves this command undeferred because opening a modal must be the first response.
        const modal = new ModalBuilder()
          .setCustomId(
            `announce:${channel.id}:${userReference ?? '0'}:${channelReference ?? '0'}${action === 'everyone' ? ':everyone' : ''}`,
          )
          .setTitle(action === 'everyone' ? 'Announcement · @everyone' : 'Build announcement')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('title')
                .setLabel('Title')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(256)
                .setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('text')
                .setLabel('Announcement')
                .setPlaceholder(
                  'Use {user} and {channel} for selected mentions; other text supports Discord Markdown.',
                )
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(4000)
                .setRequired(true),
            ),
          );
        await i.showModal(modal);
        return;
      }
      const title = i.options.getString('title', true),
        text = announcementText(i.options.getString('text', true), {
          user: userReference,
          channel: channelReference,
        });
      const card = announcementEmbed(title, text);
      if (action === 'schedule') {
        const key = app.store.job(
          i.guildId,
          i.user.id,
          'announce',
          { channel: channel.id, title, text },
          Date.now() + duration(i.options.getString('in', true)),
        );
        await reply(i, `Announcement scheduled. Job: ${key}.`);
        return;
      }
      if (action === 'edit') {
        const message = await channel.messages.fetch(i.options.getString('message', true));
        assert(
          message.author.id === app.client.user!.id,
          'Only bot-authored announcements can be edited.',
        );
        const tracked = app.store.get(i.guildId, 'announcement', message.id);
        assert(tracked, 'This message is not a tracked announcement.');
        await message.edit({
          embeds: [card],
          allowedMentions: noMentions,
        });
      } else {
        const message = await channel.send({
          embeds: [card],
          allowedMentions: noMentions,
        });
        app.store.put(i.guildId, 'announcement', message.id, {
          actor: i.user.id,
          channel: channel.id,
        });
      }
      await reply(i, 'Announcement saved.');
    },
    tag: async (app, i) => {
      enabled(app, i.guildId, 'messages');
      const action = i.options.getSubcommand();
      const name = i.options.getString('name')?.toLowerCase();
      if (action === 'list') {
        await reply(
          i,
          app.store
            .entries(i.guildId, 'tag', 100)
            .map((e) => safe(e.key, 50))
            .join(', ') || 'No saved replies.',
        );
        return;
      }
      assert(
        name && /^[a-z0-9_-]{1,32}$/.test(name),
        'Tag names use 1–32 letters, numbers, underscores, or hyphens.',
      );
      if (action === 'get') {
        const tag = app.store.get<{ text: string }>(i.guildId, 'tag', name);
        assert(tag, 'Tag not found.');
        await reply(i, tag.text);
        return;
      }
      await requirePermission(app, i, P.ManageMessages);
      if (action === 'delete') app.store.delete(i.guildId, 'tag', name);
      else
        app.store.put(i.guildId, 'tag', name, {
          text: i.options.getString('text', true),
          actor: i.user.id,
        });
      await reply(i, 'Saved replies updated.');
    },
    sticky: async (app, i) => {
      enabled(app, i.guildId, 'messages');
      assert(i.channel, 'Channel missing.');
      await requirePermission(app, i, P.ManageMessages, i.channel);
      if (i.options.getSubcommand() === 'remove')
        app.store.delete(i.guildId, 'sticky', i.channelId);
      else {
        await destination(app, i, i.channelId);
        app.store.put(i.guildId, 'sticky', i.channelId, {
          text: i.options.getString('text', true),
          last: 0,
        });
      }
      await reply(
        i,
        'Sticky configuration updated. Messages are refreshed at most every five minutes when the channel is active.',
      );
    },
  },
  component: async (app, i) => {
    if (!i.isModalSubmit() || !i.customId.startsWith('announce:')) return false;
    enabled(app, i.guildId, 'messages');
    await requirePermission(app, i, P.ManageMessages);
    const channel = await destination(app, i, i.customId.split(':')[1]!);
    const parts = i.customId.split(':');
    const everyone = parts[4] === 'everyone';
    assert(
      parts.length <= 5 && (!parts[4] || everyone),
      'This announcement form is no longer supported. Open a new builder.',
    );
    const userReference = parts[2] && parts[2] !== '0' ? parts[2] : undefined;
    const channelReference = parts[3] && parts[3] !== '0' ? parts[3] : undefined;
    await validateReferences(i, userReference, channelReference);
    const title = i.fields.getTextInputValue('title');
    const text = announcementText(i.fields.getTextInputValue('text'), {
      user: userReference,
      channel: channelReference,
    });
    const card = announcementEmbed(title, text);
    if (everyone) {
      await everyonePermission(app, i, channel);
      await confirm(
        app,
        i,
        `Publish this announcement in <#${channel.id}> and notify @everyone? Nothing is sent until you confirm. This preview expires after five minutes.`,
        'announceEveryone',
        {
          channel: channel.id,
          title,
          text,
          userReference,
          channelReference,
          deliveryId: randomUUID().replaceAll('-', '').slice(0, 24),
        },
        [card],
      );
      return true;
    }
    const message = await channel.send({
      embeds: [card],
      allowedMentions: noMentions,
    });
    app.store.put(i.guildId, 'announcement', message.id, { actor: i.user.id, channel: channel.id });
    await reply(i, 'Announcement published.');
    return true;
  },
};
