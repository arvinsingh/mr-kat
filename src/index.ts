import { Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { setDefaultResultOrder } from 'node:dns';
import { Store } from './store.js';
import { environment, type LogKind } from './config.js';
import type { App } from './types.js';
import { events } from './events.js';
import { route } from './router.js';
import { Scheduler, runJob } from './jobs.js';
import { send, missingChannel } from './discord.js';
import { auditPages } from './ui.js';
import { logError } from './util.js';
import { reconcileVoice } from './modules/voice.js';
import type { Ticket } from './modules/tickets.js';
import { reconcileOnboarding } from './modules/onboarding.js';
import { reconcileConfessionControls } from './modules/confessions.js';
import { databaseLock } from './database-lock.js';
import { maintainBackups } from './backup-health.js';
import { stopUwuReplacements } from './uwulock.js';
import { stopUwuAuthorActions } from './modules/uwulock.js';

// Prefer IPv4 when both address families are available.
setDefaultResultOrder('ipv4first');

async function main() {
  const env = environment();
  const releaseDatabase = await databaseLock(env.DATABASE_PATH);
  let store: Store;
  try {
    store = new Store(env.DATABASE_PATH);
  } catch (error) {
    await releaseDatabase();
    throw error;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.AutoModerationExecution,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.GuildMember,
      Partials.Reaction,
      Partials.User,
    ],
    makeCache: Options.cacheWithLimits({ MessageManager: 100 }),
    allowedMentions: { parse: [], repliedUser: false },
  });
  let auditPending = 0;
  const app: App = {
    client,
    store,
    guildId: env.DISCORD_GUILD_ID,
    backupDir: env.BACKUP_DIR,
    audit: async (guild, kind, title, description, options) => {
      const cfg = store.config(guild);
      if (!cfg.modules.logging && !options?.force) return;
      const channel = cfg.logs[kind];
      if (!channel) return;
      if (auditPending >= 100 && !options?.force) {
        console.warn('Log queue full; dropping an event log. Moderation cases remain in SQLite.');
        return;
      }
      auditPending++;
      try {
        let firstMessage: string | undefined;
        const pages = auditPages(kind, title, description);
        for (const [index, page] of pages.entries()) {
          if (index === 0 && options?.image) page.setImage(options.image);
          const message = await send(app, guild, channel, {
            embeds: [page],
            ...(index === 0 && options?.files?.length ? { files: options.files } : {}),
          });
          store.put(guild, 'logMessage', message.id, { channel, created: Date.now(), kind });
          firstMessage ??= `https://discord.com/channels/${guild}/${channel}/${message.id}`;
        }
        return firstMessage;
      } catch (error) {
        logError(`log destination ${kind}`, error);
      } finally {
        auditPending--;
      }
    },
    runJob: (job) => runJob(app, job),
  };
  const scheduler = new Scheduler(app);
  events(app);
  client.on(Events.InteractionCreate, (i) => {
    void route(app, i).catch((error) => logError('router boundary', error));
  });
  client.on(Events.Error, (error) => logError('Discord client', error));
  let housekeeping: ReturnType<typeof setInterval> | undefined;
  let maintenanceActive = false;
  let shuttingDown = false;
  async function maintenance() {
    if (maintenanceActive) return;
    maintenanceActive = true;
    try {
      // Backups must not depend on unrelated Discord cleanup/reconciliation succeeding.
      await maintainBackups(app).catch((error) => logError('backup maintenance', error));
      const cfg = store.config(app.guildId);
      store.prune(app.guildId, cfg.snapshotDays, cfg.retentionDays);
      const guild = await client.guilds.fetch(app.guildId);
      if (cfg.modules.voice) await reconcileVoice(app, guild);
      await reconcileOnboarding(app);
      await reconcileConfessionControls(app);
      const cutoff = Date.now() - cfg.retentionDays * 86400000;
      for (const item of store.entriesBefore<Ticket>(app.guildId, 'ticket', cutoff, 100))
        if (item.data.status === 'closed' && item.data.closedAt && item.data.closedAt < cutoff) {
          const channel = await guild.channels.fetch(item.key);
          if (channel) await channel.delete('Closed ticket retention expired');
          store.delete(app.guildId, 'ticket', item.key);
        }
      for (const item of store.entriesBefore<{ channel: string; created: number; kind: LogKind }>(
        app.guildId,
        'logMessage',
        cutoff,
        100,
      )) {
        const channel = await client.channels.fetch(item.data.channel).catch(missingChannel);
        if (channel?.isTextBased()) {
          try {
            const message = await channel.messages.fetch(item.key);
            if (message.author.id === client.user!.id) await message.delete();
          } catch (error) {
            if ((error as { code?: number }).code !== 10008) throw error;
          }
        }
        store.delete(app.guildId, 'logMessage', item.key);
      }
    } catch (error) {
      logError('maintenance', error);
    } finally {
      maintenanceActive = false;
    }
  }
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (housekeeping) clearInterval(housekeeping);
    await scheduler.stop();
    await Promise.all([stopUwuReplacements(app), stopUwuAuthorActions(app)]);
    while (maintenanceActive || auditPending)
      await new Promise((resolve) => setTimeout(resolve, 50));
    client.destroy();
    store.close();
    await releaseDatabase();
  }
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  client.once(Events.ClientReady, (ready) => {
    void (async () => {
      const guild = await ready.guilds.fetch(app.guildId);
      console.info(
        JSON.stringify({
          level: 'info',
          message: 'Bot connected',
          bot: ready.user.id,
          guild: guild.id,
        }),
      );
      // Clear stale voice timing observations after an outage; offline time is not counted as connected time.
      for (const item of store.entries(app.guildId, 'voiceActivity'))
        store.delete(app.guildId, 'voiceActivity', item.key);
      await reconcileVoice(app, guild);
      scheduler.start();
      await maintenance();
      housekeeping = setInterval(() => void maintenance(), 3600000);
      housekeeping.unref();
    })().catch((error) => {
      logError('startup', error);
      void shutdown();
      process.exitCode = 1;
    });
  });
  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (error) {
    await shutdown();
    throw error;
  }
}
main().catch((error) => {
  logError('startup', error);
  process.exitCode = 1;
});
