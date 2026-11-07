import { restoreBackup } from './backup-health.js';
import { assert, errorText } from './util.js';
try {
  const args = process.argv.slice(2);
  const allowed = new Set(['--source', '--target', '--apply', '--stopped', '--allow-pending-jobs']);
  for (let n = 0; n < args.length; n++) {
    assert(
      allowed.has(args[n]!),
      'Unknown recovery argument. Use --source FILE --target FILE [--apply --stopped].',
    );
    if (['--source', '--target'].includes(args[n]!)) n++;
  }
  const value = (name: string) => args[args.indexOf(name) + 1];
  assert(
    args.includes('--source') && value('--source') && !value('--source')!.startsWith('--'),
    'Supply --source BACKUP_FILE.',
  );
  const target = args.includes('--target') ? value('--target') : process.env.DATABASE_PATH;
  assert(target && !target.startsWith('--'), 'Supply --target DATABASE_FILE or DATABASE_PATH.');
  const result = await restoreBackup(
    value('--source')!,
    target,
    process.env.DISCORD_GUILD_ID,
    args.includes('--apply'),
    args.includes('--stopped'),
    args.includes('--allow-pending-jobs'),
  );
  console.info(JSON.stringify(result, null, 2));
  if (!result.applied)
    console.info('Verification only. Stop the bot and add --apply --stopped to perform this plan.');
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
