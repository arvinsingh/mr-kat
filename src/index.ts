import { Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { setDefaultResultOrder } from 'node:dns';
import { Store } from './store.js';
import { environment } from './config.js';
import type { App } from './types.js';
import { events } from './events.js';
import { route } from './router.js';
import { Scheduler, runJob } from './jobs.js';
import { AuditLogger } from './logging.js';
import { flushMemberLogs } from './member-logs.js';
import { flushModerationEvents } from './moderation-events.js';
import { logError } from './util.js';
import { reconcileVoice } from './modules/voice.js';
import { databaseLock } from './database-lock.js';
import { stopUwuReplacements } from './uwulock.js';
import { stopUwuAuthorActions } from './modules/uwulock.js';
import { runMaintenance } from './maintenance.js';

// Also cover npm start/dev, which bypass the hosting bootstrap.
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
      GatewayIntentBits.DirectMessages,
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
  const app: App = {
    client,
    store,
    guildId: env.DISCORD_GUILD_ID,
    backupDir: env.BACKUP_DIR,
    audit: async () => undefined,
    runJob: (job) => runJob(app, job),
  };
  const logger = new AuditLogger(app);
  app.audit = logger.audit;
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
      await runMaintenance(app);
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
    await flushMemberLogs(app);
    await flushModerationEvents(app);
    while (maintenanceActive) await new Promise((resolve) => setTimeout(resolve, 50));
    await logger.close();
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
