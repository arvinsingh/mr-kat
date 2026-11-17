import type { App } from './types.js';
import type { Ticket } from './modules/tickets.js';
import { maintainBackups } from './backup-health.js';
import { missingChannel } from './discord.js';
import { logError } from './util.js';
import { reconcileVoice } from './modules/voice.js';
import { reconcileOnboarding } from './modules/onboarding.js';
import { reconcileConfessionControls } from './modules/confessions.js';
import { reconcileRoastReviews } from './roast-reviews.js';
import { reconcileTicketCategories } from './ticket-categories.js';
import { reconcileSuggestions } from './modules/suggestions.js';

// Each task has its own failure boundary. A failed lookup never authorizes deletion.
export async function runMaintenance(app: App) {
  const { store, client, guildId } = app;
  const tasks: [string, () => unknown | Promise<unknown>][] = [
    ['backup', () => maintainBackups(app)],
    [
      'retention',
      () => {
        const cfg = store.config(guildId);
        store.prune(guildId, cfg.snapshotDays, cfg.retentionDays);
      },
    ],
    [
      'voice',
      async () => {
        if (store.config(guildId).modules.voice)
          await reconcileVoice(app, await client.guilds.fetch(guildId));
      },
    ],
    ['onboarding', () => reconcileOnboarding(app)],
    ['confession controls', () => reconcileConfessionControls(app)],
    ['roast reviews', () => reconcileRoastReviews(app)],
    ['suggestions', () => reconcileSuggestions(app)],
    [
      'closed tickets',
      async () => {
        const cutoff = Date.now() - store.config(guildId).retentionDays * 86400000;
        const guild = await client.guilds.fetch(guildId);
        for (const item of store.entriesBefore<Ticket>(guildId, 'ticket', cutoff, 100))
          if (item.data.status === 'closed' && item.data.closedAt && item.data.closedAt < cutoff) {
            try {
              const channel = await guild.channels.fetch(item.key).catch(missingChannel);
              if (channel) await channel.delete('Closed ticket retention expired');
              store.delete(guildId, 'ticket', item.key);
            } catch (error) {
              logError('ticket retention', error);
            }
          }
      },
    ],
    [
      'ticket categories',
      async () => reconcileTicketCategories(app, await client.guilds.fetch(guildId)),
    ],
    [
      'log retention',
      async () => {
        const cutoff = Date.now() - store.config(guildId).retentionDays * 86400000;
        for (const item of store.entriesBefore<{ channel: string }>(
          guildId,
          'logMessage',
          cutoff,
          100,
        )) {
          try {
            const channel = await client.channels.fetch(item.data.channel).catch(missingChannel);
            if (channel?.isTextBased()) {
              try {
                const message = await channel.messages.fetch(item.key);
                if (message.author.id === client.user!.id) await message.delete();
              } catch (error) {
                if ((error as { code?: number }).code !== 10008) throw error;
              }
            }
            store.delete(guildId, 'logMessage', item.key);
          } catch (error) {
            logError('log retention item', error);
          }
        }
      },
    ],
  ];
  for (const [name, work] of tasks) {
    try {
      await work();
    } catch (error) {
      logError(`${name} maintenance`, error);
    }
  }
}
