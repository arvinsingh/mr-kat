import {
  PermissionFlagsBits as P,
  ChannelType,
  type Guild,
  type GuildMember,
  type GuildBasedChannel,
} from 'discord.js';
import type { App } from './types.js';
import type { Job } from './store.js';
import { assert, errorText, logError } from './util.js';
import { botPermission, checkHierarchy, safeRole } from './permissions.js';
import { textChannel } from './discord.js';
import { embed, noMentions } from './ui.js';
import { lockChannel, restoreLock } from './modules/channels.js';
import { updatePoll, type Poll } from './modules/community.js';
import type { RoleTimer } from './modules/roles.js';
import { heartbeatTick } from './modules/heartbeat.js';
import { runPurge } from './purge.js';
import { expireUwuLocks } from './uwulock.js';

export async function jobAuthority(
  app: App,
  job: Job,
  permission: bigint,
  channel?: GuildBasedChannel,
): Promise<{ guild: Guild; actor: GuildMember; me: GuildMember }> {
  const guild = await app.client.guilds.fetch(job.guild);
  const actor = await guild.members.fetch(job.actor);
  const me = await botPermission(guild, permission, channel);
  assert(
    (channel ? channel.permissionsFor(actor) : actor.permissions)?.has(permission),
    'The requesting member no longer has the required permission.',
  );
  const cfg = app.store.config(job.guild);
  assert(
    actor.id === guild.ownerId ||
      !cfg.staffRoles.length ||
      cfg.staffRoles.some((r) => actor.roles.cache.has(r)),
    'The requesting member is no longer authorized staff.',
  );
  return { guild, actor, me };
}
function enabledJob(
  app: App,
  job: Job,
  module: keyof ReturnType<App['store']['config']>['modules'],
) {
  assert(app.store.config(job.guild).modules[module], `The ${module} module is disabled.`);
}
export async function runJob(app: App, job: Job): Promise<void> {
  const p = job.payload;
  if (job.kind === 'purge')
    return runPurge(app, job, (channel) => jobAuthority(app, job, P.ManageMessages, channel));
  if (job.kind === 'batchRoles') {
    enabledJob(app, job, 'roles');
    const targets = p.targets as string[];
    let index = Number(p.index ?? 0);
    const results = (p.results ?? { changed: 0, skipped: 0, failed: 0, errors: [] }) as {
      changed: number;
      skipped: number;
      failed: number;
      errors: string[];
    };
    while (index < targets.length) {
      if (app.store.cancelled(job.id)) return;
      enabledJob(app, job, 'roles');
      try {
        const { guild, actor, me } = await jobAuthority(app, job, P.ManageRoles);
        const target = await guild.members.fetch(targets[index]!);
        const role = await guild.roles.fetch(String(p.role));
        assert(role && !role.managed && role.id !== guild.id, 'Role no longer assignable.');
        assert(!app.store.config(job.guild).protectedRoles.includes(role.id), 'Role is protected.');
        assert(me.roles.highest.comparePositionTo(role) > 0, 'Role is above the bot.');
        assert(
          actor.id === guild.ownerId ||
            (actor.roles.highest.comparePositionTo(role) > 0 &&
              actor.permissions.has(role.permissions)),
          'Role is above the requesting staff member.',
        );
        if (target.id !== actor.id)
          checkHierarchy(
            actor,
            target,
            me,
            guild.ownerId,
            app.store.config(job.guild).protectedRoles,
          );
        const has = target.roles.cache.has(role.id);
        if ((p.action === 'add' && has) || (p.action === 'remove' && !has)) results.skipped++;
        else {
          if (p.action === 'add') await target.roles.add(role, String(p.reason));
          else await target.roles.remove(role, String(p.reason));
          app.store.delete(job.guild, 'roleTimer', `${target.id}:${role.id}`);
          results.changed++;
        }
      } catch (error) {
        results.failed++;
        if (results.errors.length < 10)
          results.errors.push(`${targets[index]}: ${errorText(error)}`);
      }
      index++;
      app.store.updateJob(job.id, { ...p, index, results });
    }
    await app.audit(
      job.guild,
      'admin',
      `Batch roles ${job.id}`,
      `By <@${job.actor}>. Changed: ${results.changed}; skipped: ${results.skipped}; failed: ${results.failed}.`,
    );
    return;
  }
  if (job.kind === 'batchNicknames') {
    enabledJob(app, job, 'moderation');
    const targets = p.targets as string[];
    let index = Number(p.index ?? 0);
    const results = (p.results ?? { changed: 0, skipped: 0, failed: 0, errors: [] }) as {
      changed: number;
      skipped: number;
      failed: number;
      errors: string[];
    };
    while (index < targets.length) {
      if (app.store.cancelled(job.id)) return;
      enabledJob(app, job, 'moderation');
      try {
        const { guild, actor, me } = await jobAuthority(app, job, P.ManageNicknames);
        const target = await guild.members.fetch(targets[index]!);
        checkHierarchy(
          actor,
          target,
          me,
          guild.ownerId,
          app.store.config(job.guild).protectedRoles,
        );
        const name = String(p.template)
          .replaceAll('{name}', target.user.username)
          .replaceAll('{index}', String(index + 1))
          .slice(0, 32);
        assert(name.trim(), 'Generated nickname is empty.');
        if (target.nickname === name) results.skipped++;
        else {
          await target.setNickname(name, String(p.reason));
          results.changed++;
        }
      } catch (error) {
        results.failed++;
        if (results.errors.length < 10)
          results.errors.push(`${targets[index]}: ${errorText(error)}`);
      }
      index++;
      app.store.updateJob(job.id, { ...p, index, results });
    }
    await app.audit(
      job.guild,
      'admin',
      `Batch nicknames ${job.id}`,
      `Changed: ${results.changed}; skipped: ${results.skipped}; failed: ${results.failed}.`,
    );
    return;
  }
  if (job.kind === 'roleExpire') {
    const timer = app.store.get<RoleTimer>(job.guild, 'roleTimer', `${p.target}:${p.role}`);
    if (!timer || timer.generation !== p.generation) return;
    const guild = await app.client.guilds.fetch(job.guild),
      role = await guild.roles.fetch(String(p.role));
    if (!role) {
      app.store.delete(job.guild, 'roleTimer', `${p.target}:${p.role}`);
      return;
    }
    safeRole(role);
    assert(
      !app.store.config(job.guild).protectedRoles.includes(role.id),
      'Expiry role is now protected.',
    );
    const me = await botPermission(guild, P.ManageRoles);
    assert(me.roles.highest.comparePositionTo(role) > 0, 'The expiry role is above the bot.');
    const member = await guild.members.fetch(String(p.target)).catch((error) => {
      if ((error as { code?: number }).code === 10007) return null;
      throw error;
    });
    if (
      app.store.get<RoleTimer>(job.guild, 'roleTimer', `${p.target}:${p.role}`)?.generation !==
      p.generation
    )
      return;
    if (member?.roles.cache.has(role.id)) await member.roles.remove(role, 'Temporary role expired');
    if (
      app.store.get<RoleTimer>(job.guild, 'roleTimer', `${p.target}:${p.role}`)?.generation ===
      p.generation
    )
      app.store.delete(job.guild, 'roleTimer', `${p.target}:${p.role}`);
    return;
  }
  if (job.kind === 'unban') {
    const generation = app.store.get<{ marker: string }>(
      job.guild,
      'banGeneration',
      String(p.target),
    );
    if (!generation || generation.marker !== p.marker) return;
    const guild = await app.client.guilds.fetch(job.guild);
    await botPermission(guild, P.BanMembers);
    const ban = await guild.bans.fetch(String(p.target)).catch((error) => {
      if ((error as { code?: number }).code === 10026) return null;
      throw error;
    });
    if (
      app.store.get<{ marker: string }>(job.guild, 'banGeneration', String(p.target))?.marker !==
      p.marker
    )
      return;
    if (ban && ban.reason === p.reason)
      await guild.bans.remove(String(p.target), 'Temporary ban expired');
    if (
      app.store.get<{ marker: string }>(job.guild, 'banGeneration', String(p.target))?.marker ===
      p.marker
    )
      app.store.delete(job.guild, 'banGeneration', String(p.target));
    return;
  }
  if (job.kind === 'pollClose') {
    const poll = app.store.get<Poll>(job.guild, 'poll', String(p.key));
    if (!poll) return;
    poll.closed = true;
    app.store.put(job.guild, 'poll', String(p.key), poll);
    await updatePoll(app, job.guild, String(p.key));
    return;
  }
  if (job.kind === 'deleteChannel') {
    const managed = app.store.get(job.guild, 'tempText', String(p.channel));
    if (!managed) return;
    const guild = await app.client.guilds.fetch(job.guild);
    await botPermission(guild, P.ManageChannels);
    const channel = await guild.channels.fetch(String(p.channel));
    if (channel) await channel.delete('Temporary text channel expired');
    app.store.delete(job.guild, 'tempText', String(p.channel));
    return;
  }
  if (job.kind === 'reminder' || job.kind === 'announce') {
    // An interrupted network send has an ambiguous outcome. Mark before sending to avoid duplicate delivery on restart.
    // A failed/uncertain send is visible in /jobs and is never automatically re-sent.
    assert(
      !p.deliveryStarted,
      'Delivery was interrupted after it began. Check the destination before rescheduling.',
    );
    enabledJob(app, job, job.kind === 'reminder' ? 'community' : 'messages');
    if (job.kind === 'reminder') {
      const user = await app.client.users.fetch(String(p.user));
      app.store.updateJob(job.id, { ...p, deliveryStarted: true });
      await user.send({
        embeds: [embed(`Reminder · ${String(p.server).slice(0, 150)}`, String(p.text), 'reminder')],
        allowedMentions: noMentions,
      });
    } else {
      const channel = await textChannel(app, job.guild, String(p.channel));
      await jobAuthority(app, job, P.ManageMessages, channel);
      const actor = await channel.guild.members.fetch(job.actor);
      assert(
        channel
          .permissionsFor(actor)
          ?.has([P.ViewChannel, channel.isThread() ? P.SendMessagesInThreads : P.SendMessages]),
        'The requesting staff member cannot post here.',
      );
      app.store.updateJob(job.id, { ...p, deliveryStarted: true });
      const message = await channel.send({
        embeds: [embed(String(p.title), String(p.text), 'announcement')],
        allowedMentions: noMentions,
      });
      app.store.put(job.guild, 'announcement', message.id, {
        actor: job.actor,
        channel: channel.id,
      });
    }
    return;
  }
  throw new Error(`Unknown job kind: ${job.kind}`);
}
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  private stopping = false;
  constructor(private app: App) {}
  start() {
    this.app.store.recoverJobs();
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
    void this.tick();
  }
  async tick() {
    if (this.active || this.stopping) return;
    this.active = true;
    try {
      await heartbeatTick(this.app).catch((error) => logError('heartbeat tick', error));
      await expireUwuLocks(this.app).catch((error) => logError('uwu expiry', error));
      let job;
      for (let count = 0; count < 5 && (job = this.app.store.claimJob()); count++) {
        if (job.guild !== this.app.guildId) {
          this.app.store.finishJob(job.id, 'failed', 'Job belongs to another server.');
          continue;
        }
        try {
          await this.app.runJob(job);
          this.app.store.finishJob(job.id, 'done');
        } catch (error) {
          this.app.store.finishJob(job.id, 'failed', errorText(error));
          logError(`job ${job.id}`, error);
          await this.app
            .audit(
              job.guild,
              'admin',
              `Job failed: ${job.kind}`,
              `Job ${job.id}: ${errorText(error)}`,
            )
            .catch((e) => logError('job failure log', e));
        }
      }
    } finally {
      this.active = false;
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
