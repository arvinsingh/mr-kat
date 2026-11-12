import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import type { Ticket } from './modules/tickets.js';
import { noMentions } from './ui.js';
import { safe } from './util.js';

export function ticketCard(
  title: string,
  text: string,
  controls: { action: string; label: string; danger?: boolean }[],
) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}\n${text}`),
  );
  if (controls.length)
    container.addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...controls.map((control) =>
          new ButtonBuilder()
            .setCustomId(`ticket:${control.action}`)
            .setLabel(control.label)
            .setStyle(control.danger ? ButtonStyle.Danger : ButtonStyle.Secondary),
        ),
      ),
    );
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: noMentions,
  };
}

export function ticketStateCard(ticket: Ticket) {
  const closed = ticket.status === 'closed';
  return ticketCard(
    closed ? 'Ticket closed' : 'Private support ticket',
    `**Status:** ${closed ? 'Closed' : 'Open'}\n**Member:** <@${ticket.owner}>\n**Opened:** <t:${Math.floor(ticket.created / 1000)}:F>\n**Request:** ${safe(ticket.subject, ticket.description ? 300 : 1900)}${ticket.description ? '\n' + safe(ticket.description, 1900) : ''}\n${ticket.claimed ? `**Assigned to:** <@${ticket.claimed}>\n` : ''}${closed ? `**Closed:** <t:${Math.floor(ticket.closedAt! / 1000)}:F>\n**Reason:** ${safe(ticket.reason ?? 'Resolved', 700)}\nThe member no longer has access. Staff can reopen this ticket or export its transcript. Deletion is permanent and requires confirmation.` : 'Describe what happened and include relevant details. Staff will respond here when available. Do not share passwords, bot tokens, or other secrets. Only authorized staff can claim this ticket.'}`,
    closed
      ? [
          { action: 'reopen', label: 'Reopen (staff)' },
          { action: 'transcript', label: 'Transcript (staff)' },
          { action: 'delete', label: 'Delete channel (staff)', danger: true },
        ]
      : [
          { action: 'claim', label: 'Claim (staff)' },
          { action: 'close', label: 'Close ticket' },
          { action: 'transcript', label: 'Transcript (staff)' },
        ],
  );
}
