import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { environment } from './config.js';
import { logError } from './util.js';
try {
  const env = environment();
  await new REST({ version: '10' })
    .setToken(env.DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
      body: commands,
    });
  console.info(`Registered ${commands.length} commands in the configured server.`);
} catch (error) {
  logError('register commands', error);
  process.exitCode = 1;
}
