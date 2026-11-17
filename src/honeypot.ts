import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  PermissionFlagsBits as P,
  ChannelType,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import type { App } from './types.js';
import type { Job } from './store.js';
import { assert, errorText, logError, safeMentions } from './util.js';
import { checkHierarchy, botPermission } from './permissions.js';
import { modernEdit, displayText } from './presentation.js';
import { noMentions } from './ui.js';
import { moderationNotice, type Delivery } from './dm.js';
import { serial } from './concurrency.js';
import { runPurge } from './purge.js';
import { UserError } from './errors.js';
import { logPayloads } from './log-format.js';
import { logProfile } from './log-profile.js';

export interface HoneypotIncident {
  id: string;
  user: string;
  channel: string;
  at: number;
  since: number;
  until: number;
  timeoutUntil: number;
  timeout: 'started' | 'applied' | 'failed' | 'uncertain';
  scan: 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
  errors: string[];
  skipped: number;
  jobs: string[];
  completed: string[];
  released?: boolean;
  releaseStarted?: boolean;
  cleanupStopped?: boolean;
  caseId?: number;
  cleanupAuthorized?: boolean;
  scanJob?: string;
  ownsTimeout?: boolean;
  notice?: Delivery;
  report?: { channel: string; message: string; native?: boolean };
  reportedErrors?: number;
}
interface ScanProgress {
  incident: string;
  channels?: string[];
  index: number;
  before?: string;
  matches: string[];
}
const busy = new WeakMap<App, Set<string>>();
const incident = (app: App, id: string) => {
  const saved = app.store.get<HoneypotIncident>(app.guildId, 'honeypotIncident', id);
  assert(saved, 'Honeypot incident not found or no longer retained.');
  return saved;
};
function exempt(app: App, member: GuildMember) {
  const cfg = app.store.config(app.guildId);
  return (
    member.user.bot ||
    member.id === member.guild.ownerId ||
    member.permissions.any([
      P.Administrator,
      P.ManageGuild,
      P.ManageMessages,
      P.ModerateMembers,
      P.KickMembers,
      P.BanMembers,
    ]) ||
    [...cfg.staffRoles, ...cfg.protectedRoles].some((id) => member.roles.cache.has(id))
  );
}
function active(app: App, item: HoneypotIncident) {
  const cfg = app.store.config(app.guildId);
  return (
    !item.released &&
    !item.releaseStarted &&
    !item.cleanupStopped &&
    item.timeoutUntil > Date.now() &&
    cfg.honeypot.enabled &&
    cfg.modules.automod &&
    cfg.modules.moderation &&
    cfg.modules.messages
  );
}
function issue(app: App, id: string, text: string) {
  const item = incident(app, id);
  item.skipped++;
  if (item.errors.length < 10) item.errors.push(text.slice(0, 250));
  app.store.put(app.guildId, 'honeypotIncident', id, item);
}
export function honeypotWarning(enabled: boolean) {
  return new ContainerBuilder().addTextDisplayComponents((text) =>
    text.setContent(
      enabled
        ? '## Honeypot — do not post\nPosting here triggers an automatic timeout and deletion of your recent messages across the server. This channel detects spam accounts.'
        : '## Honeypot disabled\nSpam-trap detection is currently disabled in this channel.',
    ),
  );
}
export async function honeypotLog(app: App) {
  const cfg = app.store.config(app.guildId),
    id = cfg.logs.moderation;
  assert(id, 'Configure a private moderation log first. Use /logs setup.');
  const channel = await app.client.channels.fetch(id);
  assert(
    channel?.type === ChannelType.GuildText,
    'The moderation log must be an accessible text channel.',
  );
  assert(channel.guild.id === app.guildId, 'The moderation log must belong to this server.');
  await botPermission(channel.guild, [P.ViewChannel, P.SendMessages, P.EmbedLinks], channel);
  assert(
    !channel.permissionsFor(channel.guild.roles.everyone)?.has(P.ViewChannel),
    'The moderation log must be private to staff.',
  );
  for (const role of channel.guild.roles.cache.values())
    if (
      role.id !== channel.guild.id &&
      !role.managed &&
      !cfg.staffRoles.includes(role.id) &&
      !role.permissions.any([P.Administrator, P.ManageGuild, P.ManageMessages, P.ModerateMembers])
    )
      assert(
        !channel.permissionsFor(role)?.has(P.ViewChannel),
        'An ordinary member role can view the moderation log.',
      );
  return channel;
}
function card(app: App, item: HoneypotIncident) {
  const totals = { deleted: 0, failed: 0, uncertain: 0 };
  for (const id of item.jobs) {
    const result = app.store.findJob(app.guildId, id)?.payload.results as
      Partial<typeof totals> | undefined;
    for (const key of ['deleted', 'failed', 'uncertain'] as const)
      totals[key] += Number(result?.[key] ?? 0);
  }
  return logPayloads(
    'moderation',
    `Honeypot incident${item.released ? ' · released' : ''} · case #${item.caseId ?? 'not recorded'}`,
    `Timeout: ${item.timeout}${item.timeout === 'applied' ? ` · until <t:${Math.floor(item.timeoutUntil / 1000)}:F>` : ''}\nCleanup scan: ${item.scan} · ${item.completed.length}/${item.jobs.length} purges processed\nDeleted: ${totals.deleted} · failed: ${totals.failed} · uncertain: ${totals.uncertain}\nSkipped: ${item.skipped} · Recorded errors: ${item.errors.length}${item.notice ? '\nMember DM: ' + item.notice : ''}`,
    {
      profile: logProfile(app, item.user),
      reference: `<#${item.channel}>`,
      at: item.at,
      footer: `Incident ${item.id}`,
      controls: item.released
        ? []
        : [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`honeypot:release:${item.id}`)
                .setLabel('Release timeout')
                .setStyle(ButtonStyle.Danger),
            ),
          ],
    },
  )[0]!;
}
export async function updateHoneypotReport(app: App, id: string) {
  await serial(app, `honeypot-report:${id}`, async () => {
    const item = incident(app, id);
    if (!item.report) return;
    const channel = await honeypotLog(app);
    if (channel.id !== item.report.channel) return;
    const message = await channel.messages.fetch(item.report.message);
    const payload = card(app, incident(app, id));
    await message.edit(
      item.report.native
        ? {
            embeds: payload.embeds,
            components: payload.components ?? [],
            allowedMentions: noMentions,
          }
        : modernEdit({ ...payload, allowedMentions: noMentions }),
    );
    const latest = incident(app, id);
    const unseen = latest.errors.slice(latest.reportedErrors ?? 0);
    if (unseen.length) {
      latest.reportedErrors = latest.errors.length;
      app.store.put(app.guildId, 'honeypotIncident', id, latest);
      await app.audit(
        app.guildId,
        'moderation',
        'Honeypot diagnostic',
        unseen.map(safeMentions).join('\n'),
        {
          force: true,
          profile: logProfile(app, item.user),
          reference: `<#${item.channel}>`,
          footer: `Incident ${id}`,
        },
      );
    }
  }).catch((error) => logError('honeypot report update', error));
}

// Called once at startup. Resume inspection, never replay a timeout with an unknown outcome.
export function recoverHoneypot(app: App) {
  if (!app.client.user) return;
  for (const { data: item } of app.store.entriesMatching<HoneypotIncident>(
    app.guildId,
    'honeypotIncident',
    { scan: 'queued' },
    2147483647,
  )) {
    if (item.scanJob) continue;
    if (item.timeout === 'started') {
      item.timeout = 'uncertain';
      item.errors.push(
        'Startup interrupted the timeout; its outcome is unknown and it was not retried.',
      );
    }
    app.store.transaction(() => {
      if (item.cleanupAuthorized && active(app, item))
        item.scanJob = app.store.job(app.guildId, app.client.user!.id, 'honeypotCleanup', {
          incident: item.id,
          index: 0,
          matches: [],
        });
      else item.scan = 'cancelled';
      app.store.put(app.guildId, 'honeypotIncident', item.id, item);
    });
  }
}

export async function honeypotMessage(app: App, message: Message): Promise<boolean> {
  const cfg = app.store.config(app.guildId),
    setting = cfg.honeypot;
  if (
    !message.guild ||
    message.guildId !== app.guildId ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    !setting.enabled ||
    setting.channel !== message.channelId ||
    !cfg.modules.automod ||
    !cfg.modules.moderation ||
    !cfg.modules.messages ||
    !app.store.get<{ armed: boolean }>(app.guildId, 'honeypotChannel', message.channelId)?.armed
  )
    return false;
  const guild = message.guild;
  let pending = busy.get(app);
  if (!pending) busy.set(app, (pending = new Set()));
  if (pending.has(message.author.id)) return true;
  pending.add(message.author.id);
  try {
    return await serial(app, `honeypot-incident:${message.id}`, async () => {
      const member = await guild.members.fetch({ user: message.author.id, force: true });
      if (exempt(app, member)) return false;
      // Never reapply a completed/interrupted action for the same gateway message.
      if (app.store.get(app.guildId, 'honeypotIncident', message.id)) return true;
      const prior = app.store.get<{ incident: string; until: number }>(
        app.guildId,
        'honeypotActive',
        member.id,
      );
      const previous =
        prior && app.store.get<HoneypotIncident>(app.guildId, 'honeypotIncident', prior.incident);
      if (
        previous &&
        !previous.released &&
        prior!.until > Date.now() &&
        ((member.communicationDisabledUntilTimestamp ?? 0) > Date.now() ||
          Date.now() - previous.at < 60000)
      )
        return true;
      // Fetching a member may outlive a disable/settings change.
      const fresh = app.store.config(app.guildId);
      if (
        !fresh.honeypot.enabled ||
        fresh.honeypot.channel !== message.channelId ||
        !fresh.modules.automod ||
        !fresh.modules.moderation ||
        !fresh.modules.messages
      )
        return true;
      const me = await guild.members.fetchMe();
      const current = app.store.config(app.guildId);
      if (
        !current.honeypot.enabled ||
        current.honeypot.channel !== message.channelId ||
        !current.modules.automod ||
        !current.modules.moderation ||
        !current.modules.messages ||
        exempt(app, member)
      )
        return true;
      const at = Date.now();
      const item: HoneypotIncident = {
        id: message.id,
        user: member.id,
        channel: message.channelId,
        at,
        since: at - current.honeypot.cleanupMinutes * 60000,
        until: at,
        timeoutUntil: at + current.honeypot.timeoutDays * 86400000,
        timeout: 'started',
        scan: 'queued',
        errors: [],
        skipped: 0,
        jobs: [],
        completed: [],
        released: false,
      };
      let hierarchy = true;
      try {
        checkHierarchy(me, member, me, guild.ownerId, current.protectedRoles);
      } catch (error) {
        hierarchy = false;
        item.errors.push(errorText(error));
      }
      item.cleanupAuthorized = hierarchy;
      // Save intent before contacting Discord; interrupted timeouts are never blindly replayed.
      app.store.transaction(() => {
        app.store.put(app.guildId, 'honeypotIncident', item.id, item);
        app.store.put(app.guildId, 'honeypotActive', member.id, {
          incident: item.id,
          until: item.timeoutUntil,
        });
      });
      try {
        assert(
          hierarchy,
          'Target is above the bot or protected; no automatic cleanup was authorized.',
        );
        await botPermission(guild, P.ModerateMembers);
        assert(active(app, incident(app, item.id)), 'Honeypot was disabled during enforcement.');
        if ((member.communicationDisabledUntilTimestamp ?? 0) >= item.timeoutUntil) {
          item.timeoutUntil = member.communicationDisabledUntilTimestamp!;
          item.ownsTimeout = false;
          item.errors.push(
            'An existing longer timeout was preserved; review it separately before removing it.',
          );
        } else {
          item.ownsTimeout = true;
          await member.disableCommunicationUntil(
            item.timeoutUntil,
            'Honeypot: posted in the do-not-post channel',
          );
        }
        item.timeout = 'applied';
      } catch (error) {
        item.timeout =
          error instanceof UserError ||
          typeof (error as { code?: unknown }).code === 'number' ||
          !hierarchy
            ? 'failed'
            : 'uncertain';
        item.errors.push('Timeout: ' + errorText(error));
      }
      item.until = Date.now();
      item.caseId = app.store.addCase(
        app.guildId,
        me.id,
        member.id,
        'honeypot',
        'Posted in the honeypot warning channel',
      );
      app.store.count(app.guildId, 'moderation');
      app.store.transaction(() => {
        item.cleanupStopped = incident(app, item.id).cleanupStopped;
        if (hierarchy && !item.cleanupStopped)
          item.scanJob = app.store.job(app.guildId, me.id, 'honeypotCleanup', {
            incident: item.id,
            index: 0,
            matches: [],
          });
        else item.scan = 'cancelled';
        app.store.put(app.guildId, 'honeypotIncident', item.id, item);
      });
      const logChannel = await honeypotLog(app).catch((error) => {
        issue(app, item.id, 'Private log unavailable: ' + errorText(error));
        return null;
      });
      if (logChannel)
        await app
          .audit(
            app.guildId,
            'moderation',
            `Honeypot evidence · case #${item.caseId}`,
            `Trigger:\n${safeMentions(message.content || displayText(message) || '[No text]')}\n${[...message.attachments.values()].map((file) => `Attachment: ${safeMentions(file.name ?? file.id)} · ${file.url}`).join('\n')}`,
            {
              force: true,
              profile: logProfile(app, member.id, member),
              reference: `<#${message.channelId}>`,
              footer: `Incident ${item.id}`,
              at: item.at,
            },
          )
          .catch((error) => logError('honeypot trigger log', error));
      if (logChannel) {
        try {
          const posted = await logChannel.send(card(app, incident(app, item.id)));
          const latest = incident(app, item.id);
          latest.report = { channel: logChannel.id, message: posted.id, native: true };
          app.store.put(app.guildId, 'honeypotIncident', item.id, latest);
        } catch (error) {
          logError('honeypot incident card', error);
        }
      }
      const noticeApp: App = {
        ...app,
        audit: async (...args) => {
          if (await honeypotLog(app).catch(() => null)) return app.audit(...args);
        },
      };
      const delivery = await moderationNotice(
        noticeApp,
        app.guildId,
        guild.name,
        member.id,
        'Honeypot triggered',
        'You posted in the channel marked “do not post”.',
        `${item.timeout === 'applied' ? `Your account is timed out until ${new Date(item.timeoutUntil).toISOString()}. ` : 'Staff have been notified. '}Recent messages across the server are being checked for deletion. Contact server staff to request review.`,
        false,
      ).catch((error) => logError('honeypot DM', error));
      const notified = incident(app, item.id);
      notified.notice = delivery ?? 'uncertain';
      app.store.put(app.guildId, 'honeypotIncident', item.id, notified);
      await updateHoneypotReport(app, item.id);
      return true;
    });
  } finally {
    pending.delete(message.author.id);
  }
}

async function cleanupAuthority(app: App, guild: Guild, id: string) {
  const item = incident(app, id);
  assert(active(app, item), 'Honeypot cleanup stopped: disabled or released.');
  const member = await guild.members.fetch({ user: item.user, force: true }).catch((error) => {
    if ((error as { code?: number }).code === 10007) return null;
    throw error;
  });
  const me = await guild.members.fetchMe();
  if (member) {
    assert(!exempt(app, member), 'Member is now exempt; cleanup stopped.');
    checkHierarchy(me, member, me, guild.ownerId, app.store.config(app.guildId).protectedRoles);
  }
  assert(active(app, incident(app, id)), 'Honeypot cleanup stopped: disabled or released.');
  return me;
}
async function discoverChannels(app: App, guild: Guild, item: HoneypotIncident): Promise<string[]> {
  const me = await guild.members.fetchMe(),
    channels = await guild.channels.fetch();
  const found = new Set<string>();
  for (const channel of channels.values())
    if (channel?.isTextBased() && channel.isSendable()) found.add(channel.id);
  try {
    for (const thread of (await guild.channels.fetchActiveThreads(false)).threads.values())
      found.add(thread.id);
  } catch (error) {
    issue(app, item.id, 'Active threads: ' + errorText(error));
  }
  for (const channel of channels.values()) {
    if (
      !channel ||
      !('threads' in channel) ||
      !channel.permissionsFor(me)?.has([P.ViewChannel, P.ReadMessageHistory])
    )
      continue;
    for (const type of ['public', 'private'] as const) {
      if (type === 'private' && channel.type !== 0) continue;
      const joinedOnly = type === 'private' && !channel.permissionsFor(me)!.has(P.ManageThreads);
      let before: Date | string | undefined;
      try {
        while (active(app, incident(app, item.id))) {
          const page = await channel.threads.fetchArchived(
            {
              type,
              limit: 100,
              before,
              ...(type === 'private'
                ? { fetchAll: channel.permissionsFor(me)!.has(P.ManageThreads) }
                : {}),
            },
            false,
          );
          for (const thread of page.threads.values())
            if ((thread.archiveTimestamp ?? item.at) >= item.since) found.add(thread.id);
          const oldest = Math.min(
            ...[...page.threads.values()].map((thread) => thread.archiveTimestamp ?? item.at),
          );
          if (!page.hasMore || !page.threads.size || (!joinedOnly && oldest < item.since)) break;
          const next = joinedOnly
            ? [...page.threads.keys()].reduce((min, id) => (BigInt(id) < BigInt(min) ? id : min))
            : new Date(oldest);
          assert(
            !before ||
              (typeof before === 'string' && typeof next === 'string'
                ? BigInt(next) < BigInt(before)
                : before instanceof Date &&
                  next instanceof Date &&
                  next.getTime() < before.getTime()),
            'Archive pagination did not advance.',
          );
          before = next;
        }
      } catch (error) {
        issue(app, item.id, `${channel.name} ${type} archives: ${errorText(error)}`);
      }
    }
  }
  return [...found];
}

export async function runHoneypotCleanup(app: App, job: Job) {
  const p = job.payload as unknown as ScanProgress;
  assert(
    job.guild === app.guildId &&
      job.actor === app.client.user?.id &&
      typeof p.incident === 'string' &&
      Number.isInteger(p.index) &&
      p.index >= 0 &&
      Array.isArray(p.matches) &&
      p.matches.every((id) => typeof id === 'string' && /^\d+$/.test(id)) &&
      (p.channels === undefined ||
        (Array.isArray(p.channels) &&
          p.channels.every((id) => typeof id === 'string') &&
          p.index <= p.channels.length)) &&
      (p.before === undefined || /^\d+$/.test(p.before)),
    'Invalid honeypot cleanup request.',
  );
  if (!active(app, incident(app, p.incident))) {
    const item = incident(app, p.incident);
    item.scan = 'cancelled';
    app.store.put(app.guildId, 'honeypotIncident', item.id, item);
    await updateHoneypotReport(app, item.id);
    return;
  }
  const guild = await app.client.guilds.fetch(job.guild);
  const finishChannel = () =>
    app.store.transaction(() => {
      const item = incident(app, p.incident);
      if (p.matches.length && active(app, item) && !app.store.cancelled(job.id)) {
        item.jobs.push(
          app.store.job(job.guild, job.actor, 'honeypotPurge', {
            channel: p.channels![p.index],
            ids: p.matches,
            older: false,
            honeypot: item.id,
            reason: `Honeypot incident ${item.id}: recent messages from <@${item.user}>`,
          }),
        );
        app.store.put(app.guildId, 'honeypotIncident', item.id, item);
      }
      p.index++;
      p.before = undefined;
      p.matches = [];
      app.store.updateJob(job.id, { ...p });
    });
  try {
    await cleanupAuthority(app, guild, p.incident);
    if (!p.channels) {
      p.channels = await discoverChannels(app, guild, incident(app, p.incident));
      app.store.updateJob(job.id, { ...p });
    }
    const started = incident(app, p.incident);
    started.scan = 'running';
    app.store.put(app.guildId, 'honeypotIncident', p.incident, started);
    while (p.index < p.channels.length) {
      if (app.store.cancelled(job.id) || !active(app, incident(app, p.incident))) break;
      const id = p.channels[p.index]!;
      try {
        const me = await cleanupAuthority(app, guild, p.incident);
        const channel = await guild.channels.fetch(id);
        assert(
          channel?.isTextBased() && channel.isSendable(),
          'Channel is missing or inaccessible.',
        );
        const cfg = app.store.config(app.guildId);
        assert(
          !cfg.excludedChannels.includes(id) &&
            !(channel.parentId && cfg.excludedChannels.includes(channel.parentId)),
          'Channel is explicitly excluded in configuration.',
        );
        assert(
          channel.permissionsFor(me)?.has([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages]),
          'Missing View Channel, Read Message History or Manage Messages.',
        );
        const item = incident(app, p.incident);
        const upper = ((BigInt(item.until + 1) - 1420070400000n) << 22n).toString();
        let before = p.before ?? upper;
        while (true) {
          if (app.store.cancelled(job.id) || !active(app, incident(app, p.incident))) break;
          const page = await channel.messages.fetch({ limit: 100, before, cache: false });
          const messages = [...page.values()];
          const matches = messages
            .filter(
              (message) =>
                message.author.id === item.user &&
                !message.webhookId &&
                !message.system &&
                message.createdTimestamp >= item.since &&
                message.createdTimestamp <= item.until,
            )
            .map((message) => message.id);
          p.matches = [...new Set([...p.matches, ...matches])];
          const oldest = messages.reduce<string | undefined>(
            (min, message) => (!min || BigInt(message.id) < BigInt(min) ? message.id : min),
            undefined,
          );
          if (oldest) {
            assert(BigInt(oldest) < BigInt(before), 'Message pagination did not advance.');
            before = oldest;
            p.before = before;
          }
          app.store.updateJob(job.id, { ...p });
          if (
            messages.length < 100 ||
            messages.some((message) => message.createdTimestamp < item.since)
          )
            break;
        }
        await cleanupAuthority(app, guild, p.incident);
        if (app.store.cancelled(job.id)) break;
        finishChannel();
      } catch (error) {
        issue(app, p.incident, `Channel ${id}: ${errorText(error)}`);
        if (!active(app, incident(app, p.incident))) break;
        // Preserve pages already inspected if a later page becomes unavailable.
        finishChannel();
      }
    }
    const final = incident(app, p.incident);
    final.scan = active(app, final) && !app.store.cancelled(job.id) ? 'done' : 'cancelled';
    app.store.put(app.guildId, 'honeypotIncident', p.incident, final);
  } catch (error) {
    const final = incident(app, p.incident);
    final.scan = active(app, final) ? 'failed' : 'cancelled';
    app.store.put(app.guildId, 'honeypotIncident', p.incident, final);
    issue(app, p.incident, errorText(error));
    throw error;
  } finally {
    await updateHoneypotReport(app, p.incident);
  }
}
export async function runHoneypotPurge(app: App, job: Job) {
  assert(
    job.guild === app.guildId &&
      job.actor === app.client.user?.id &&
      typeof job.payload.honeypot === 'string' &&
      Array.isArray(job.payload.ids) &&
      job.payload.ids.every((id) => typeof id === 'string' && /^\d+$/.test(id)),
    'Invalid honeypot purge request.',
  );
  const id = String(job.payload.honeypot),
    guild = await app.client.guilds.fetch(job.guild);
  try {
    if (!active(app, incident(app, id))) return;
    await cleanupAuthority(app, guild, id);
    await honeypotLog(app);
    const privateApp: App = {
      ...app,
      audit: async (g, _kind, title, text, options) => {
        await honeypotLog(app);
        return app.audit(g, 'moderation', title, text, { ...options, force: true });
      },
    };
    await runPurge(
      privateApp,
      job,
      async (channel: GuildTextBasedChannel) => {
        await cleanupAuthority(app, guild, id);
        const cfg = app.store.config(app.guildId);
        assert(
          !cfg.excludedChannels.includes(channel.id) &&
            !(channel.parentId && cfg.excludedChannels.includes(channel.parentId)),
          'Channel is explicitly excluded.',
        );
        await botPermission(
          guild,
          [P.ViewChannel, P.ReadMessageHistory, P.ManageMessages],
          channel,
        );
        assert(active(app, incident(app, id)), 'Honeypot cleanup stopped: disabled or released.');
      },
      true,
      (message) => {
        const item = incident(app, id);
        return (
          message.author.id === item.user &&
          !message.author.bot &&
          !message.webhookId &&
          !message.system &&
          message.createdTimestamp >= item.since &&
          message.createdTimestamp <= item.until
        );
      },
    );
  } catch (error) {
    issue(app, id, `Purge ${job.id}: ${errorText(error)}`);
    throw error;
  } finally {
    const item = incident(app, id);
    if (!item.completed.includes(job.id)) item.completed.push(job.id);
    app.store.put(app.guildId, 'honeypotIncident', id, item);
    await updateHoneypotReport(app, id);
  }
}
