import { modernMessage, modernModal, modernEdit, displayText } from './presentation.js';
import { roleMentions } from './modules/role-mentions.js';
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
import { moderation, moderationConfirmation } from './modules/moderation.js';
import { roles } from './modules/roles.js';
import { channels, lockChannel, restoreLock } from './modules/channels.js';
import { messages, deliverEveryoneAnnouncement } from './modules/messages.js';
import { voice } from './modules/voice.js';
import { tickets, deleteTicketChannel } from './modules/tickets.js';
import { evidenceControls, moderationEvidenceMenu } from './modules/evidence.js';
import { community } from './modules/community.js';
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
import { channelNotice } from './notices.js';
import { reply, takeConfirmation, dismissPrompt, publicResponse, type Confirmation } from './ui.js';
import { responsePath, responsePolicies, confirmationPaths } from './response-policy.js';
import { recordChange } from './change-receipts.js';
import { roast } from './modules/roast.js';
import { assert, UserError, errorText, logError } from './util.js';
import { enabled, manageableRole, requirePermission, botPermission } from './permissions.js';

const features: Module[] = [
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
  community,
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
export const handlers = Object.assign({}, ...features.map((m) => m.commands ?? {})) as NonNullable<
  Module['commands']
>;
const inFlight = new Set<string>();
export async function confirmation(app: App, i: Component, pending: Confirmation) {
  if (pending.kind === 'warningPolicy') return applyWarningPolicy(app, i, pending);
  if (pending.kind === 'ticketDelete') return deleteTicketChannel(app, i, pending);
  if (pending.kind === 'uwuClear') {
    await clearUwuLocks(app, i, pending);
    return;
  }
  if (pending.kind === 'cancel') {
    await reply(i, { content: 'Cancelled.', components: [] });
    return;
  }
  if (pending.kind === 'configImport') {
    await adminConfirmation(app, i, pending);
    return;
  }
  if (pending.kind === 'guidedSetting') {
    await applyGuidedSetting(app, i, pending);
    return;
  }
  if (pending.kind === 'moderate') {
    await moderationConfirmation(app, i, pending);
    return;
  }
  if (pending.kind === 'staffDM') {
    await deliverStaffDM(app, i, pending);
    return;
  }
  if (pending.kind === 'announceEveryone') {
    await deliverEveryoneAnnouncement(app, i, pending);
    return;
  }
  if (pending.kind === 'batchRoles') {
    enabled(app, i.guildId, 'roles');
    const role = await i.guild.roles.fetch(String(pending.payload.role));
    assert(role, 'Role no longer exists.');
    await manageableRole(app, i, role);
    const key = app.store.job(i.guildId, i.user.id, 'batchRoles', pending.payload);
    await reply(i, {
      content: `Batch queued. Use /jobs list for progress. Job: ${key}.`,
      components: [],
    });
    return;
  }
  if (pending.kind === 'batchNicknames') {
    enabled(app, i.guildId, 'moderation');
    await requirePermission(app, i, P.ManageNicknames);
    await botPermission(i.guild, P.ManageNicknames);
    const key = app.store.job(i.guildId, i.user.id, 'batchNicknames', pending.payload);
    await reply(i, { content: `Nickname changes queued. Job: ${key}.`, components: [] });
    return;
  }
  if (pending.kind === 'purge') {
    enabled(app, i.guildId, 'messages');
    const channel = await i.guild.channels.fetch(String(pending.payload.channel));
    assert(channel?.isTextBased(), 'Channel no longer available.');
    await requirePermission(app, i, P.ManageMessages, channel);
    await botPermission(i.guild, P.ManageMessages, channel);
    const key = app.store.job(i.guildId, i.user.id, 'purge', pending.payload);
    await reply(i, {
      content: `Deletion queued. Use /jobs list for progress. Job: ${key}.`,
      components: [],
    });
    return;
  }
  if (pending.kind === 'panicOn') {
    enabled(app, i.guildId, 'channels');
    await requirePermission(app, i, P.ManageGuild);
    assert(!app.store.get(i.guildId, 'panic', 'active'), 'Panic mode is already active.');
    const cfg = app.store.config(i.guildId);
    const state = { channels: [] as string[], verificationPaused: cfg.verificationPaused };
    app.store.put(i.guildId, 'panic', 'active', state);
    cfg.verificationPaused = true;
    app.store.setConfig(i.guildId, cfg, i.user.id);
    for (const key of pending.payload.channels as string[]) {
      const channel = await i.guild.channels.fetch(key);
      assert(channel && !channel.isThread(), 'Channel no longer available.');
      assert(
        !app.store.get(i.guildId, 'lock', key) && !app.store.get(i.guildId, 'archive', key),
        'A selected channel already has a lock/archive; restore it first.',
      );
      state.channels.push(key);
      app.store.put(i.guildId, 'panic', 'active', state);
      await lockChannel(app, i, channel);
      await channelNotice(
        app,
        i.guildId,
        channel.id,
        'moderation',
        'Panic mode is in effect',
        `Activated at <t:${Math.floor(Date.now() / 1000)}:F>.\nIncident restrictions are active in this channel and verification is paused. Staff will post an update when panic mode ends.`,
      );
    }
    await app.audit(
      i.guildId,
      'admin',
      'Panic mode enabled',
      `By <@${i.user.id}>. ${state.channels.length} channels locked.`,
    );
    await reply(i, 'Panic mode enabled. Use /panic off to restore changes.');
    return;
  }
  if (pending.kind === 'panicOff') {
    enabled(app, i.guildId, 'channels');
    await requirePermission(app, i, P.ManageGuild);
    const state = app.store.get<{ channels: string[]; verificationPaused: boolean }>(
      i.guildId,
      'panic',
      'active',
    );
    assert(state, 'Panic mode is not active.');
    for (const key of [...state.channels]) {
      const channel = await i.guild.channels.fetch(key);
      if (channel && !channel.isThread()) {
        await requirePermission(app, i, P.ManageChannels, channel);
        if (app.store.get(i.guildId, 'lock', key)) await restoreLock(app, channel);
        await channelNotice(
          app,
          i.guildId,
          channel.id,
          'admin',
          'Panic mode ended',
          `Restored at <t:${Math.floor(Date.now() / 1000)}:F>.\nThis channel's pre-panic permissions have been restored. Other server restrictions may still apply.`,
        );
      }
      state.channels = state.channels.filter((c) => c !== key);
      app.store.put(i.guildId, 'panic', 'active', state);
    }
    const cfg = app.store.config(i.guildId);
    cfg.verificationPaused = state.verificationPaused;
    app.store.setConfig(i.guildId, cfg, i.user.id);
    app.store.delete(i.guildId, 'panic', 'active');
    await reply(i, 'Panic changes restored.');
    return;
  }
  throw new UserError('Unknown confirmation type.');
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
