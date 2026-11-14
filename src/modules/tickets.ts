import { modernEdit, sendModern, modernModal } from '../presentation.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits as P,
  type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module, Interaction, Component } from '../types.js';
import { requirePermission, botPermission, enabled, safeRole } from '../permissions.js';
import { assert, safe, safeMentions } from '../util.js';
import { reply, embed, noMentions, confirm, type Confirmation } from '../ui.js';
import { directMessage } from '../dm.js';
import { ticketCard, ticketStateCard } from '../ticket-ui.js';
import {
  evidenceText,
  resolveEvidence,
  evidenceChannelAccess,
  type MessageEvidence,
} from '../evidence.js';
import { destination, send } from '../discord.js';
import { channelNotice } from '../notices.js';
import { revokeWarning } from '../warnings.js';
import { channelLabel } from '../channel-label.js';
export interface Ticket {
  owner: string;
  subject: string;
  description?: string;
  controlMessage?: string;
  controlError?: string;
  closureDM?: string;
  status: 'open' | 'closed';
  created: number;
  closedAt?: number;
  claimed?: string;
  claimedAt?: number;
  reason?: string;
}
const opening = new Set<string>();
const reviewing = new Set<string>();
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
  try {
    const cfg = app.store.config(i.guildId!);
    assert(cfg.ticketCategory, 'The owner needs to configure ticketCategory first.');
    assert(
      !app.store
        .entries<Ticket>(i.guildId!, 'ticket')
        .some((t) => t.data.owner === i.user.id && t.data.status === 'open'),
      'You already have an open ticket.',
    );
    assert(
      app.store.entries<Ticket>(i.guildId!, 'ticket').filter((t) => t.data.status === 'open')
        .length < 50,
      'The open-ticket limit has been reached.',
    );
    await botPermission(i.guild!, [P.ManageChannels, P.ManageRoles]);
    const category = await i.guild!.channels.fetch(cfg.ticketCategory);
    assert(category?.type === ChannelType.GuildCategory, 'Ticket category is invalid.');
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
    const ticket = app.store.get<Ticket>(i.guildId!, 'ticket', channel.id)!;
    const controls = await updateTicketCard(app, i.guildId!, channel, ticket);
    await reply(
      i,
      `Your private ticket is ready: ${channelLabel(channel.id, channel.name)}.${controls ? '' : ' The controls could not be confirmed; use /ticket commands inside it.'}`,
    );
  } finally {
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
        `<#${channel.id}> · Status: ${ticket.status}. ${ticket.controlError}`,
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
    await app.audit(
      i.guildId!,
      'reports',
      'Ticket channel deleted',
      'Channel ID: ' + channel.id + ' · Staff: <@' + i.user.id + '>',
    );
  } finally {
    ticketBusy.delete(lockKey);
  }
}

function componentText(items: unknown[]): string {
  return items
    .map((item) => {
      const raw = item as { toJSON?: () => unknown; content?: string; components?: unknown[] };
      const data = (raw.toJSON ? raw.toJSON() : raw) as {
        content?: string;
        components?: unknown[];
      };
      return [data.content ?? '', ...(data.components ? [componentText(data.components)] : [])]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n');
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
      const text = `${message.createdAt.toISOString()} ${message.author.tag} (${message.author.id})\n${message.content}\n${message.embeds.map((e) => `${e.title ?? ''}\n${e.description ?? ''}`).join('\n')}\n${componentText(message.components ?? [])}\n${message.attachments.map((a) => `Attachment metadata: ${a.name} (${a.size} bytes); ${a.url}`).join('\n')}\n`;
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
      `<#${channel.id}> · <@${ticket.claimed}>`,
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
    await app.audit(
      i.guildId!,
      'reports',
      'Ticket closure delivery',
      '<#' +
        channel.id +
        '> · DM: ' +
        ticket.closureDM +
        ' · Transcript: ' +
        (transcript ? 'captured' : 'failed'),
    );
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
  } else throw new Error('Unknown ticket action.');
  app.store.put(i.guildId!, 'ticket', channel.id, ticket);
  const controls = await updateTicketCard(app, i.guildId!, channel, ticket);
  await app.audit(i.guildId!, 'reports', `Ticket ${action}`, `<#${channel.id}> · <@${i.user.id}>`);
  await reply(
    i,
    `Ticket ${action} completed.${action === 'close' ? ` Member DM: ${ticket.closureDM}.` : ''}${controls ? '' : ' Control message update could not be confirmed; use /ticket commands.'}`,
  );
}
export async function submitReport(
  app: App,
  i: Interaction,
  target: string,
  reason: string,
  message?: MessageEvidence,
) {
  enabled(app, i.guildId!, 'tickets');
  const cfg = app.store.config(i.guildId!);
  assert(cfg.logs.reports, 'Staff need to configure the reports log destination first.');
  const key = randomUUID();
  const evidence = message && !cfg.excludedChannels.includes(message.channel) ? message : undefined;
  if (evidence?.capturedAt) await evidenceChannelAccess(app, i, evidence.channel);
  app.store.put(i.guildId!, 'reports', key, {
    actor: i.user.id,
    target,
    reason,
    message: evidence,
    status: 'open',
  });
  await app.audit(
    i.guildId!,
    'reports',
    `Member report ${key}`,
    `Reporter: <@${i.user.id}>\nTarget: <@${target}>\n${safeMentions(reason)}${evidence ? `\n${evidenceText(evidence)}` : ''}`,
  );
  await reply(i, `Your report was submitted privately. Reference: ${key}.`);
}
export async function grantVerification(app: App, i: Interaction, target: string) {
  const cfg = app.store.config(i.guildId!);
  assert(!cfg.verificationPaused, 'Verification is temporarily paused.');
  assert(cfg.verifiedRole, 'Configure verifiedRole first.');
  const role = await i.guild!.roles.fetch(cfg.verifiedRole);
  assert(role, 'Verification role no longer exists.');
  safeRole(role);
  assert(!cfg.protectedRoles.includes(role.id), 'Verification role is protected.');
  const me = await botPermission(i.guild!, P.ManageRoles);
  assert(me.roles.highest.comparePositionTo(role) > 0, 'The bot needs a higher role.');
  const member = await i.guild!.members.fetch(target);
  await member.roles.add(role, 'Rules acknowledgement / staff verification');
  app.store.delete(i.guildId!, 'verification', target);
}
export const tickets: Module = {
  commands: {
    ticket: async (app, i) => {
      enabled(app, i.guildId, 'tickets');
      const action = i.options.getSubcommand();
      if (action === 'panel') {
        await requirePermission(app, i, P.ManageMessages);
        const channel = await destination(app, i, i.options.getChannel('channel', true).id);
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
        await reply(i, 'Support panel published.');
        return;
      }
      if (action === 'open') {
        await openTicket(app, i, i.options.getString('subject', true));
        return;
      }
      await ticketControl(app, i, action, i.options.getString('reason') ?? undefined);
    },
    report: async (app, i) =>
      submitReport(
        app,
        i,
        i.options.getUser('member', true).id,
        i.options.getString('reason', true),
        await resolveEvidence(app, i, i.options.getString('evidence')),
      ),
    appeal: async (app, i) => {
      enabled(app, i.guildId, 'moderation');
      assert(
        app.store.config(i.guildId).logs.reports,
        'Staff need to configure the reports destination.',
      );
      const caseId = i.options.getInteger('case', true),
        record = app.store.case(i.guildId, caseId);
      assert(
        record?.target === i.user.id,
        'You may only appeal your own retained moderation case.',
      );
      assert(
        !app.store
          .entries<{ caseId: number }>(i.guildId, 'appeals')
          .some((e) => e.data.caseId === caseId),
        'An appeal for this case has already been submitted.',
      );
      const reason = i.options.getString('reason', true);
      app.store.put(i.guildId, 'appeals', randomUUID(), {
        caseId,
        actor: i.user.id,
        reason,
        status: 'open',
      });
      await app.audit(
        i.guildId,
        'reports',
        `Appeal for case #${caseId}`,
        `<@${i.user.id}>: ${safeMentions(reason)}`,
      );
      await reply(i, 'Your appeal was submitted for staff review.');
    },
    review: async (app, i) => {
      await requirePermission(app, i, P.ModerateMembers);
      const kind = i.options.getString('kind', true);
      assert(kind === 'reports' || kind === 'appeals', 'Invalid review queue.');
      type Review = {
        actor: string;
        target?: string;
        reason: string;
        status: string;
        caseId?: number;
        decision?: string;
        reviewer?: string;
      };
      if (i.options.getSubcommand() === 'list') {
        const items = app.store
          .entries<Review>(i.guildId, kind, 100)
          .filter((e) => e.data.status === 'open')
          .slice(0, 10);
        await reply(
          i,
          items
            .map(
              (e) =>
                `${e.key}\nBy <@${e.data.actor}>${e.data.target ? ` · Target <@${e.data.target}>` : ''}${e.data.caseId ? ` · Case #${e.data.caseId}` : ''}\n${safe(e.data.reason, 180)}`,
            )
            .join('\n\n') || 'No pending submissions.',
        );
        return;
      }
      const key = i.options.getString('id', true),
        item = app.store.get<Review>(i.guildId, kind, key);
      assert(item, 'Submission not found.');
      assert(item.status === 'open', 'This submission has already been resolved.');
      const reviewKey = `${i.guildId}:${kind}:${key}`;
      assert(!reviewing.has(reviewKey), 'This submission is already being reviewed.');
      reviewing.add(reviewKey);
      try {
        item.status = i.options.getString('decision', true);
        item.decision = i.options.getString('reason', true);
        item.reviewer = i.user.id;
        let revoked = false;
        if (
          kind === 'appeals' &&
          item.status === 'accepted' &&
          item.caseId &&
          app.store.case(i.guildId, item.caseId)?.action === 'warn'
        ) {
          if (!app.store.get(i.guildId, 'warningRevocation', String(item.caseId)))
            await revokeWarning(app, i, item.caseId, item.decision, key);
          revoked = true;
        }
        app.store.put(i.guildId, kind, key, item);
        await app.audit(
          i.guildId,
          'reports',
          `${kind} ${key}: ${item.status}`,
          `Reviewed by <@${i.user.id}>. ${safeMentions(item.decision)}`,
        );
        await reply(
          i,
          revoked
            ? 'Appeal accepted. The warning is revoked and no longer counts toward escalation. Previous kicks/timeouts are not automatically reversed.'
            : 'Decision recorded. For non-warning cases, use /mod to explicitly change any punishment.',
        );
      } finally {
        reviewing.delete(reviewKey);
      }
    },
    verify: async (app, i) => {
      enabled(app, i.guildId, 'onboarding');
      await requirePermission(app, i, P.ManageGuild);
      const action = i.options.getSubcommand();
      const cfg = app.store.config(i.guildId);
      if (action === 'panel') {
        assert(cfg.verifiedRole, 'Configure verifiedRole first.');
        const channel = await destination(app, i, i.options.getChannel('channel', true).id);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('verify:ack')
            .setLabel('I agree to the rules')
            .setStyle(ButtonStyle.Success),
        );
        const message = await sendModern(channel, {
          embeds: [embed('Server rules', i.options.getString('rules', true))],
          components: [row],
          allowedMentions: noMentions,
        });
        app.store.put(i.guildId, 'verifyPanel', message.id, {});
        await reply(i, 'Rules acknowledgement panel published.');
        return;
      }
      if (action === 'pending') {
        await reply(
          i,
          app.store
            .entries<{ name: string }>(i.guildId, 'verification', 50)
            .map((e) => `<@${e.key}> · ${safe(e.data.name)}`)
            .join('\n') || 'No pending requests.',
        );
        return;
      }
      const target = i.options.getUser('member', true);
      assert(
        app.store.get(i.guildId, 'verification', target.id),
        'No pending verification request.',
      );
      if (action === 'approve') await grantVerification(app, i, target.id);
      else app.store.delete(i.guildId, 'verification', target.id);
      await app.audit(
        i.guildId,
        'members',
        `Verification ${action}`,
        `<@${target.id}> by <@${i.user.id}>`,
      );
      await reply(i, `Request ${action} completed.`);
    },
  },
  component: async (app, i) => {
    if (i.isButton() && i.customId === 'verify:ack') {
      enabled(app, i.guildId, 'onboarding');
      assert(
        app.store.get(i.guildId, 'verifyPanel', i.message.id),
        'This verification panel is no longer valid.',
      );
      const cfg = app.store.config(i.guildId);
      assert(!cfg.verificationPaused, 'Verification is temporarily paused.');
      if (cfg.verificationReview) {
        assert(
          !app.store.get(i.guildId, 'verification', i.user.id),
          'Your request is already pending.',
        );
        app.store.put(i.guildId, 'verification', i.user.id, {
          name: i.user.tag,
          created: Date.now(),
        });
        await app.audit(
          i.guildId,
          'members',
          'Verification requested',
          `<@${i.user.id}> acknowledged the rules.`,
        );
        await reply(i, 'Your request is waiting for staff approval.');
      } else {
        await grantVerification(app, i, i.user.id);
        await reply(i, 'Rules acknowledged. Your member role has been assigned.');
      }
      return true;
    }
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
    if (i.isModalSubmit() && i.customId.startsWith('report:')) {
      const key = i.customId.split(':')[1]!;
      const pending = app.store.get<{
        actor: string;
        target: string;
        message: { id: string; channel: string; content: string; url: string };
        expires: number;
      }>(i.guildId, 'reportDraft', key);
      assert(
        pending && pending.actor === i.user.id && pending.expires > Date.now(),
        'This report form expired.',
      );
      app.store.delete(i.guildId, 'reportDraft', key);
      await submitReport(
        app,
        i,
        pending.target,
        i.fields.getTextInputValue('reason'),
        pending.message,
      );
      return true;
    }
    return false;
  },
};
