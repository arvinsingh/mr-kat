# Hosting, updates, and recovery

Use any host with Node.js 24.13+ within 24.x, persistent writable disk, and outbound HTTPS/WebSocket access to Discord. The bot needs a continuously running process; there is no public web endpoint or required inbound port. Serverless functions that sleep between requests are unsuitable for its gateway connection and scheduled jobs.

## Run

Keep the working directory at the repository root. Configure `.env` from the example or set equivalent environment variables privately. Install and build with `npm ci` and `npm run build`, register commands with `npm run commands`, then start with `npm start`. A panel that requires an entry file can use `node index.js`; this also resolves relative paths from the project root.

Use your host's restart policy or process manager. Run one instance per token/database, under an unprivileged account. Persist `DATABASE_PATH` and `BACKUP_DIR` across releases/restarts; default locations are `data/bot.sqlite` and `backups/`. Do not run an unbuilt source tree with production-only dependencies. After building, `npm prune --omit=dev --ignore-scripts` can remove development tools from a production installation.

Owner setup starts with `/setup`, `/diagnose`, and `/help audience:owners`. Permission checks cover the actor, the bot, role hierarchy, and destination overrides; granting the bot a permission does not grant it to members.

## Update

1. Create a consistent backup and copy it off-host.
2. Stop the bot gracefully and confirm its process has exited.
3. Update code without replacing `.env`, the database, or backups.
4. Run `npm ci`, `npm run check`, `npm run format:check`, and `npm run build`.
5. Run `npm run commands` when command definitions change, then restart one instance.
6. Confirm `Bot connected` in host logs and inspect `/diagnose` and `/jobs list`.

Register commands after adding or updating features. Publish `/ticket panel` for the integrated support card, and use `/warnings panel` for the private warning dashboard. Warning escalation stays off unless configured; existing threshold settings retain timeout behavior. Review `/warnings status` and the owner policy controls before enabling automatic kicks. `/mentionguard setup` defaults to server-wide monitoring; optional `channel` limits scope, and `support_channel` selects the redirect destination.

Current cards and forms use Discord Components V2. Republish older panels/announcements when you want the new layout. Announcements support `---` on its own line for a divider. New voice rooms get right-side controls in their built-in chat; the optional public creation notice is brief. Existing rooms can use `/voice panel`.

As owner, configure `staffRoles`, then run `/logs setup` to create a private Bot Logs category and missing log channels. Rerunning reuses private destinations under the selected category. This selects the new destinations without deleting old channels. `/logs status` lists them. The separate DM inbox uses one staff thread per user; staff reply with its Reply button or `/dm reply`. Keep ordinary roles out of that channel, and review the [DM privacy details](../PRIVACY.md#confessions-and-dms). The existing `/setup logs:` shortcut changes event logs only, preserving the separate inbox.

Run `/suggest setup channel:#suggestions` to select the board. Suggestion titles show their status, Comment opens the discussion, and staff can use Review or Reply as bot. Status changes attempt author DMs. `/say` defaults to the current channel/thread when channel is omitted. Stickies wait for two quiet minutes after the latest message, including bot posts; pending deadlines survive a restart.

CI validates code only. Configure deployment for your chosen host separately. Keeping previous code does not make database rollback automatic; review compatibility before switching versions.

## Back up

Use `/backup` for a private interactive health panel, or `npm run backup` from the project root. Both create a consistent SQLite backup with a SHA-256 manifest and integrity/schema/server checks. The panel sends recovery instructions, never database contents.

Daily automatic local copies are retained for seven days. Manual copies need operator-managed cleanup. Copy the database backup and its matching manifest to protected off-host storage; a same-disk backup does not protect against losing the host. Do not copy only the live SQLite database while it is being written; committed data may be in its WAL file.

## Recover

Stop the bot first. With the correct `DISCORD_GUILD_ID` configured, inspect a backup without changing the database:

```sh
npm run recover -- --source backups/YOUR_BACKUP.sqlite --target data/bot.sqlite
```

Review the server, checksum, schema, integrity, and pending job information. To apply the reviewed plan, append `--apply --stopped`. If historical pending jobs exist, the tool also requires `--allow-pending-jobs`; review whether those scheduled actions should run before acknowledging them. Adjust paths for custom storage locations.

Recovery takes the database lock, validates a staging copy, and preserves previous database/WAL/SHM files in a sibling `recovery-before-*` directory. It does not restore Discord's message/channel history or change `.env`. The Discord panel cannot apply a restore.

After recovery, start one instance and reconcile `/diagnose`, `/backup`, `/jobs list`, role timers, and managed voice rooms against current Discord state. Backups without manifests can pass database checks but cannot be compared against a recorded checksum.

## Troubleshoot

- **Database in use:** stop duplicate bot/recovery processes. The `.bot-lock` sidecar guards against multiple writers, including container restarts and PID reuse. Do not delete the database, WAL, or SHM files to bypass a lock.
- **Commands missing:** build, register commands for the configured server, and check Server Settings → Integrations for command restrictions.
- **Permission failures:** inspect native member/bot permissions, channel overrides, privileged intents, role positions, configured staff roles, and enabled modules.
- **DM failures:** users can block server DMs; public operation success does not guarantee DM delivery.
- **Discord connectivity:** startup and command registration prefer IPv4 when both address families are available. This does not fix a failing host/container DNS resolver or blocked outbound traffic.
- **Scheduled work:** failed or uncertain sends are retained for review rather than blindly resent. Inspect the destination before rescheduling.

Database files, backups, transcripts, host logs, and recovery copies are private operator data. See [the privacy policy](../PRIVACY.md) and [security guidance](../SECURITY.md).
