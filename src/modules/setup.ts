import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits as P,
} from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import type { GuildConfig } from '../config.js';
import { configSchema, logKinds } from '../config.js';
import { assert, safe } from '../util.js';
import { owner, requirePermission, safeRole } from '../permissions.js';
import { confirm, readOnlyResponse, reply, type Confirmation } from '../ui.js';
import { checkSetup, healthTopics, type HealthTopic } from '../setup-health.js';

type Setting = { label: string; topic: HealthTopic; types?: ChannelType[]; roles?: number };
const settings: Record<string, Setting> = {
  logs: { label: 'All event log destinations', topic: 'logging', types: [ChannelType.GuildText] },
  'logs.dm': { label: 'Private DM inbox', topic: 'logging', types: [ChannelType.GuildText] },
  suggestionChannel: {
    label: 'Suggestions destination',
    topic: 'community',
    types: [ChannelType.GuildText],
  },
  staffRoles: { label: 'Staff allowlist roles', topic: 'roles', roles: 10 },
  selfRoles: { label: 'Bot self-service roles', topic: 'roles', roles: 25 },
  joinRoles: { label: 'Automatic join roles', topic: 'onboarding', roles: 25 },
  verifiedRole: { label: 'Optional verification role', topic: 'roles', roles: 1 },
  voiceLobby: {
    label: 'Join-to-create voice lobby',
    topic: 'voice',
    types: [ChannelType.GuildVoice],
  },
  voiceCategory: {
    label: 'Temporary voice category',
    topic: 'voice',
    types: [ChannelType.GuildCategory],
  },
  voiceNoticeChannel: {
    label: 'Voice creation notices',
    topic: 'voice',
    types: [ChannelType.GuildText],
  },
  ticketCategory: {
    label: 'Private ticket category',
    topic: 'tickets',
    types: [ChannelType.GuildCategory],
  },
  welcomeChannel: {
    label: 'Join/exit message destination',
    topic: 'onboarding',
    types: [ChannelType.GuildText],
  },
  rulesChannel: {
    label: 'Rules channel link',
    topic: 'onboarding',
    types: [ChannelType.GuildText],
  },
  introductionChannel: {
    label: 'Introduction channel link',
    topic: 'onboarding',
    types: [ChannelType.GuildText],
  },
  'mentionReplies.commandsChannel': {
    label: 'Commands channel link',
    topic: 'community',
    types: [ChannelType.GuildText],
  },
  'starboard.channel': {
    label: 'Starboard destination',
    topic: 'community',
    types: [ChannelType.GuildText],
  },
  'heartbeat.channel': {
    label: 'Heartbeat destination',
    topic: 'automation',
    types: [ChannelType.GuildText],
  },
};
const icons = { ok: '✅', warn: '⚠️', error: '❌', off: '⏸️' };
function current(cfg: GuildConfig, key: string): unknown {
  if (key === 'logs') return cfg.logs;
  const [head, tail] = key.split('.');
  const value = (cfg as unknown as Record<string, unknown>)[head!];
  return tail ? (value as Record<string, unknown>)[tail] : value;
}
function changed(cfg: GuildConfig, key: string, values: string[]): GuildConfig {
  if (key === 'logs') {
    assert(cfg.logs.dm !== values[0], 'Choose a different channel from the DM inbox.');
    cfg.logs = {
      ...cfg.logs,
      ...Object.fromEntries(
        logKinds.filter((kind) => kind !== 'dm').map((kind) => [kind, values[0]]),
      ),
    } as GuildConfig['logs'];
  } else if (key.includes('.')) {
    const [head, tail] = key.split('.');
    (cfg as unknown as Record<string, Record<string, unknown>>)[head!]![tail!] = values[0];
  } else
    (cfg as unknown as Record<string, unknown>)[key] = [
      'staffRoles',
      'selfRoles',
      'joinRoles',
    ].includes(key)
      ? values
      : values[0];
  return configSchema.parse(cfg);
}
export async function validateSelection(app: App, i: Interaction, key: string, values: string[]) {
  owner(i);
  const setting = settings[key];
  assert(setting, 'Unknown setup control.');
  assert(
    values.length >= 1 &&
      values.length <= (setting.roles ?? 1) &&
      values.every((value) => /^\d{17,22}$/.test(value)),
    'Choose valid server channels/roles.',
  );
  const me = await i.guild!.members.fetchMe();
  if (setting.roles) {
    for (const value of values) {
      const role = await i.guild!.roles.fetch(value);
      assert(role && role.id !== i.guildId, 'Select existing roles other than @everyone.');
      if (key !== 'staffRoles') {
        safeRole(role);
        assert(me.permissions.has(P.ManageRoles), 'The bot needs Manage Roles.');
        assert(
          me.roles.highest.comparePositionTo(role) > 0,
          'Move the bot above the selected role.',
        );
        assert(
          !app.store.config(i.guildId!).protectedRoles.includes(role.id),
          'Automated roles must not be protected roles.',
        );
      }
    }
  } else {
    const channel = await i.guild!.channels.fetch(values[0]!);
    assert(
      channel && setting.types!.includes(channel.type),
      'Select an existing channel of the requested type.',
    );
    const required = [P.ViewChannel];
    if (['voiceCategory', 'ticketCategory'].includes(key))
      required.push(P.ManageChannels, P.ManageRoles);
    else if (key === 'voiceLobby') required.push(P.Connect, P.MoveMembers);
    else if (
      !['rulesChannel', 'introductionChannel', 'mentionReplies.commandsChannel'].includes(key)
    )
      required.push(P.SendMessages, P.EmbedLinks);
    assert(
      channel.permissionsFor(me)?.has(required),
      'The bot lacks required permissions in the selected channel. Fix its overrides and try again.',
    );
    if (key === 'logs' || key === 'logs.dm') {
      assert(
        !channel.permissionsFor(i.guild!.roles.everyone)?.has(P.ViewChannel),
        'Choose a staff-only channel. @everyone must not have View Channel.',
      );
      const cfg = app.store.config(i.guildId!);
      if (key === 'logs.dm') {
        assert(
          !Object.entries(cfg.logs).some(([kind, id]) => kind !== 'dm' && id === channel.id),
          'Use a separate channel for DM conversations.',
        );
        assert(
          channel
            .permissionsFor(me)
            ?.has([P.ReadMessageHistory, P.CreatePublicThreads, P.SendMessagesInThreads]),
          'The bot needs Read Message History, Create Public Threads and Send Messages in Threads in its DM inbox.',
        );
      }
      for (const role of i.guild!.roles.cache.values())
        if (
          role.id !== i.guildId &&
          !role.managed &&
          !cfg.staffRoles.includes(role.id) &&
          !role.permissions.any([
            P.Administrator,
            P.ManageGuild,
            P.ManageMessages,
            P.ModerateMembers,
          ])
        )
          assert(
            !channel.permissionsFor(role)?.has(P.ViewChannel),
            'An ordinary member role can view this channel. Remove its View Channel access before selecting it for private logs.',
          );
    }
    if (key === 'starboard.channel') {
      const cfg = app.store.config(i.guildId!);
      assert(
        !cfg.excludedChannels.includes(channel.id) &&
          !Object.values(cfg.logs).includes(channel.id) &&
          cfg.confessions.channel !== channel.id,
        'Starboard must be separate from exclusions, logs and confessions.',
      );
    }
  }
}

export async function setupPanel(
  app: App,
  i: Interaction,
  topic: HealthTopic = 'overview',
  page = 0,
) {
  await requirePermission(app, i, P.ManageGuild);
  readOnlyResponse(i);
  assert(healthTopics.includes(topic), 'Unknown health-check section.');
  const items = await checkSetup(app, i.guild!, topic);
  const pages: string[] = [];
  let part = '';
  for (const item of items) {
    const line = `${icons[item.status]} **${safe(item.name)}**\n${item.detail}\n\n`;
    if (part.length + line.length > 1250 && part) {
      pages.push(part);
      part = '';
    }
    part += line;
  }
  if (part) pages.push(part);
  page = Math.min(Math.max(0, page), pages.length - 1);
  const actor = i.user.id;
  const components: (
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`health:${actor}:section`)
        .setPlaceholder('Choose a feature to check')
        .addOptions(
          healthTopics.map((value) => ({ label: value, value, default: value === topic })),
        ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`health:${actor}:view:${topic}:${page - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`health:${actor}:view:${topic}:${page + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages.length - 1),
      new ButtonBuilder()
        .setCustomId(`health:${actor}:view:${topic}:${page}`)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`health:${actor}:guide:${topic}`)
        .setLabel('Setup steps')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  const choices = Object.entries(settings).filter(
    ([, setting]) =>
      setting.topic === topic ||
      (topic === 'overview' && ['roles', 'logging'].includes(setting.topic)),
  );
  if (i.user.id === i.guild!.ownerId && choices.length)
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`health:${actor}:configure`)
          .setPlaceholder('Owner: configure a setting')
          .addOptions(choices.map(([value, setting]) => ({ label: setting.label, value }))),
      ),
    );
  const counts = items.reduce((n, item) => (n[item.status]++, n), {
    ok: 0,
    warn: 0,
    error: 0,
    off: 0,
  });
  await reply(i, {
    content: `**Setup & health — ${topic}**\n${counts.ok} passed · ${counts.warn} review · ${counts.error} blocking · ${counts.off} off\n\n${pages[page] ?? 'No checks.'}Page ${page + 1}/${pages.length}. This is a private diagnostic view; refreshing changes no settings.`,
    components,
  });
}
export async function applyGuidedSetting(app: App, i: Interaction, pending: Confirmation) {
  owner(i);
  const key = String(pending.payload.key),
    values = pending.payload.values as string[];
  await validateSelection(app, i, key, values);
  const cfg = app.store.config(i.guildId!);
  assert(
    JSON.stringify(current(cfg, key)) === pending.payload.before,
    'This setting changed after the preview. Reopen setup and review the current value.',
  );
  app.store.setConfig(i.guildId!, changed(cfg, key, values), i.user.id);
  await app.audit(
    i.guildId!,
    'admin',
    'Guided setup changed',
    `Updated by <@${i.user.id}>. Setting: ${key}. Use /diagnose feature:${settings[key]!.topic} to check the result.`,
    { force: true },
  );
  await reply(
    i,
    `Saved ${settings[key]!.label}. Run /diagnose feature:${settings[key]!.topic} to refresh its health. Related features may still need their explicit setup/enable command; this selection grants no Discord permissions.`,
  );
}
const steps: Record<HealthTopic, string> = {
  overview:
    '1. Configure private logs. 2. Select staff roles and grant their native Discord permissions. 3. Configure only features you need. 4. Test with an ordinary member. 5. Open /backup and verify recovery readiness. Panels can select existing channels/roles; they do not grant permissions or create them.',
  logging:
    'Set staffRoles, then run /logs setup to create the private category and missing event/DM channels. Reruns reuse channels; /logs status lists them. Or select existing destinations below. Keep ordinary roles out. DM conversations use a separate inbox; staff reply with Reply or /dm reply. Message snapshots are optional: /config set key:snapshotDays value:7. Old uncached content cannot be recovered.',
  moderation:
    'Grant the bot the needed moderation permissions and put its role above targets. Configure protectedRoles/staffRoles via /config. /automod status checks native rules; report-only detects without deleting. /help command:mod and automod describe enforcement. Test with an ordinary member.',
  roles:
    'Use the owner picker for staffRoles, selfRoles or verifiedRole. Staff roles need native Discord permissions separately. Automated roles must be unprivileged and below the bot. Publish /role menu only if using bot self roles. Native Channels & Roles is configured through Discord Onboarding.',
  voice:
    'Create a voice lobby and category in Discord. Select them here, then check /voice status. /voice setup also configures them together. Grant Manage Channels, Manage Roles/Permissions and Move Members; check category overrides. Join the lobby to create a room. Instructions appear in native voice text chat.',
  tickets:
    'Create a Support Tickets category and public #support. Select the category and staffRoles here. Staff need Manage Messages; the bot needs Manage Channels/Manage Roles and posting/history/attachment permissions. Run /ticket panel channel:#support. Test that ordinary members cannot see another person’s ticket.',
  onboarding:
    'Select join/exit, rules and introductions links. For native Channels & Roles use /onboarding setup roles_source:native. Public bot welcomes default off; welcome DMs and goodbye messages are independent. Use /onboarding preview before /onboarding setup welcome_dm:true. Join roles wait for native screening when configured.',
  confessions:
    'Use /confession setup to choose publication, optional private review and privacy mode explicitly. Instant mode can omit review. Grant Create Public Threads/Send Messages in Threads for anonymous replies. No command looks up authors. Read /help command:confess before enabling; panel selections do not silently enable confessions.',
  community:
    'Pick commands-channel or starboard destinations here. Enable starboard explicitly with /starboard setup. Polls, text effects and mention replies have their own settings; /help lists member tools. Commands-channel links are shown only to members with access.',
  automation:
    'Choose a heartbeat channel here, then enable with /heartbeat setup channel:#bot-status minutes:5. /announce schedule and /event are one-time schedules. Review /jobs list for failed work. Offline bots cannot post offline alerts.',
  backups:
    'Open /backup for Create verified backup, Refresh, file verification and offline recovery instructions. Copy the backup + manifest off-host using your host filesystem. The recovery tool verifies first, requires a stopped bot for apply and preserves the previous database. Nothing in this panel uploads private database contents.',
};
export const setup: Module = {
  component: async (app, i) => {
    if (!(i.isButton() || i.isAnySelectMenu?.()) || !i.customId.startsWith('health:')) return false;
    const [, actor, action, value, rawPage] = i.customId.split(':');
    assert(actor === i.user.id, 'This setup panel belongs to another member.');
    await requirePermission(app, i, P.ManageGuild);
    if (action === 'view') await setupPanel(app, i, value as HealthTopic, Number(rawPage) || 0);
    else if (action === 'section' && i.isStringSelectMenu())
      await setupPanel(app, i, i.values[0] as HealthTopic);
    else if (action === 'guide') {
      assert(healthTopics.includes(value as HealthTopic), 'Unknown setup section.');
      readOnlyResponse(i);
      await reply(i, {
        content: `**Setup steps — ${value}**\n${steps[value as HealthTopic]}`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`health:${actor}:view:${value}:0`)
              .setLabel('Back to health checks')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    } else if (action === 'configure' && i.isStringSelectMenu()) {
      owner(i);
      const key = i.values[0]!,
        setting = settings[key];
      assert(setting, 'Unknown setting.');
      readOnlyResponse(i);
      const picker = setting.roles
        ? new RoleSelectMenuBuilder()
            .setCustomId(`health:${actor}:pick:${key}`)
            .setMinValues(1)
            .setMaxValues(setting.roles)
            .setPlaceholder(setting.label)
        : new ChannelSelectMenuBuilder()
            .setCustomId(`health:${actor}:pick:${key}`)
            .setChannelTypes(...setting.types!)
            .setPlaceholder(setting.label);
      await reply(i, {
        content: `**Configure ${setting.label}**\nChoose existing ${setting.roles ? 'roles' : 'channels'} below. You will review and confirm before anything is saved.${key === 'logs' ? '\nThis replaces ALL log destinations with the selected staff-only channel. Use /config log to keep separate destinations.' : ''}${key === 'staffRoles' ? '\nThis is an extra command allowlist. It does not grant native permissions.' : ''}`,
        components: [
          new ActionRowBuilder<RoleSelectMenuBuilder | ChannelSelectMenuBuilder>().addComponents(
            picker,
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`health:${actor}:view:${setting.topic}:0`)
              .setLabel('Back')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    } else if (action === 'pick' && (i.isRoleSelectMenu() || i.isChannelSelectMenu())) {
      const key = value!;
      await validateSelection(app, i, key, i.values);
      const cfg = app.store.config(i.guildId!);
      await confirm(
        app,
        i,
        `Set ${settings[key]!.label} to ${i.values.map((id) => `${settings[key]!.roles ? '<@&' : '<#'}${id}>`).join(', ')}? Other settings will be preserved.`,
        'guidedSetting',
        { key, values: i.values, before: JSON.stringify(current(cfg, key)) },
      );
    } else throw Error('Unknown setup action.');
    return true;
  },
};
