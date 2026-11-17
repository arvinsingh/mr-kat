import { auditChange } from '../change-receipts.js';
import { AttachmentBuilder, PermissionFlagsBits as P } from 'discord.js';
import { configSchema, logKinds, modules, type LogKind, type GuildConfig } from '../config.js';
import type { App, Command, Module, Interaction } from '../types.js';
import { owner, requirePermission, safeRole, botPermission } from '../permissions.js';
import { confirm, reply, type Confirmation, embed } from '../ui.js';
import { assert, safe } from '../util.js';
import { textChannel } from '../discord.js';
import type { ChangeReceipt } from '../change-receipts.js';
import { setupPanel, validateSelection } from './setup.js';
import type { HealthTopic } from '../setup-settings.js';
import { validateRoastConfig } from '../roast-setup.js';

export async function validateConfig(app: App, i: Interaction, cfg: GuildConfig): Promise<void> {
  await validateRoastConfig(app, cfg.roast);
  assert(
    !cfg.logs.dm ||
      !Object.entries(cfg.logs).some(([kind, id]) => kind !== 'dm' && id === cfg.logs.dm),
    'Use a separate channel for DM conversations.',
  );
  for (const roleId of new Set(
    [
      ...cfg.protectedRoles,
      ...cfg.staffRoles,
      ...cfg.selfRoles,
      ...cfg.restoreRoles,
      ...cfg.joinRoles,
      ...cfg.automod.exemptRoles,
      ...Object.keys(cfg.rolePrerequisites),
      ...Object.values(cfg.rolePrerequisites),
      ...cfg.roleExclusiveGroups.flat(),
      cfg.joinRole,
      cfg.verifiedRole,
    ].filter((v): v is string => Boolean(v)),
  )) {
    const role = await i.guild!.roles.fetch(roleId);
    assert(role, `Role ${roleId} does not exist in this server.`);
    if (
      [
        ...cfg.selfRoles,
        ...cfg.restoreRoles,
        ...cfg.joinRoles,
        cfg.joinRole,
        cfg.verifiedRole,
      ].includes(roleId)
    ) {
      safeRole(role);
      const me = await i.guild!.members.fetchMe();
      assert(
        me.roles.highest.comparePositionTo(role) > 0,
        `Move the bot above ${safe(role.name)}.`,
      );
      assert(!cfg.protectedRoles.includes(roleId), 'Automated roles must not be protected roles.');
    }
  }
  for (const channelId of new Set(
    [
      ...Object.values(cfg.logs),
      ...cfg.excludedChannels,
      ...cfg.textEffects.channels,
      ...cfg.automod.exemptChannels,
      cfg.welcomeChannel,
      cfg.rulesChannel,
      cfg.rolesSource === 'channel' ? cfg.rolesChannel : undefined,
      cfg.introductionChannel,
      cfg.suggestionChannel,
      cfg.logsCategory,
      cfg.mentionReplies.commandsChannel,
      cfg.ticketCategory,
      cfg.supportChannel,
      cfg.voiceCategory,
      cfg.voiceLobby,
      cfg.voiceNoticeChannel,
      cfg.heartbeat.channel,
      cfg.confessions.channel,
      cfg.confessions.reviewRequired ? cfg.confessions.reviewChannel : undefined,
    ].filter((v): v is string => Boolean(v)),
  )) {
    const channel = await i.guild!.channels.fetch(channelId);
    assert(channel, `Channel ${channelId} does not exist in this server.`);
    if (Object.values(cfg.logs).includes(channelId) || cfg.welcomeChannel === channelId)
      await textChannel(app, i.guildId!, channelId);
  }
  for (const category of [cfg.ticketCategory, cfg.voiceCategory, cfg.logsCategory].filter(Boolean))
    assert(
      (await i.guild!.channels.fetch(category!))?.type === 4,
      'Ticket, voice and log categories must be categories.',
    );
  if (cfg.supportChannel) {
    const support = await textChannel(app, i.guildId!, cfg.supportChannel);
    assert(support.type === 0, 'Support panels require a normal text channel.');
    await botPermission(i.guild!, [P.SendMessages, P.EmbedLinks], support);
  }
  if (cfg.welcomeChannel) {
    const welcome = await textChannel(app, i.guildId!, cfg.welcomeChannel);
    await botPermission(
      i.guild!,
      cfg.publicWelcome ? [P.SendMessages, P.EmbedLinks] : P.SendMessages,
      welcome,
    );
  }
  for (const id of [cfg.voiceNoticeChannel, cfg.heartbeat.channel].filter(Boolean)) {
    const channel = await textChannel(app, i.guildId!, id!);
    assert(channel.type === 0, 'Voice notices and heartbeat require normal text channels.');
    await botPermission(i.guild!, [P.SendMessages, P.EmbedLinks], channel);
  }
  assert(!cfg.heartbeat.enabled || cfg.heartbeat.channel, 'Enabled heartbeat needs a channel.');
  for (const id of cfg.textEffects.channels) await textChannel(app, i.guildId!, id);
  if (cfg.mentionReplies.commandsChannel) {
    const channel = await textChannel(app, i.guildId!, cfg.mentionReplies.commandsChannel);
    assert(channel.type === 0, 'The bot commands destination must be a normal text channel.');
  }
  if (cfg.voiceLobby)
    assert(
      (await i.guild!.channels.fetch(cfg.voiceLobby))?.type === 2,
      'The voice lobby must be a voice channel.',
    );
  if (cfg.confessions.enabled) {
    assert(
      cfg.confessions.channel && (!cfg.confessions.reviewRequired || cfg.confessions.reviewChannel),
      'Enabled confessions require a publication channel and, in review mode, a staff-review channel.',
    );
    assert(
      cfg.confessions.channel !== cfg.confessions.reviewChannel,
      'Confession publication and review must use different channels.',
    );
    const review = cfg.confessions.reviewRequired
      ? await textChannel(app, i.guildId!, cfg.confessions.reviewChannel!)
      : undefined;
    const publication = await textChannel(app, i.guildId!, cfg.confessions.channel);
    assert(
      (!review || review.type === 0) && publication.type === 0,
      'Confessions require standard text channels.',
    );
    assert(
      !review || !review.permissionsFor(i.guild!.roles.everyone)?.has(P.ViewChannel),
      'Confession review must be private to staff, not visible to @everyone.',
    );
  }
  if (cfg.starboard.enabled) {
    assert(cfg.starboard.channel, 'Enabled starboard requires a destination channel.');
    const board = await textChannel(app, i.guildId!, cfg.starboard.channel);
    assert(board.type === 0, 'Starboard requires a normal text channel.');
    assert(
      !cfg.excludedChannels.includes(board.id) &&
        !Object.values(cfg.logs).includes(board.id) &&
        board.id !== cfg.confessions.channel,
      'Starboard must use a separate channel outside logs, exclusions and confessions.',
    );
    await botPermission(i.guild!, [P.SendMessages, P.EmbedLinks, P.ReadMessageHistory], board);
  }
  assert(
    !cfg.roleExclusiveGroups.flat().some((role) => !cfg.selfRoles.includes(role)),
    'Exclusive role groups may only include self-service roles.',
  );
}
export async function adminConfirmation(
  app: App,
  i: Interaction,
  pending: Confirmation,
): Promise<void> {
  owner(i);
  assert(
    Number.isInteger(pending.payload.revision),
    'This settings preview is outdated. Run the command again.',
  );
  const cfg = configSchema.parse(pending.payload.config);
  await validateConfig(app, i, cfg);
  const previous = app.store.config(i.guildId!);
  const changed = (Object.keys(cfg) as (keyof GuildConfig)[]).filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(cfg[key]),
  );
  app.store.setConfig(i.guildId!, cfg, i.user.id, Number(pending.payload.revision));
  await auditChange(
    app,
    i,
    'Configuration updated',
    `Changed settings: ${changed.join(', ') || 'no differences'}.`,
    { force: true },
  );
  await reply(i, 'Configuration saved.');
}
async function config(app: App, i: Command) {
  owner(i);
  const action = i.options.getSubcommand();
  const cfg = app.store.config(i.guildId);
  const revision = app.store.configRevision(i.guildId);
  if (action === 'show' || action === 'export') {
    await reply(i, {
      files: [
        new AttachmentBuilder(Buffer.from(JSON.stringify(cfg, null, 2)), {
          name: 'server-config.json',
        }),
      ],
      content:
        'Server settings. Review channel access before choosing log destinations. Message snapshots are opt-in (snapshotDays).',
    });
    return;
  }
  if (action === 'import') {
    const file = i.options.getAttachment('file', true);
    assert(file.size <= 64000, 'Configuration files must be under 64 KB.');
    const url = new URL(file.url);
    assert(
      url.protocol === 'https:' &&
        ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname),
      'Use a Discord file attachment.',
    );
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert(response.ok, 'Could not download the configuration attachment.');
    const reader = response.body!.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64000) {
        await reader.cancel();
        throw new Error('Configuration exceeds 64 KB.');
      }
      chunks.push(next.value);
    }
    const parsed = configSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    await validateConfig(app, i, parsed);
    await confirm(
      app,
      i,
      'Replace the current server settings with the attached configuration?',
      'configImport',
      { config: parsed, revision },
    );
    return;
  }
  if (action === 'log')
    cfg.logs[i.options.getString('kind', true) as LogKind] = i.options.getChannel(
      'channel',
      true,
    ).id;
  if (action === 'module')
    cfg.modules[i.options.getString('name', true) as (typeof modules)[number]] =
      i.options.getString('state', true) === 'on';
  if (action === 'set') {
    const key = i.options.getString('key', true);
    assert(key in configSchema.shape, 'Unknown setting. Use /config export to see available keys.');
    const value: unknown = JSON.parse(i.options.getString('value', true));
    const parsed = configSchema.parse({ ...cfg, [key]: value });
    await validateConfig(app, i, parsed);
    await confirm(app, i, `Change ${safe(key)} to the supplied JSON value?`, 'configImport', {
      config: parsed,
      revision,
    });
    return;
  }
  await validateConfig(app, i, cfg);
  app.store.setConfig(i.guildId, cfg, i.user.id, revision);
  await reply(i, 'Settings saved.');
}
export const admin: Module = {
  commands: {
    changes: async (app, i) => {
      await requirePermission(app, i, P.ManageGuild);
      const items = app.store.entries<ChangeReceipt>(
        i.guildId,
        'commandReceipt',
        i.options.getInteger('limit') ?? 10,
      );
      await reply(
        i,
        items
          .map(
            ({ data }) =>
              `<t:${Math.floor(data.at / 1000)}:R> · /${safe(data.path)} · <@${data.actor}>\n${safe(data.result, 300)}`,
          )
          .join('\n\n')
          .slice(0, 1900) || 'No retained command-change receipts.',
      );
    },
    config,
    setup: async (app, i) => {
      owner(i);
      const channel = i.options.getChannel('logs');
      if (!channel) {
        await setupPanel(app, i, (i.options.getString('feature') ?? 'overview') as HealthTopic);
        return;
      }
      const destination = await textChannel(app, i.guildId, channel.id);
      assert(
        !destination.permissionsFor(i.guild.roles.everyone)?.has(P.ViewChannel),
        'Choose a staff-only log channel.',
      );
      await validateSelection(app, i, 'logs', [channel.id]);
      const cfg = app.store.config(i.guildId);
      assert(cfg.logs.dm !== channel.id, 'Choose a different channel from the DM inbox.');
      for (const kind of logKinds.filter((kind) => kind !== 'dm')) cfg.logs[kind] = channel.id;
      await validateConfig(app, i, cfg);
      app.store.setConfig(i.guildId, cfg, i.user.id);
      await reply(
        i,
        'Log destinations saved. Keep this channel staff-only. Next: /diagnose, then /config export. Set staffRoles, protectedRoles, selfRoles, verifiedRole and voice settings as needed. Publish /ticket panel channel:#support; ticket categories are automatic. Message content storage is off until snapshotDays is set above 0.',
      );
    },
    status: async (app, i) => {
      await reply(i, {
        embeds: [
          embed(
            'Bot status',
            `Gateway latency: ${app.client.ws.ping} ms\nUptime: ${Math.floor(process.uptime())} seconds\nModules enabled: ${Object.entries(
              app.store.config(i.guildId).modules,
            )
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(', ')}\nStorage: SQLite with persistent jobs`,
          ),
        ],
      });
    },
    diagnose: async (app, i) => {
      await setupPanel(app, i, (i.options.getString('feature') ?? 'overview') as HealthTopic);
    },
    jobs: async (app, i) => {
      const isStaff = i.memberPermissions.has(P.ManageGuild);
      if (isStaff) await requirePermission(app, i, P.ManageGuild);
      if (i.options.getSubcommand() === 'cancel' || i.options.getSubcommand() === 'show') {
        const key = i.options.getString('id', true);
        const job = app.store.findJob(i.guildId, key);
        assert(job && (job.actor === i.user.id || isStaff), 'Job not found or not yours.');
        if (i.options.getSubcommand() === 'show') {
          const result = {
            id: job.id,
            kind: job.kind,
            state: job.state,
            due: new Date(job.due).toISOString(),
            attempts: job.attempts,
            processed: job.payload.index,
            results: job.payload.results,
            error: job.error,
          };
          await reply(i, {
            files: [
              new AttachmentBuilder(Buffer.from(JSON.stringify(result, null, 2)), {
                name: 'job-result.json',
              }),
            ],
          });
          return;
        }
        assert(
          !['roleExpire', 'unban', 'pollClose', 'deleteChannel'].includes(job.kind),
          'Expiry and cleanup jobs cannot be cancelled here. Change the underlying role, ban, poll, or temporary channel explicitly.',
        );
        assert(app.store.cancelJob(i.guildId, key), 'This job is already finished.');
        await reply(i, 'Cancellation requested. Completed changes are not undone.');
        return;
      }
      const jobs = app.store.jobs(i.guildId, 15, isStaff ? undefined : i.user.id);
      await reply(
        i,
        jobs
          .map(
            (j) =>
              `${j.id} · ${j.kind} · ${j.state}\nDue <t:${Math.floor(j.due / 1000)}:R>${j.error ? ` · ${safe(j.error, 120)}` : ''}`,
          )
          .join('\n') || 'No jobs found.',
      );
    },
  },
};
