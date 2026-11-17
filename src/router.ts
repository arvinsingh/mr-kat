import { modernMessage, modernModal, modernEdit, displayText } from './presentation.js';
import { roleMentions } from './modules/role-mentions.js';
import { honeypot } from './modules/honeypot.js';
import { suggestions } from './modules/suggestions.js';
import { logs } from './modules/logs.js';
import { dmConversations } from './dm-conversations.js';
import { warnings, applyWarningPolicy } from './modules/warnings.js';
import {
  MessageFlags,
  PermissionFlagsBits as P,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction as DiscordInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { App, Module, Component, Interaction } from './types.js';
import { admin, adminConfirmation } from './modules/admin.js';
import { moderation, moderationConfirmation, queueBatchNicknames } from './modules/moderation.js';
import { roles, queueBatchRoles } from './modules/roles.js';
import { channels, panicConfirmation } from './modules/channels.js';
import { messages, deliverEveryoneAnnouncement, queuePurge } from './modules/messages.js';
import { voice } from './modules/voice.js';
import { tickets, deleteTicketChannel } from './modules/tickets.js';
import { reports } from './modules/reports.js';
import { verification } from './modules/verification.js';
import { evidenceControls, moderationEvidenceMenu } from './modules/evidence.js';
import { polls } from './modules/polls.js';
import { reminders } from './modules/reminders.js';
import { statistics } from './modules/statistics.js';
import { automod } from './modules/automod.js';
import { help } from './modules/help.js';
import { confessions } from './modules/confessions.js';
import { easteregg } from './modules/easteregg.js';
import { messaging, deliverStaffDM } from './modules/messaging.js';
import { onboarding, nativeRolesHelp } from './modules/onboarding.js';
import { starboard } from './modules/starboard.js';
import { heartbeat } from './modules/heartbeat.js';
import { text, transformMenu } from './modules/text.js';
import { setup as guidedSetup, applyGuidedSetting } from './modules/setup.js';
import { backups } from './modules/backups.js';
import { uwulock, clearUwuLocks, uwuContext } from './modules/uwulock.js';

import { reply, takeConfirmation, dismissPrompt, publicResponse, type Confirmation } from './ui.js';
import { responsePath, responsePolicies, confirmationPaths } from './response-policy.js';
import { recordChange } from './change-receipts.js';
import { roast } from './modules/roast.js';
import { assert, UserError, errorText, logError } from './util.js';
import { enabled } from './permissions.js';

const features: Module[] = [
  honeypot,
  roast,
  suggestions,
  logs,
  dmConversations,
  evidenceControls,
  roleMentions,
  warnings,
  admin,
  moderation,
  roles,
  channels,
  messages,
  voice,
  tickets,
  reports,
  verification,
  polls,
  reminders,
  statistics,
  automod,
  help,
  confessions,
  easteregg,
  messaging,
  onboarding,
  starboard,
  heartbeat,
  text,
  guidedSetup,
  backups,
  uwulock,
];
export function registerHandlers(modules: Module[]): NonNullable<Module['commands']> {
  const commands: NonNullable<Module['commands']> = Object.create(null);
  for (const module of modules)
    for (const [name, handler] of Object.entries(module.commands ?? {})) {
      assert(!commands[name], `Duplicate command handler: ${name}`);
      commands[name] = handler;
    }
  return commands;
}
export const handlers = registerHandlers(features);
const inFlight = new Set<string>();
const confirmationHandlers: Record<
  string,
  (app: App, i: Component, pending: Confirmation) => Promise<unknown>
> = {
  warningPolicy: applyWarningPolicy,
  ticketDelete: deleteTicketChannel,
  uwuClear: clearUwuLocks,
  cancel: async (_app, i) => reply(i, { content: 'Cancelled.', components: [] }),
  configImport: adminConfirmation,
  guidedSetting: applyGuidedSetting,
  moderate: moderationConfirmation,
  staffDM: deliverStaffDM,
  announceEveryone: deliverEveryoneAnnouncement,
  batchRoles: queueBatchRoles,
  batchNicknames: queueBatchNicknames,
  purge: queuePurge,
  panicOn: panicConfirmation,
  panicOff: panicConfirmation,
};
for (const kind of Object.keys(confirmationPaths))
  assert(Object.hasOwn(confirmationHandlers, kind), `Missing confirmation handler: ${kind}`);
for (const kind of Object.keys(confirmationHandlers))
  assert(
    kind === 'cancel' || Object.hasOwn(confirmationPaths, kind),
    `Missing confirmation response policy: ${kind}`,
  );
export async function confirmation(app: App, i: Component, pending: Confirmation) {
  const handler = Object.hasOwn(confirmationHandlers, pending.kind)
    ? confirmationHandlers[pending.kind]
    : undefined;
  assert(handler, 'Unknown confirmation type.');
  await handler(app, i, pending);
}
export async function route(app: App, raw: DiscordInteraction) {
  if (!raw.isRepliable()) return;
  if (raw.isButton() && (await nativeRolesHelp(app, raw))) return;
  if (raw.guildId !== app.guildId || !raw.inCachedGuild()) {
    await raw
      .reply(
        modernMessage({
          content: 'This bot is configured for one server. Run commands in that server.',
          flags: MessageFlags.Ephemeral,
        }),
      )
      .catch(() => undefined);
    return;
  }
  const i = raw as Interaction;
  const key = `${i.guildId}:${i.user.id}`;
  if (inFlight.has(key)) {
    await raw
      .reply(
        modernMessage({
          content: 'Your previous action is still running. Please try again shortly.',
          flags: MessageFlags.Ephemeral,
        }),
      )
      .catch(() => undefined);
    return;
  }
  inFlight.add(key);
  try {
    if (raw.isButton() && /^(confirm|cancel):/.test(raw.customId)) {
      const pending = takeConfirmation(app, raw);
      assert(pending, 'This confirmation is no longer available.');
      await dismissPrompt(raw);
      await confirmation(app, raw, pending);
      if (pending.kind !== 'cancel')
        await recordChange(app, raw, pending.command || confirmationPaths[pending.kind] || '');
      return;
    }
    const modal =
      raw.isMessageContextMenuCommand() ||
      (raw.isChatInputCommand() &&
        raw.commandName === 'announce' &&
        ['builder', 'everyone'].includes(raw.options.getSubcommand())) ||
      (raw.isChatInputCommand() && raw.commandName === 'confess') ||
      (raw.isChatInputCommand() &&
        raw.commandName === 'say' &&
        !raw.options.getString('message')) ||
      (raw.isStringSelectMenu?.() && raw.customId.startsWith('evidence:action:')) ||
      (raw.isButton() &&
        (raw.customId === 'ticket:open' ||
          /^suggestion:(review|write):/.test(raw.customId) ||
          raw.customId.startsWith('dm:reply:') ||
          /^voice:(rename|limit):/.test(raw.customId) ||
          raw.customId.startsWith('confession:reply:') ||
          /^warnings:(revoke|duration):/.test(raw.customId)));
    if (!modal) {
      if (
        ((raw.isButton() || raw.isStringSelectMenu?.()) && raw.customId.startsWith('help:')) ||
        (raw.isStringSelectMenu?.() && raw.customId.startsWith('textEffect:')) ||
        ((raw.isButton() || raw.isAnySelectMenu?.()) &&
          /^(health|backup|uwuPanel|roastSetup|roastPrefs):/.test(raw.customId)) ||
        ((raw.isButton() || raw.isAnySelectMenu?.()) &&
          raw.customId.startsWith('warnings:') &&
          !raw.customId.startsWith('warnings:apply:')) ||
        (raw.isModalSubmit() && raw.customId.startsWith('warnings:') && raw.isFromMessage())
      )
        await raw.deferUpdate();
      else {
        const shared = responsePolicies[responsePath(i)] === 'public';
        if (shared) publicResponse(i);
        await raw.deferReply({ flags: shared ? undefined : MessageFlags.Ephemeral });
      }
    }
    if (raw.isChatInputCommand()) {
      const handler = handlers[raw.commandName];
      assert(handler, 'Unknown command. Re-register the current commands.');
      await handler(app, raw);
      await recordChange(app, raw, responsePath(i));
      return;
    }
    if (raw.isMessageContextMenuCommand()) {
      if (raw.commandName === 'Moderate with evidence') {
        await raw.deferReply({ flags: MessageFlags.Ephemeral });
        await moderationEvidenceMenu(app, raw);
        return;
      }
      if (['Edit transformed message', 'Delete transformed message'].includes(raw.commandName)) {
        if (raw.commandName === 'Delete transformed message')
          await raw.deferReply({ flags: MessageFlags.Ephemeral });
        await uwuContext(app, raw);
        return;
      }
      if (raw.commandName === 'Transform text') {
        await raw.deferReply({ flags: MessageFlags.Ephemeral });
        await transformMenu(app, raw);
        return;
      }
      assert(raw.commandName === 'Report message', 'Unknown message command.');
      enabled(app, raw.guildId, 'tickets');
      const target = raw.targetMessage;
      const key = randomUUID();
      const cfg = app.store.config(raw.guildId);
      assert(cfg.logs.reports, 'Staff need to configure the reports destination first.');
      assert(
        raw.memberPermissions?.has([P.ViewChannel, P.ReadMessageHistory]) &&
          raw.appPermissions?.has([P.ViewChannel, P.ReadMessageHistory]),
        'You and the bot need View Channel and Read Message History for message evidence.',
      );
      const parent = raw.channel && 'parentId' in raw.channel ? raw.channel.parentId : null;
      assert(
        !cfg.excludedChannels.includes(target.channelId) &&
          !(parent && cfg.excludedChannels.includes(parent)),
        'Evidence capture is disabled in this channel.',
      );
      app.store.put(raw.guildId, 'reportDraft', key, {
        actor: raw.user.id,
        target: target.author.id,
        message: {
          id: target.id,
          channel: target.channelId,
          content: target.content || displayText(target),
          url: target.url,
          author: target.author.id,
          created: target.createdTimestamp,
          capturedAt: Date.now(),
          attachments: [...target.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
        },
        expires: Date.now() + 300000,
      });
      const modal = new ModalBuilder()
        .setCustomId(`report:${key}`)
        .setTitle('Report message')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Why are you reporting this message?')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(1900),
          ),
        );
      await raw.showModal(modernModal(modal));
      return;
    }
    if (
      raw.isButton() ||
      raw.isStringSelectMenu?.() ||
      raw.isChannelSelectMenu?.() ||
      raw.isRoleSelectMenu?.() ||
      raw.isUserSelectMenu?.() ||
      raw.isModalSubmit()
    ) {
      for (const feature of features)
        if (feature.component && (await feature.component(app, raw))) {
          await recordChange(app, raw, responsePath(i));
          return;
        }
      throw new UserError('This control is no longer recognized. Ask staff to recreate the panel.');
    }
  } catch (error) {
    const privateConfession =
      (raw.isChatInputCommand() &&
        ['confess', 'confess-notifications', 'confession'].includes(raw.commandName)) ||
      ((raw.isButton() || raw.isModalSubmit()) && /^(confess|confession):/.test(raw.customId));
    if (!privateConfession) logError('interaction', error);
    const message =
      error instanceof UserError
        ? error.message
        : error instanceof ZodError
          ? `Invalid settings: ${error.issues
              .map((e) => `${e.path.join('.')}: ${e.message}`)
              .join('; ')
              .slice(0, 1600)}`
          : !privateConfession && typeof (error as { code?: unknown }).code === 'number'
            ? `Discord rejected this action: ${errorText(error)}`
            : 'The action failed. Check /diagnose or the host logs. Completed changes may need review before retrying.';
    if (responsePolicies[responsePath(i)] === 'public' && i.deferred) {
      await i
        .editReply(modernEdit({ content: 'This command could not be completed.', components: [] }))
        .catch(() => undefined);
      await i.deleteReply().catch(() => undefined);
      await i
        .followUp(
          modernMessage({
            content: message.slice(0, 1900),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          }),
        )
        .catch((e) => logError('interaction response', e));
    } else
      await reply(i, { content: message.slice(0, 1900), components: [] }).catch((e) =>
        logError('interaction response', e),
      );
  } finally {
    inFlight.delete(key);
  }
}
