import { PermissionFlagsBits as P, type GuildTextBasedChannel, type Message } from 'discord.js';
import type { App } from './types.js';
import type { Job } from './store.js';
import { assert, errorText, safe, safeMentions } from './util.js';
import { textChannel } from './discord.js';
import { botPermission } from './permissions.js';
import { messageLogExcludedChannel } from './message-logs.js';
import { channelLabel } from './channel-label.js';
import { displayText } from './presentation.js';

interface PurgeEvidence {
  job: string;
  text: string;
  state: string;
  order: number;
  username?: string;
  content?: string;
}
export interface PurgeDeletion {
  job: string;
  actor: string;
  channel: string;
  state: 'pending' | 'confirmed' | 'uncertain' | 'failed';
  expires: number;
}
export function isPurgeDeletion(app: App, id: string) {
  const row = app.store.get<PurgeDeletion>(app.guildId, 'purgeDeletion', id);
  return !!row && row.expires > Date.now() && row.state !== 'failed';
}
export async function runPurge(
  app: App,
  job: Job,
  checkAuthority: (channel: GuildTextBasedChannel) => Promise<unknown>,
) {
  const p = job.payload,
    ids = p.ids as string[];
  let index = Number(p.index ?? 0);
  const results = (p.results ?? {
    deleted: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0,
    errors: [],
  }) as { deleted: number; skipped: number; failed: number; uncertain: number; errors: string[] };
  results.uncertain ??= 0;
  let outcome = 'completed',
    failure = '';
  let sourceParent: string | null = typeof p.sourceParent === 'string' ? p.sourceParent : null;
  const save = () => {
    p.index = index;
    p.results = results;
    app.store.updateJob(job.id, p);
  };
  const mark = (keys: string[], state: PurgeDeletion['state']) => {
    for (const id of keys) {
      const key = job.id + ':' + id;
      const evidence = app.store.get<PurgeEvidence>(job.guild, 'purgeEvidence', key);
      if (evidence) app.store.put(job.guild, 'purgeEvidence', key, { ...evidence, state });
      app.store.put(job.guild, 'purgeDeletion', id, {
        job: job.id,
        actor: job.actor,
        channel: String(p.channel),
        state,
        expires: Date.now() + 86400000,
      } satisfies PurgeDeletion);
    }
  };
  const failed = (key: string, error: unknown, count = 1, uncertain = false) => {
    if (uncertain) results.uncertain += count;
    else results.failed += count;
    if (results.errors.length < 10) results.errors.push(`${key}: ${errorText(error)}`);
  };
  try {
    assert(app.store.config(job.guild).modules.messages, 'The messages module is disabled.');
    const channel = await textChannel(app, job.guild, String(p.channel));
    sourceParent = channel.parentId;
    p.sourceParent = sourceParent;
    if ('name' in channel) p.channelName = channel.name;
    const authority = async () => {
      await checkAuthority(channel);
      await botPermission(channel.guild, P.ReadMessageHistory, channel);
      assert(app.store.config(job.guild).modules.messages, 'The messages module is disabled.');
    };
    await authority();
    if (p.inFlight) {
      const interrupted = p.inFlight as { keys: string[]; end: number; skipped: number };
      results.uncertain += interrupted.keys.length;
      results.skipped += interrupted.skipped;
      mark(interrupted.keys, 'uncertain');
      index = interrupted.end;
      if (results.errors.length < 10)
        results.errors.push('Interrupted deletion request: outcome unknown; no automatic replay.');
      delete p.inFlight;
      save();
    }
    const perform = async (
      messages: { id: string; message: Message }[],
      end: number,
      skipped: number,
    ) => {
      if (app.store.cancelled(job.id)) {
        outcome = 'cancelled';
        return false;
      }
      await authority();
      const keys = messages.map((item) => item.id);
      if (!keys.length) {
        results.skipped += skipped;
        index = end;
        save();
        return true;
      }
      const cfg = app.store.config(job.guild);
      const recordable =
        cfg.modules.logging &&
        !messageLogExcludedChannel(cfg, String(p.channel)) &&
        !(channel.parentId && cfg.excludedChannels.includes(channel.parentId));
      if (recordable)
        app.store.transaction(() => {
          for (const { id, message } of messages) {
            if (app.store.get(job.guild, 'logMessage', id)) continue;
            const author = message.author;
            const attachments = [...(message.attachments?.values() ?? [])]
              .map((a) => 'Attachment: ' + (a.name ?? a.id) + ' · ' + a.url)
              .join('\n');
            const embeds = (message.embeds ?? [])
              .map((e) =>
                [
                  e.title,
                  e.description,
                  ...(e.fields ?? []).map((field) => field.name + ': ' + field.value),
                ]
                  .filter(Boolean)
                  .join('\n'),
              )
              .join('\n');
            const body =
              message.content ||
              displayText(message) ||
              (message.content === undefined
                ? (app.store.message(id)?.content ?? '[Unavailable before deletion]')
                : '');
            const text =
              'Message ID: ' +
              id +
              ' · Author: ' +
              (author
                ? (author.tag || author.username) +
                  ' · <@' +
                  author.id +
                  '> (ID: ' +
                  author.id +
                  ')'
                : 'unavailable') +
              '\nCreated: ' +
              (message.createdTimestamp
                ? new Date(message.createdTimestamp).toISOString()
                : 'unknown') +
              '\nContent: ' +
              body +
              (attachments ? '\n' + attachments : '') +
              (embeds ? '\nEmbed text:\n' + embeds : '');
            app.store.put(job.guild, 'purgeEvidence', job.id + ':' + id, {
              job: job.id,
              text,
              state: 'pending',
              order: ids.indexOf(id),
              username: author?.username ?? author?.tag ?? 'Unknown author',
              content:
                body + (attachments ? '\n' + attachments : '') + (embeds ? '\n' + embeds : ''),
            } satisfies PurgeEvidence);
          }
        });
      // Persist intent before the API call. Restart recovery treats this batch as uncertain.
      p.inFlight = { keys, end, skipped };
      mark(keys, 'pending');
      save();
      let state: PurgeDeletion['state'] = 'confirmed';
      try {
        if (keys.length >= 2) await channel.bulkDelete(keys, false);
        else await channel.messages.delete(keys[0]!);
        results.deleted += keys.length;
        mark(keys, 'confirmed');
        for (const key of keys) app.store.forgetMessage(key);
      } catch (error) {
        const api = error as { status?: number; code?: number };
        const rejected =
          (api.status !== undefined &&
            api.status >= 400 &&
            api.status < 500 &&
            api.status !== 429) ||
          [50001, 50013, 50034, 50035, 10008].includes(api.code ?? 0);
        state = rejected ? 'failed' : 'uncertain';
        mark(keys, state);
        failed(`Batch starting at ${keys[0]}`, error, keys.length, !rejected);
      }
      results.skipped += skipped;
      index = end;
      delete p.inFlight;
      save();
      return true;
    };
    while (index < ids.length) {
      if (app.store.cancelled(job.id)) {
        outcome = 'cancelled';
        break;
      }
      await authority();
      const recent: { id: string; message: Message }[] = [];
      let end = index,
        skipped = 0;
      while (end < ids.length && end - index < 100) {
        const key = ids[end]!;
        try {
          const message = await channel.messages.fetch({ message: key, force: true });
          if (!message.pinned && message.createdTimestamp < Date.now() - 14 * 86400000 + 5000)
            break;
          if (message.pinned) skipped++;
          else recent.push({ id: key, message });
        } catch (error) {
          if ((error as { code?: number }).code === 10008) skipped++;
          else failed(key, error);
        }
        end++;
      }
      if (end > index) {
        if (!(await perform(recent, end, skipped))) break;
        continue;
      }
      const key = ids[index]!;
      if (app.store.cancelled(job.id)) {
        outcome = 'cancelled';
        break;
      }
      await authority();
      let message: Message;
      try {
        message = await channel.messages.fetch({ message: key, force: true });
      } catch (error) {
        if ((error as { code?: number }).code === 10008) results.skipped++;
        else failed(key, error);
        index++;
        save();
        continue;
      }
      if (message.pinned || !p.older) {
        results.skipped++;
        index++;
        save();
        continue;
      }
      if (!(await perform([{ id: key, message }], index + 1, 0))) break;
    }
  } catch (error) {
    outcome = 'stopped by error';
    failure = errorText(error);
    throw error;
  } finally {
    if (app.store.cancelled(job.id)) outcome = 'cancelled';
    p.outcome = outcome;
    save();
    const cfg = app.store.config(job.guild);
    const label = channelLabel(
      String(p.channel),
      typeof p.channelName === 'string' ? p.channelName : undefined,
    );
    const moderationLog = await app.audit(
      job.guild,
      'moderation',
      `Message purge · ${outcome}`,
      `Job: ${job.id}\nRequested by: <@${job.actor}>\nChannel: ${label}\nReason: ${safeMentions(String(p.reason ?? 'No reason supplied.'))}\nSelected: ${ids.length}; processed: ${index}; remaining: ${Math.max(0, ids.length - index)}.\nDeletion acknowledged: ${results.deleted}; skipped: ${results.skipped}; rejected/failed: ${results.failed}; uncertain: ${results.uncertain}.${failure ? `\nStopped: ${safeMentions(failure)}` : ''}\nUncertain batches are not automatically retried. Use /jobs show id:${job.id} for details.`,
      { force: true },
    );
    const evidence = ids
      .map((id) => app.store.get<PurgeEvidence>(job.guild, 'purgeEvidence', job.id + ':' + id))
      .filter((item): item is PurgeEvidence => !!item)
      .sort((a, b) => a.order - b.order);
    if (
      evidence.length &&
      cfg.modules.logging &&
      !messageLogExcludedChannel(cfg, String(p.channel)) &&
      !(sourceParent && cfg.excludedChannels.includes(sourceParent))
    ) {
      const sections = ['confirmed', 'failed', 'uncertain', 'pending']
        .map((state) => {
          const items = evidence.filter((item) => item.state === state);
          if (!items.length) return '';
          const heading =
            state === 'confirmed'
              ? 'Purged messages'
              : state === 'failed'
                ? 'Deletion failed — not confirmed purged'
                : 'Deletion outcome unknown — not confirmed purged';
          return (
            '**' +
            heading +
            '**\n' +
            items
              .map((item) =>
                item.username !== undefined
                  ? '**' +
                    safe(item.username, 100) +
                    ':** ' +
                    safeMentions(item.content || '[No text]')
                  : safeMentions(item.text),
              )
              .join('\n\n')
          );
        })
        .filter(Boolean)
        .join('\n\n');
      await app.audit(
        job.guild,
        'messages',
        'Message purge · ' + outcome,
        'Job: ' +
          job.id +
          '\nRequested by: <@' +
          job.actor +
          '>\nChannel: ' +
          label +
          '\nModeration log: ' +
          (moderationLog
            ? `[View purge record](${moderationLog})`
            : 'Delivery unavailable; see /jobs show for the retained outcome.') +
          '\nReason: ' +
          safeMentions(String(p.reason ?? 'No reason supplied.')) +
          '\nDeletion acknowledged: ' +
          results.deleted +
          '; skipped: ' +
          results.skipped +
          '; rejected/failed: ' +
          results.failed +
          '; uncertain: ' +
          results.uncertain +
          '.\n\n' +
          sections,
      );
    }
  }
}
