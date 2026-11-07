import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { owner } from '../permissions.js';
import { assert, safe } from '../util.js';
import { readOnlyResponse, reply } from '../ui.js';
import {
  createVerifiedBackup,
  verifyLocalBackup,
  listBackups,
  recoveryGuide,
  type BackupState,
} from '../backup-health.js';

export async function backupPanel(app: App, i: Interaction, notice = '') {
  owner(i);
  readOnlyResponse(i);
  const state = app.store.get<BackupState>(i.guildId!, 'system', 'backupHealth');
  const files = await listBackups(app.backupDir);
  const at = (time?: number) => (time ? `<t:${Math.floor(time / 1000)}:R>` : 'not recorded');
  const content = `**Backup health & recovery**\n${notice ? `${notice}\n\n` : ''}Last verified creation: ${at(state?.lastSuccess)}\nLast verification: ${at(state?.lastVerified)}\n${state?.lastVerification?.ok === false ? `⚠️ Verification failed for ${safe(state.lastVerification.file)}: ${safe(state.lastVerification.error ?? 'Unknown error', 120)}\n` : ''}Latest created file: ${state?.lastFile ? safe(state.lastFile) : 'none recorded'}\nLast attempt: ${at(state?.lastAttempt)}\n${state?.lastError ? `⚠️ Last failure: ${safe(state.lastError, 180)}\n` : ''}${!state?.lastSuccess || state.lastSuccess < Date.now() - 36 * 3600000 ? '⚠️ No verified backup in the last 36 hours.\n' : '✅ A verified backup was recently created.\n'}\nDaily automatic copies are retained for seven days. Manual copies stay until the host operator removes them. All listed files are on this same host; off-host copying is an operator action. Backups are never uploaded to Discord by this panel.\n\n${
    files.length
      ? files
          .slice(0, 3)
          .map(
            (item) =>
              `• ${safe(item.file)} · ${(item.bytes / 1024).toFixed(1)} KB · ${at(item.modified)}`,
          )
          .join('\n')
      : 'No local backups found.'
  }\n\nChoose a file to verify its SQLite integrity, schema, server ID and optional checksum manifest. Recovery is performed offline after stopping the bot.`;
  const components: (
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`backup:${i.user.id}:create`)
        .setLabel('Create verified backup')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`backup:${i.user.id}:refresh`)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`backup:${i.user.id}:recovery`)
        .setLabel('Recovery guide')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (files.length)
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`backup:${i.user.id}:verify`)
          .setPlaceholder('Verify a local backup')
          .addOptions(
            files.map((item) => ({
              label: item.file.slice(0, 100),
              value: item.file,
              description: `${(item.bytes / 1024).toFixed(1)} KB · ${new Date(item.modified).toISOString().slice(0, 16)}`,
            })),
          ),
      ),
    );
  await reply(i, { content, components });
}
export const backups: Module = {
  commands: {
    backup: async (app, i) => {
      owner(i);
      const action = i.options.getString('action') ?? 'panel';
      if (action === 'create') {
        const checked = await createVerifiedBackup(app);
        await app.audit(
          i.guildId,
          'admin',
          'Verified backup created',
          `Requested by <@${i.user.id}>. File: ${checked.file}. Integrity/schema/server/checksum checks passed.`,
          { force: true },
        );
        await backupPanel(app, i, `✅ Created and verified ${safe(checked.file)}.`);
      } else if (action === 'verify') {
        const files = await listBackups(app.backupDir);
        const file = i.options.getString('file') ?? files[0]?.file;
        assert(file, 'No backup exists yet. Choose Create verified backup first.');
        const check = await verifyLocalBackup(app, file);
        await backupPanel(
          app,
          i,
          `✅ ${safe(check.file)} passes integrity/schema/server checks. ${check.manifest ? 'Checksum matches its manifest.' : 'Legacy file: no manifest to compare.'}\nPending jobs in this snapshot: ${check.pendingJobs}.`,
        );
      } else if (action === 'recovery')
        await reply(i, {
          content:
            'Offline recovery instructions. The file contains instructions only, not database data.',
          files: [new AttachmentBuilder(Buffer.from(recoveryGuide()), { name: 'RECOVERY.md' })],
        });
      else {
        assert(action === 'panel', 'Choose panel, create, verify or recovery.');
        await backupPanel(app, i);
      }
    },
  },
  component: async (app, i) => {
    if (!(i.isButton() || i.isStringSelectMenu()) || !i.customId.startsWith('backup:'))
      return false;
    const [, actor, action] = i.customId.split(':');
    assert(actor === i.user.id, 'This backup panel belongs to another member.');
    owner(i);
    if (action === 'create') {
      const checked = await createVerifiedBackup(app);
      await app.audit(
        i.guildId,
        'admin',
        'Verified backup created',
        `Requested by <@${i.user.id}>. File: ${checked.file}. Verification passed.`,
        { force: true },
      );
      await backupPanel(app, i, `✅ Created and verified ${safe(checked.file)}.`);
    } else if (action === 'verify' && i.isStringSelectMenu()) {
      assert(i.values.length === 1, 'Choose one backup.');
      const check = await verifyLocalBackup(app, i.values[0]!);
      await backupPanel(
        app,
        i,
        `✅ ${safe(check.file)} verified. ${check.manifest ? 'Checksum manifest matches.' : 'No checksum manifest (legacy backup).'} Schema ${check.schema}; ${check.pendingJobs} pending jobs. SHA-256: ${check.sha256}`,
      );
    } else if (action === 'recovery')
      await reply(i, {
        content:
          recoveryGuide().split('\n').slice(0, 3).join('\n') +
          '\nDownload the complete instructions below. No live restore is performed.',
        components: [],
        files: [new AttachmentBuilder(Buffer.from(recoveryGuide()), { name: 'RECOVERY.md' })],
      });
    else {
      assert(action === 'refresh', 'Unknown backup control.');
      await backupPanel(app, i);
    }
    return true;
  },
};
