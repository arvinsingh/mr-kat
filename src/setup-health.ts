import {
  ChannelType,
  GatewayIntentBits,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import type { App } from './types.js';
import { safe, errorText } from './util.js';
import { privileged } from './permissions.js';
import { listBackups, type BackupState } from './backup-health.js';
import { logKinds } from './config.js';
import { uwuDeliveryIssues } from './uwulock.js';

export const healthTopics = [
  'overview',
  'logging',
  'moderation',
  'roles',
  'voice',
  'tickets',
  'onboarding',
  'confessions',
  'community',
  'automation',
  'backups',
] as const;
export type HealthTopic = (typeof healthTopics)[number];
export interface HealthItem {
  status: 'ok' | 'warn' | 'error' | 'off';
  name: string;
  detail: string;
}
export async function checkSetup(
  app: App,
  guild: Guild,
  topic: HealthTopic,
): Promise<HealthItem[]> {
  const cfg = app.store.config(guild.id),
    items: HealthItem[] = [];
  const add = (status: HealthItem['status'], name: string, detail: string) =>
    items.push({ status, name, detail });
  const me = await guild.members.fetchMe();
  const needed = (name: string, permissions: bigint[]) => {
    const missing = permissions.filter((p) => !me.permissions.has(p));
    add(
      missing.length ? 'error' : 'ok',
      name,
      missing.length
        ? `Grant the bot ${new PermissionsBitField(missing).toArray().join(', ')}. Administrator still cannot bypass role hierarchy.`
        : 'Required server permissions are present; channel overrides are checked separately.',
    );
  };
  const channel = async (
    name: string,
    id: string | undefined,
    types: ChannelType[],
    permissions: bigint[],
    privateOnly = false,
  ) => {
    if (!id) {
      add(
        'warn',
        name,
        'Not configured. Use the setup controls or the command shown in the guide.',
      );
      return;
    }
    let found: GuildBasedChannel | null;
    try {
      found = await guild.channels.fetch(id);
    } catch (error) {
      add(
        'error',
        name,
        `Cannot inspect channel ${id}: ${safe(errorText(error), 180)}. Fix access or select another destination.`,
      );
      return;
    }
    if (!found || !types.includes(found.type)) {
      add(
        'error',
        name,
        `Channel ${id} is missing or has the wrong type. Select an existing ${types.includes(ChannelType.GuildCategory) ? 'category' : types.includes(ChannelType.GuildVoice) ? 'voice channel' : 'text channel'}.`,
      );
      return;
    }
    const missing = permissions.filter((p) => !found.permissionsFor(me)?.has(p));
    add(
      missing.length ? 'error' : 'ok',
      name,
      `<#${id}>${missing.length ? ` — add ${new PermissionsBitField(missing).toArray().join(', ')} in this channel’s permissions.` : ' — required channel permissions are present.'}`,
    );
    if (privateOnly && found.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel))
      add(
        'error',
        `${name} privacy`,
        'Visible to @everyone. Remove View Channel for @everyone and verify member-role overrides before using this for staff/private records.',
      );
    if (cfg.excludedChannels.includes(id))
      add(
        'warn',
        `${name} exclusion`,
        'This destination is in excludedChannels. Relevant message/feature processing may be disabled here.',
      );
  };
  const role = async (name: string, id: string, automated: boolean) => {
    try {
      const found = await guild.roles.fetch(id);
      if (!found) {
        add('error', name, `Role ${id} was deleted. Select an existing role.`);
        return;
      }
      if (
        automated &&
        (found.id === guild.id || found.managed || found.permissions.any(privileged))
      ) {
        add(
          'error',
          name,
          `<@&${id}> cannot be assigned automatically: choose an ordinary unprivileged role.`,
        );
        return;
      }
      if (automated && me.roles.highest.comparePositionTo(found) <= 0) {
        add('error', name, `Move the bot’s role above <@&${id}> in Server Settings → Roles.`);
        return;
      }
      add(
        'ok',
        name,
        `<@&${id}>${automated ? ' is eligible for automatic assignment.' : ' exists. The allowlist does not grant native permissions.'}`,
      );
    } catch (error) {
      add('error', name, `Unable to inspect role ${id}: ${safe(errorText(error), 150)}.`);
    }
  };
  const disabled = (module: keyof typeof cfg.modules) => {
    if (cfg.modules[module]) return false;
    add(
      'off',
      `${module} module`,
      'Intentionally disabled. Enable it only if you want this feature.',
    );
    return true;
  };
  const text = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  const posting = [P.ViewChannel, P.SendMessages, P.EmbedLinks];
  if (topic === 'overview') {
    add('ok', 'Connected server', `Server ID ${guild.id}. Bot role: <@&${me.roles.highest.id}>.`);
    add(
      'ok',
      'How to use this panel',
      'Choose a feature below. ✅ passes; ⚠️ needs setup/review; ❌ blocks the feature; ⏸️ intentionally off. Owners get channel/role pickers. Every configuration change requires confirmation.',
    );
    for (const intent of [GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent])
      add(
        app.client.options.intents.has(intent) ? 'ok' : 'error',
        `${intent === GatewayIntentBits.GuildMembers ? 'Members' : 'Message Content'} client intent`,
        'Requested intents are checked here. Developer Portal toggles/approval must also be enabled; those cannot be proven by a guild permission check.',
      );
    add(
      cfg.staffRoles.length ? 'ok' : 'warn',
      'Staff command access',
      cfg.staffRoles.length
        ? `${cfg.staffRoles.length} staff role(s) allowlisted. Native Discord permissions still apply.`
        : 'No staff allowlist: native Discord permissions alone control staff commands. Select staff roles if you want an extra restriction.',
    );
    const failed = app.store.jobs(guild.id, 100).filter((job) => job.state === 'failed').length;
    add(
      failed ? 'warn' : 'ok',
      'Recent scheduled work',
      failed
        ? `${failed} failed job(s) among the latest 100. Use /jobs list and /jobs show before retrying.`
        : 'No failed jobs among the latest 100.',
    );
    add(
      'warn',
      'Recovery readiness',
      'Open Backups to check verified copies. Off-host copying is not verified by this bot.',
    );
  } else if (topic === 'logging') {
    if (!disabled('logging')) {
      for (const kind of logKinds)
        await channel(
          `${kind} log`,
          cfg.logs[kind],
          kind === 'dm' ? [ChannelType.GuildText] : text,
          [
            ...posting,
            P.ReadMessageHistory,
            ...(kind === 'dm' ? [P.CreatePublicThreads, P.SendMessagesInThreads] : []),
          ],
          true,
        );
      add(
        'ok',
        'Message logging policy',
        `Only edits/deletions are logged. Persistent content snapshots: ${cfg.snapshotDays ? `${cfg.snapshotDays} days` : 'off; uncached old content may be unavailable'}. Full available text is paginated. Log destinations are excluded from message-log feedback loops.`,
      );
    }
  } else if (topic === 'moderation') {
    if (!disabled('moderation')) {
      needed('Moderation permissions', [
        P.ModerateMembers,
        P.KickMembers,
        P.BanMembers,
        P.ManageMessages,
      ]);
      add(
        'warn',
        'Role hierarchy',
        'Bot AND acting staff must be above each target. The server owner, bot, protected roles and peers cannot be moderated by these commands. Administrator does not bypass hierarchy.',
      );
      for (const id of cfg.protectedRoles) await role('Protected role', id, false);
      add(
        'ok',
        'Moderation notices',
        'Members receive best-effort DMs; channel notices remain. Use staff-only command channels for sensitive reasons.',
      );
      if (cfg.modules.automod) needed('Native AutoMod management', [P.ManageGuild]);
      add(
        cfg.automod.mode === 'report' ? 'warn' : 'ok',
        'Bot spam detector',
        cfg.automod.mode === 'report'
          ? 'Report-only: detection does not delete or timeout. Configure enforcement deliberately with /automod configure.'
          : `Enforcement: ${cfg.automod.mode}. Native rules must be created separately with /automod keyword or mentions.`,
      );
    }
  } else if (topic === 'roles') {
    if (!disabled('roles')) {
      needed('Role assignment', [P.ManageRoles]);
      for (const id of new Set([
        ...cfg.selfRoles,
        ...cfg.joinRoles,
        ...cfg.restoreRoles,
        ...[cfg.joinRole, cfg.verifiedRole].filter((id): id is string => !!id),
      ]))
        await role('Assignable role', id, true);
      if (!cfg.selfRoles.length)
        add(
          'off',
          'Bot self-role panel',
          'No self roles configured. This is fine when using native Discord Channels & Roles.',
        );
      for (const id of cfg.staffRoles) await role('Staff allowlist', id, false);
      if (!cfg.staffRoles.length)
        add(
          'warn',
          'Staff allowlist',
          'Empty: native permissions alone apply. Use Select staff roles to add a restriction.',
        );
      add(
        'ok',
        'Native role selection',
        'Discord Channels & Roles is configured in Server Settings → Onboarding; it does not use the bot’s selfRoles list.',
      );
    }
  } else if (topic === 'voice') {
    if (!disabled('voice')) {
      needed('Voice management', [P.ManageChannels, P.ManageRoles, P.MoveMembers]);
      await channel(
        'Join-to-create lobby',
        cfg.voiceLobby,
        [ChannelType.GuildVoice],
        [P.ViewChannel, P.Connect, P.MoveMembers],
      );
      await channel(
        'Room category',
        cfg.voiceCategory,
        [ChannelType.GuildCategory],
        [
          P.ViewChannel,
          P.ManageChannels,
          P.ManageRoles,
          P.Connect,
          P.SendMessages,
          P.EmbedLinks,
          P.ReadMessageHistory,
        ],
      );
      if (cfg.voiceNoticeChannel)
        await channel('Creation notice channel', cfg.voiceNoticeChannel, text, posting);
      add(
        'ok',
        'Member flow',
        'Join the configured lobby. A temporary voice room is created and the owner is moved there. Instructions appear in its built-in text chat. Use /voice status for recent failures.',
      );
    }
  } else if (topic === 'tickets') {
    if (!disabled('tickets')) {
      needed('Private ticket channels', [P.ManageChannels, P.ManageRoles]);
      await channel(
        'Support panel channel',
        cfg.supportChannel,
        [ChannelType.GuildText],
        [...posting, P.ReadMessageHistory],
      );
      add(
        'ok',
        'Ticket category lifecycle',
        'Support Tickets is created on demand and removed after its last channel is deleted. Closed channels retain it. No category setup is required.',
      );
      add(
        cfg.staffRoles.length ? 'ok' : 'warn',
        'Support staff',
        cfg.staffRoles.length
          ? 'Staff roles are configured. Give them Manage Messages; test ticket visibility with a normal member.'
          : 'Set staffRoles so ticket channels include the intended support team.',
      );
      add(
        'warn',
        'Publish support panel',
        'Run /ticket panel channel:#support to publish the panel and save its destination. This check does not infer whether an old panel was deleted.',
      );
    }
  } else if (topic === 'onboarding') {
    if (!disabled('onboarding')) {
      if (cfg.welcomeChannel)
        await channel('Departure/public welcome destination', cfg.welcomeChannel, text, posting);
      else
        add(
          'off',
          'Public join/exit destination',
          'No destination configured. Native public welcomes can still be used.',
        );
      if (cfg.rulesChannel) await channel('Rules link', cfg.rulesChannel, text, [P.ViewChannel]);
      if (cfg.introductionChannel)
        await channel('Introduction link', cfg.introductionChannel, text, [P.ViewChannel]);
      if (cfg.rolesSource === 'channel')
        await channel('Role-selection link', cfg.rolesChannel, text, [P.ViewChannel]);
      add(
        'ok',
        'Welcome DM',
        `${cfg.welcomeDM ? 'Enabled' : 'Disabled'}. Discord users can block bot DMs. Native Channels & Roles has desktop/mobile-specific guidance. Use /onboarding preview and status to inspect delivery.`,
      );
      if (cfg.joinRoles.length || cfg.joinRole) needed('Automatic roles', [P.ManageRoles]);
      for (const id of new Set([
        ...cfg.joinRoles,
        ...[cfg.joinRole].filter((id): id is string => !!id),
      ]))
        await role('Join role', id, true);
    }
  } else if (topic === 'confessions') {
    if (!disabled('community')) {
      if (!cfg.confessions.enabled)
        add(
          'off',
          'Confessions',
          'Off until configured with /confession setup. Choose publication/privacy/review mode explicitly.',
        );
      if (cfg.confessions.enabled || cfg.confessions.channel) {
        await channel(
          'Publication channel',
          cfg.confessions.channel,
          [ChannelType.GuildText],
          [...posting, P.CreatePublicThreads, P.SendMessagesInThreads, P.ReadMessageHistory],
        );
        if (cfg.confessions.reviewRequired)
          await channel(
            'Review channel',
            cfg.confessions.reviewChannel,
            [ChannelType.GuildText],
            posting,
            true,
          );
        if (cfg.confessions.channel === cfg.confessions.reviewChannel)
          add(
            'error',
            'Review separation',
            'Publication and staff review must be different channels.',
          );
        add(
          'ok',
          'Privacy/mode',
          `${cfg.confessions.privacy}; ${cfg.confessions.reviewRequired ? 'staff review required' : 'instant publication'}. No author lookup is exposed, including to the owner. /help command:confess explains privacy.`,
        );
      }
    }
  } else if (topic === 'community') {
    if (!disabled('community')) {
      add(
        cfg.roast.enabled ? 'ok' : 'off',
        'Roasts',
        `${cfg.roast.enabled ? 'Enabled' : 'Disabled'} · ${cfg.roast.channels.length ? `${cfg.roast.channels.length} selected channels and their threads` : 'Server-wide'}. Everyone participates by default; opt-out blocks both directions. Configure with /roast setup.`,
      );
      if (cfg.roast.reviewChannel) {
        await channel(
          'Public roast submission board',
          cfg.roast.reviewChannel,
          [ChannelType.GuildText],
          [...posting, P.ReadMessageHistory],
        );
        const board = await guild.channels.fetch(cfg.roast.reviewChannel).catch(() => null);
        if (
          board &&
          !board.permissionsFor(guild.roles.everyone)?.has([P.ViewChannel, P.ReadMessageHistory])
        )
          add(
            'error',
            'Roast board visibility',
            'Choose a public text channel so members can see proposals and their decisions.',
          );
      } else
        add(
          'warn',
          'Roast submissions',
          'Built-in roasts work without a submission board. Select a public board in /roast setup to accept custom lines.',
        );
      if (cfg.suggestionChannel)
        await channel(
          'Suggestions destination',
          cfg.suggestionChannel,
          [ChannelType.GuildText],
          [...posting, P.ReadMessageHistory, P.CreatePublicThreads, P.SendMessagesInThreads],
        );
      else add('warn', 'Suggestions destination', 'Run /suggest setup channel:#suggestions.');
      const locks = app.store
        .entries<{ channel: string; expires: number }>(app.guildId, 'uwuLock', 1000)
        .filter(({ data }) => data.expires > Date.now());
      const deliveryIssues = uwuDeliveryIssues(app);
      if (deliveryIssues.length)
        add(
          'warn',
          'UwU delivery review',
          `${deliveryIssues.length} recent unresolved deliveries. /uwulock list attaches the original/replacement IDs for staff to inspect; no automatic retry.`,
        );
      add(
        cfg.uwuLock.enabled ? 'ok' : 'off',
        'UwU Lock',
        `${cfg.uwuLock.enabled ? 'Enabled' : 'Disabled'}; ${locks.length} active locks (${locks.filter(({ data }) => data.channel === '*').length} server-wide). /uwulock panel defaults to server-wide; its scope selector can limit a lock to this channel. Each destination rechecks hierarchy, access and staff/bot permissions.`,
      );
      for (const id of new Set(locks.map(({ data }) => data.channel).filter((id) => id !== '*'))) {
        const found = await guild.channels.fetch(id).catch(() => null);
        if (!found) {
          add(
            'error',
            'UwU lock channel',
            `Missing or inaccessible channel ${id}. Remove its lock with /uwulock clear if needed.`,
          );
          continue;
        }
        const required = [
          P.ViewChannel,
          P.ReadMessageHistory,
          P.ManageMessages,
          P.ManageWebhooks,
          P.AttachFiles,
          found.isThread() ? P.SendMessagesInThreads : P.SendMessages,
        ];
        const missing = required.filter((p) => !found.permissionsFor(me)?.has(p));
        add(
          missing.length ? 'error' : 'ok',
          `UwU lock channel ${id}`,
          missing.length
            ? `Grant ${new PermissionsBitField(missing).toArray().join(', ')}.`
            : 'Required channel permissions present.',
        );
      }
      if (cfg.starboard.enabled)
        await channel(
          'Starboard destination',
          cfg.starboard.channel,
          [ChannelType.GuildText],
          [...posting, P.ReadMessageHistory],
        );
      else add('off', 'Starboard', 'Not enabled. Use /starboard setup to publish ⭐ highlights.');
      add(
        cfg.textEffects.enabled ? 'ok' : 'off',
        'Text effects',
        cfg.textEffects.enabled
          ? `/text and reply shortcuts enabled in ${cfg.textEffects.channels.length ? 'selected channels' : 'eligible posting channels'}. Long output also needs Attach Files.`
          : 'Disabled in configuration.',
      );
      add(
        cfg.mentionReplies.enabled && cfg.modules.messages ? 'ok' : 'off',
        'Mention replies',
        'Explicit mentions can get witty text replies. The messages module must be on.',
      );
      if (cfg.mentionReplies.commandsChannel)
        await channel(
          'Commands-channel link',
          cfg.mentionReplies.commandsChannel,
          [ChannelType.GuildText],
          [P.ViewChannel],
        );
    }
  } else if (topic === 'automation') {
    if (cfg.heartbeat.enabled)
      await channel(
        'Heartbeat destination',
        cfg.heartbeat.channel,
        [ChannelType.GuildText],
        posting,
      );
    else
      add(
        'off',
        'Heartbeat',
        'Off until configured. An offline bot cannot post an offline warning.',
      );
    add(
      'ok',
      'Scheduled work',
      'Use /jobs list and /jobs show. Failed/uncertain sends require review instead of blind replay. Current announcements are one-time schedules.',
    );
    add(
      'ok',
      'Automatic maintenance',
      'Backups run independently of Discord cleanup failures. Automatic copies older than seven days are removed; manual backups are kept.',
    );
  } else if (topic === 'backups') {
    const state = app.store.get<BackupState>(guild.id, 'system', 'backupHealth');
    try {
      const files = await listBackups(app.backupDir);
      add(
        files.length ? 'ok' : 'warn',
        'Local copies',
        `${files.length}${files.length === 25 ? '+' : ''} recent backup file(s) found. Open /backup for file verification and recovery instructions.`,
      );
    } catch (error) {
      add('error', 'Backup directory', `Cannot inspect backups: ${safe(errorText(error), 180)}.`);
    }
    add(
      state?.lastSuccess && state.lastSuccess > Date.now() - 36 * 3600000 ? 'ok' : 'warn',
      'Verified creation',
      state?.lastSuccess
        ? `Last success <t:${Math.floor(state.lastSuccess / 1000)}:R>.`
        : 'No verified backup creation recorded yet. Use /backup action:create.',
    );
    if (state?.lastError) add('error', 'Last backup error', safe(state.lastError, 300));
    add(
      'warn',
      'Off-host recovery',
      'Local copies share the host’s failure risk. Copy backup + checksum manifest to storage you control. The bot cannot verify that this has been done.',
    );
  }
  return items;
}
