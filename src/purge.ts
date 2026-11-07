import { PermissionFlagsBits as P, type GuildTextBasedChannel, type Message } from 'discord.js';
import type { App } from './types.js';
import type { Job } from './store.js';
import { assert, errorText, safe, safeMentions } from './util.js';
import { textChannel } from './discord.js';
import { botPermission } from './permissions.js';
import { messageLogExcludedChannel } from './message-logs.js';

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
  const save = () => {
    p.index = index;
    p.results = results;
    app.store.updateJob(job.id, p);
  };
  const mark = (keys: string[], state: PurgeDeletion['state']) => {
    for (const id of keys)
      app.store.put(job.guild, 'purgeDeletion', id, {
        job: job.id,
        actor: job.actor,
        channel: String(p.channel),
        state,
        expires: Date.now() + 86400000,
      } satisfies PurgeDeletion);
  };
  const failed = (key: string, error: unknown, count = 1, uncertain = false) => {
    if (uncertain) results.uncertain += count;
    else results.failed += count;
    if (results.errors.length < 10) results.errors.push(`${key}: ${errorText(error)}`);
  };
  try {
    assert(app.store.config(job.guild).modules.messages, 'The messages module is disabled.');
    const channel = await textChannel(app, job.guild, String(p.channel));
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
      const cfg = app.store.config(job.guild);
      if (
        cfg.modules.logging &&
        !messageLogExcludedChannel(cfg, String(p.channel)) &&
        !(channel.parentId && cfg.excludedChannels.includes(channel.parentId))
      ) {
        const eligible = messages.filter(({ id }) => !app.store.get(job.guild, 'logMessage', id));
        if (eligible.length) {
          const details = eligible
            .map(({ id, message }) => {
              const author = message.author;
              const attachments = message.attachments
                ? [...message.attachments.values()]
                    .map(
                      (file) =>
                        `Attachment: ${safeMentions(file.name ?? file.id)}${file.url ? ` · ${file.url}` : ''}`,
                    )
                    .join('\n')
                : '';
              return `Message ID: ${id} · Author: ${author ? `${safe(author.tag || author.username, 100)} · <@${author.id}> (ID: ${author.id})${author.bot ? ' · bot' : ''}` : 'unavailable'}\nContent: ${safeMentions(message.content ?? '[Unavailable]') || '[No text]'}${attachments ? '\n' + attachments : ''}`;
            })
            .join('\n\n');
          await app.audit(
            job.guild,
            'messages',
            `Purge batch · ${state === 'confirmed' ? 'messages deleted' : state === 'uncertain' ? 'outcome uncertain' : 'request rejected'}`,
            `Job: ${job.id}\nRequested by: <@${job.actor}>\nChannel: <#${p.channel}>\nTime: <t:${Math.floor(Date.now() / 1000)}:F>\nReason: ${safeMentions(String(p.reason ?? 'No reason supplied.'))}\n${keys.length} deletion request(s): ${state}. ${state === 'confirmed' ? 'Discord acknowledged deletion.' : 'The text below was captured before the request; it is not proof of deletion.'}\n\n${details}`,
          );
        }
      }
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
    await app.audit(
      job.guild,
      'moderation',
      `Purge ${outcome}`,
      `Job: ${job.id}\nRequested by: <@${job.actor}>\nChannel: <#${p.channel}>\nReason: ${safeMentions(String(p.reason ?? 'No reason supplied.'))}\nSelected: ${ids.length}; processed: ${index}; remaining: ${Math.max(0, ids.length - index)}.\nDeletion acknowledged: ${results.deleted}; skipped: ${results.skipped}; rejected/failed: ${results.failed}; uncertain: ${results.uncertain}.${failure ? `\nStopped: ${safeMentions(failure)}` : ''}\nUncertain batches are not automatically retried. Use /jobs show id:${job.id} for details.`,
      { force: true },
    );
  }
}
