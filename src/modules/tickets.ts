import { modernEdit, sendModern, modernModal, displayText } from '../presentation.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits as P,
  type TextChannel,
} from 'discord.js';
import type { App, Module, Interaction } from '../types.js';
import { requirePermission, botPermission, enabled } from '../permissions.js';
import { assert, safe, logError } from '../util.js';
import { reply, confirm, type Confirmation } from '../ui.js';
import { directMessage } from '../dm.js';
import { ticketCard, ticketStateCard } from '../ticket-ui.js';
import { destination } from '../discord.js';
import { channelNotice } from '../notices.js';
import { channelLabel } from '../channel-label.js';
import { logProfile } from '../log-profile.js';
import {
  ensureTicketCategory,
  withTicketCategoryLock,
  reconcileTicketCategories,
  ticketChannelDeleted,
} from '../ticket-categories.js';
export interface Ticket {
  owner: string;
  subject: string;
  description?: string;
  controlMessage?: string;
  controlError?: string;
  closureDM?: string;
  transcriptCaptured?: boolean;
  status: 'open' | 'closed';
  created: number;
  closedAt?: number;
  claimed?: string;
  claimedAt?: number;
  reason?: string;
}
const opening = new Set<string>();
function staff(app: App, i: Interaction): boolean {
  return (
    i.user.id === i.guild!.ownerId ||
    ((i.memberPermissions?.has(P.ManageMessages) ?? false) &&
      (!app.store.config(i.guildId!).staffRoles.length ||
        app.store.config(i.guildId!).staffRoles.some((r) => i.member!.roles.cache.has(r))))
  );
}
export async function openTicket(app: App, i: Interaction, subject: string, description?: string) {
  enabled(app, i.guildId!, 'tickets');
  const key = `${i.guildId}:${i.user.id}`;
  assert(!opening.has(key), 'Your ticket is being created.');
  opening.add(key);
  let categoryReady = false;
  let createdChannel: string | undefined;
  try {
    const channel = await withTicketCategoryLock(app, i.guild!, async () => {
      const cfg = app.store.config(i.guildId!);
      assert(
        !app.store.entriesMatching(i.guildId!, 'ticket', { owner: i.user.id, status: 'open' }, 1)
          .length,
        'You already have an open ticket.',
      );
      assert(
        app.store.entriesMatching(i.guildId!, 'ticket', { status: 'open' }, 50).length < 50,
        'The open-ticket limit has been reached.',
      );
      await botPermission(i.guild!, [P.ManageChannels, P.ManageRoles]);
      const category = await ensureTicketCategory(app, i.guild!);
      categoryReady = true;
      const channel = await i.guild!.channels.create({
        name: `ticket-${i.user.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: i.guildId!, deny: [P.ViewChannel] },
          {
            id: i.user.id,
            allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles],
          },
          {
            id: app.client.user!.id,
            allow: [
              P.ViewChannel,
              P.SendMessages,
              P.ReadMessageHistory,
              P.ManageChannels,
              P.ManageRoles,
              P.AttachFiles,
              P.EmbedLinks,
            ],
          },
          ...cfg.staffRoles.map((id) => ({
            id,
            allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
          })),
          { id: i.guild!.ownerId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
        ],
        reason: `Support request by ${i.user.id}`,
      });
      app.store.put(i.guildId!, 'ticket', channel.id, {
        owner: i.user.id,
        subject,
        ...(description ? { description } : {}),
        status: 'open',
        created: Date.now(),
      } satisfies Ticket);
      createdChannel = channel.id;
      ticketBusy.add(`${i.guildId}:${channel.id}`);
      return channel;
    });
    const ticket = app.store.get<Ticket>(i.guildId!, 'ticket', channel.id)!;
    const controls = await updateTicketCard(app, i.guildId!, channel, ticket);
    await reply(
      i,
      `Your private ticket is ready: ${channelLabel(channel.id, channel.name)}.${controls ? '' : ' The controls could not be confirmed; use /ticket commands inside it.'}`,
    );
  } catch (error) {
    if (categoryReady)
      await reconcileTicketCategories(app, i.guild!).catch((cleanupError) =>
        logError('ticket category cleanup', cleanupError),
      );
    throw error;
  } finally {
    if (createdChannel) ticketBusy.delete(`${i.guildId}:${createdChannel}`);
    opening.delete(key);
  }
}
async function updateTicketCard(app: App, guild: string, channel: TextChannel, ticket: Ticket) {
  try {
    let updated = false;
    if (ticket.controlMessage) {
      const message = await channel.messages
        .fetch(ticket.controlMessage)
        .catch((error: { code?: number }) => {
          if (error.code === 10008) return null;
          throw error;
        });
      if (message?.author.id === app.client.user!.id) {
        await message.edit(modernEdit({ ...ticketStateCard(ticket), content: null, embeds: [] }));
        updated = true;
      }
    }
    if (!updated) {
      const message = await sendModern(channel, ticketStateCard(ticket));
      if (message?.id) ticket.controlMessage = message.id;
    }
    delete ticket.controlError;
    app.store.put(guild, 'ticket', channel.id, ticket);
    return true;
  } catch {
    ticket.controlError =
      'Control message delivery could not be confirmed. Use /ticket commands; check channel access before trying again.';
    app.store.put(guild, 'ticket', channel.id, ticket);
    await app
      .audit(
        guild,
        'reports',
        'Ticket controls unavailable',
        `Status: ${ticket.status}. ${ticket.controlError}`,
        {
          profile: logProfile(app, ticket.owner),
          reference: channelLabel(channel.id, channel.name),
        },
      )
      .catch(() => undefined);
    return false;
  }
}

export async function deleteTicketChannel(app: App, i: Interaction, pending: Confirmation) {
  const lockKey = i.guildId + ':' + String(pending.payload.channel);
  assert(!ticketBusy.has(lockKey), 'This ticket is being updated. Please try again shortly.');
  ticketBusy.add(lockKey);
  try {
    const channel = await i.guild!.channels.fetch(String(pending.payload.channel));
    assert(channel?.type === ChannelType.GuildText, 'Ticket channel no longer exists.');
    await requirePermission(app, i, [P.ManageMessages, P.ManageChannels], channel);
    await botPermission(i.guild!, P.ManageChannels, channel);
    const ticket = app.store.get<Ticket>(i.guildId!, 'ticket', channel.id);
    assert(
      ticket &&
        ticket.status === 'closed' &&
        ticket.created === pending.payload.created &&
        ticket.closedAt === pending.payload.closedAt,
      'The ticket changed since confirmation; deletion cancelled.',
    );
    await reply(i, 'Deletion approved. Deleting this closed ticket channel now.');
    await channel.delete('Closed support ticket deletion');
    app.store.delete(i.guildId!, 'ticket', channel.id);
    await ticketChannelDeleted(app, channel).catch((error) =>
      logError('ticket category cleanup', error),
    );
    await app.audit(
      i.guildId!,
      'reports',
      'Ticket channel deleted',
      `Deleted by: <@${i.user.id}>${ticket.claimed && ticket.claimed !== i.user.id ? `\nHandling staff: <@${ticket.claimed}>` : ''}\nRequest: ${safe(ticket.subject, 200)}\nClosing reason: ${safe(ticket.reason ?? 'Not recorded', 500)}\nClosure DM: ${ticket.closureDM ?? 'not recorded'} · Transcript: ${ticket.transcriptCaptured === undefined ? 'not recorded' : ticket.transcriptCaptured ? 'captured' : 'failed'}`,
      { profile: logProfile(app, ticket.owner), reference: channelLabel(channel.id, channel.name) },
    );
  } finally {
    ticketBusy.delete(lockKey);
  }
}

export async function ticketTranscript(channel: TextChannel): Promise<Buffer> {
  let cursor: string | undefined;
  const lines: { id: string; text: string }[] = [];
  let bytes = 0;
  for (let page = 0; page < 10; page++) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(cursor ? { before: cursor } : {}),
    });
    if (!messages.size) break;
    for (const message of messages.values()) {
      const text = `${message.createdAt.toISOString()} ${message.author.tag} (${message.author.id})\n${message.content}\n${message.embeds.map((e) => `${e.title ?? ''}\n${e.description ?? ''}`).join('\n')}\n${displayText({ components: message.components ?? [] })}\n${message.attachments.map((a) => `Attachment metadata: ${a.name} (${a.size} bytes); ${a.url}`).join('\n')}\n`;
      bytes += Buffer.byteLength(text);
      assert(
        bytes < 4_000_000,
        'Transcript exceeded the 4 MB limit. Export a smaller range manually.',
      );
      lines.push({ id: message.id, text });
    }
    cursor = messages.last()!.id;
  }
  lines.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return Buffer.from(
    `Ticket transcript, up to the latest 1000 accessible messages. Attachment links may expire.\n\n${lines.map((l) => l.text).join('\n')}`,
  );
}
const ticketBusy = new Set<string>();
async function ticketControl(app: App, i: Interaction, action: string, reason?: string) {
  const key = `${i.guildId}:${i.channelId}`;
  assert(!ticketBusy.has(key), 'This ticket is being updated. Please try again shortly.');
  ticketBusy.add(key);
  try {
    await performTicketControl(app, i, action, reason);
  } finally {
    ticketBusy.delete(key);
  }
}
async function performTicketControl(app: App, i: Interaction, action: string, reason?: string) {
  enabled(app, i.guildId!, 'tickets');
  const channel = i.channel;
  assert(channel?.type === ChannelType.GuildText, 'Use this in a ticket channel.');
  const ticket = app.store.get<Ticket>(i.guildId!, 'ticket', channel.id);
  assert(ticket, 'This is not a managed ticket.');
  const isStaff = staff(app, i);
  if (isStaff) await requirePermission(app, i, P.ManageMessages, channel);
  assert(isStaff || ticket.owner === i.user.id, 'You do not have access to manage this ticket.');
  if (action === 'transcript') {
    assert(isStaff, 'Only staff can export transcripts.');
    await botPermission(i.guild!, [P.ReadMessageHistory, P.AttachFiles], channel);
    const content = await ticketTranscript(channel);
    await reply(i, {
      files: [new AttachmentBuilder(content, { name: `ticket-${channel.id}.txt` })],
    });
    return;
  }
  if (action === 'claim') {
    assert(isStaff, 'Only staff can claim tickets.');
    assert(ticket.status === 'open', 'Reopen the ticket first.');
    assert(
      !ticket.claimed || ticket.claimed === i.user.id,
      `This ticket is already claimed by <@${ticket.claimed}>. Other staff can still help.`,
    );
    if (ticket.claimed === i.user.id && ticket.claimedAt) {
      await reply(
        i,
        `You already claimed this ticket at <t:${Math.floor(ticket.claimedAt / 1000)}:F>.`,
      );
      return;
    }
    ticket.claimed = i.user.id;
    ticket.claimedAt = Date.now();
    app.store.put(i.guildId!, 'ticket', channel.id, ticket);
    if (ticket.controlMessage) await updateTicketCard(app, i.guildId!, channel, ticket);
    const announced = await channelNotice(
      app,
      i.guildId!,
      channel.id,
      'reports',
      'Ticket claimed',
      `Claimed by <@${ticket.claimed}>\nClaimed: <t:${Math.floor(ticket.claimedAt / 1000)}:F>\nThis staff member is handling your request. Other authorized staff can still help.`,
    );
    await app.audit(
      i.guildId!,
      'reports',
      'Ticket claim',
      `Claimed by: <@${ticket.claimed}>\nRequest: ${safe(ticket.subject, 200)}`,
      { profile: logProfile(app, ticket.owner), reference: channelLabel(channel.id, channel.name) },
    );
    await reply(
      i,
      `Ticket claimed by <@${ticket.claimed}>.${announced ? '' : ' Assignment saved, but the channel notice could not be confirmed; check the admin log.'}`,
    );
    return;
  }
  if (action === 'delete') {
    assert(isStaff, 'Only staff can delete ticket channels.');
    await requirePermission(app, i, P.ManageChannels, channel);
    assert(ticket.status === 'closed', 'Close the ticket before deleting its channel.');
    await confirm(
      app,
      i,
      'Permanently delete this closed ticket channel? Export any transcript you need first.',
      'ticketDelete',
      {
        channel: channel.id,
        created: ticket.created,
        closedAt: ticket.closedAt,
      },
    );
    return;
  }
  if (action === 'close') {
    assert(ticket.status === 'open', 'This ticket is already closed.');
    await botPermission(i.guild!, [P.ManageChannels, P.ManageRoles], channel);
    let transcript: Buffer | undefined;
    try {
      transcript = await ticketTranscript(channel);
    } catch {
      /* Close safely even if export failed. */
    }
    await channel.permissionOverwrites.edit(ticket.owner, {
      ViewChannel: false,
      SendMessages: false,
    });
    ticket.status = 'closed';
    ticket.closedAt = Date.now();
    ticket.reason = reason ?? 'Closed using ticket controls';
    ticket.transcriptCaptured = !!transcript;
    app.store.put(i.guildId!, 'ticket', channel.id, ticket);
    const header =
      'Ticket status: CLOSED\nRequest: ' +
      ticket.subject +
      (ticket.description ? '\n' + ticket.description : '') +
      '\nClosing reason: ' +
      ticket.reason +
      '\n\n';
    ticket.closureDM = await directMessage(
      app,
      ticket.owner,
      i.guild!.name + ' · support ticket closed',
      '**Status: Closed**\n**Your request:** ' +
        safe(ticket.subject, 1900) +
        (ticket.description ? '\n' + safe(ticket.description, 1000) : '') +
        '\n**Closing reason:** ' +
        safe(ticket.reason, 500) +
        '\nYou no longer have access to the ticket channel. Contact server support if you need further help.' +
        (transcript
          ? '\nYour conversation transcript is attached.'
          : '\nA transcript could not be generated; contact staff for an export.'),
      'ticket',
      [],
      transcript
        ? [
            new AttachmentBuilder(Buffer.concat([Buffer.from(header), transcript]), {
              name: 'ticket-' + channel.id + '.txt',
            }),
          ]
        : [],
    );
    app.store.put(i.guildId!, 'ticket', channel.id, ticket);
  } else if (action === 'reopen') {
    assert(isStaff, 'Only staff can reopen closed tickets.');
    assert(ticket.status === 'closed', 'This ticket is already open.');
    await botPermission(i.guild!, [P.ManageChannels, P.ManageRoles], channel);
    assert(
      !app.store
        .entries<Ticket>(i.guildId!, 'ticket')
        .some((t) => t.data.owner === ticket.owner && t.data.status === 'open'),
      'This member already has another open ticket.',
    );
    await channel.permissionOverwrites.edit(ticket.owner, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
    ticket.status = 'open';
    delete ticket.closedAt;
    delete ticket.reason;
    delete ticket.closureDM;
    delete ticket.transcriptCaptured;
  } else throw new Error('Unknown ticket action.');
  app.store.put(i.guildId!, 'ticket', channel.id, ticket);
  const controls = await updateTicketCard(app, i.guildId!, channel, ticket);
  await app.audit(
    i.guildId!,
    'reports',
    `Ticket ${action === 'close' ? 'closed' : 'reopened'}`,
    `${i.user.id === ticket.owner ? 'Updated by ticket creator.' : `Updated by: <@${i.user.id}>`}${ticket.claimed && ticket.claimed !== i.user.id ? `\nHandling staff: <@${ticket.claimed}>` : ''}\nRequest: ${safe(ticket.subject, 200)}${action === 'close' ? `\nReason: ${safe(ticket.reason ?? '', 1000)}\nDM: ${ticket.closureDM} · Transcript: ${ticket.transcriptCaptured ? 'captured' : 'failed'}` : ''}`,
    { profile: logProfile(app, ticket.owner), reference: channelLabel(channel.id, channel.name) },
  );
  await reply(
    i,
    `Ticket ${action} completed.${action === 'close' ? ` Member DM: ${ticket.closureDM}.` : ''}${controls ? '' : ' Control message update could not be confirmed; use /ticket commands.'}`,
  );
}
export const tickets: Module = {
  commands: {
    ticket: async (app, i) => {
      enabled(app, i.guildId, 'tickets');
      const action = i.options.getSubcommand();
      if (action === 'panel') {
        await requirePermission(app, i, P.ManageMessages);
        const channel = await destination(app, i, i.options.getChannel('channel', true).id);
        assert(channel.type === ChannelType.GuildText, 'Choose a normal support text channel.');
        await sendModern(
          channel,
          ticketCard(
            safe(i.options.getString('title') ?? 'How can we help?', 180),
            (
              i.options.getString('description') ??
              'Need help, have a concern, or want to contact the team? Open a private ticket below.\n\n**What happens next**\nFill in a subject and describe your request. A private channel will be created for you and authorized staff. You can add details and relevant message links there.\n\nPlease explain what happened and what help you need. Never share passwords or bot tokens. Staff respond when available; repeated role pings will not speed up a reply.\n\nWhen your ticket closes, access is removed and the bot attempts to DM you a closed-status summary and transcript. Allow server DMs to receive it. Only staff can reopen or delete closed tickets.'
            ).slice(0, 3500),
            [{ action: 'open', label: 'Open a support ticket' }],
          ),
        );
        const cfg = app.store.config(i.guildId);
        cfg.supportChannel = channel.id;
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(
          i,
          'Support panel published. Ticket categories are created and cleaned up automatically.',
        );
        return;
      }
      if (action === 'open') {
        await openTicket(app, i, i.options.getString('subject', true));
        return;
      }
      await ticketControl(app, i, action, i.options.getString('reason') ?? undefined);
    },
  },
  component: async (app, i) => {
    if (i.isButton() && i.customId.startsWith('ticket:')) {
      const action = i.customId.split(':')[1]!;
      if (action === 'open') {
        enabled(app, i.guildId, 'tickets');
        const modal = new ModalBuilder()
          .setCustomId('ticket:subject')
          .setTitle('Contact staff')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('subject')
                .setLabel('How can staff help?')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(120)
                .setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('description')
                .setLabel('Describe your request')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1900)
                .setRequired(true),
            ),
          );
        await i.showModal(modernModal(modal));
      } else {
        assert(
          ['claim', 'close', 'reopen', 'delete', 'transcript'].includes(action),
          'Unknown ticket control.',
        );
        await ticketControl(app, i, action);
      }
      return true;
    }
    if (i.isModalSubmit() && i.customId === 'ticket:subject') {
      await openTicket(
        app,
        i,
        i.fields.getTextInputValue('subject'),
        i.fields.getTextInputValue('description'),
      );
      return true;
    }
    return false;
  },
};
