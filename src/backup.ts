import { BackupSource } from './backup-source.js';
import { logError } from './util.js';
import { existsSync } from 'node:fs';
import { createVerifiedBackup } from './backup-health.js';
import { id } from './config.js';
const source = process.env.DATABASE_PATH ?? './data/bot.sqlite';
if (!existsSync(source))
  throw new Error(
    'Database does not exist yet. Start and configure the bot before making a backup.',
  );
const guildId = id.parse(process.env.DISCORD_GUILD_ID);
const store = new BackupSource(source, guildId);
try {
  const result = await createVerifiedBackup({
    store,
    guildId,
    backupDir: process.env.BACKUP_DIR ?? './backups',
  });
  console.info(`Verified backup created: ${result.file}; SHA-256 ${result.sha256}`);
} catch (error) {
  logError('backup', error);
  process.exitCode = 1;
} finally {
  store.close();
}
