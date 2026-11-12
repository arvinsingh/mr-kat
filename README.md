# Mr. Kat

A self-hosted Discord bot for moderation, server management, and community features.
One Node.js process, a local SQLite database, and no required paid APIs or dashboard.
Run your own Discord application for one configured server per instance.

## Features

- **Moderation:** guided warning panels, warning revocation and configurable escalation, message evidence, appeals, reports, timeouts, kicks, bans, batch operations, lockdown, and panic mode.
- **Logs and protection:** paginated purge records, message edits/deletions, avatar/role/channel/voice changes, protected-role mention redirects, spam controls, and native Discord AutoMod setup.
- **Roles and onboarding:** self-service role menus, temporary and automatic roles, optional welcome DMs, exit messages, and verification.
- **Voice and support:** join-to-create voice rooms with ownership controls; integrated ticket panels, staff-only reopen/delete controls, and closure-summary/transcript DMs.
- **Community:** anonymous confessions with threaded replies and DM notifications, starboard, polls, suggestions, reminders, announcements, plain channel messages, and saved tags.
- **Fun:** text effects, reply shortcuts, mention responses, a customizable Easter egg, and temporary server-wide or channel-specific UwU locks.
- **Operations:** interactive setup, permission/health checks, heartbeat posts, persistent jobs, verified backups, and offline recovery tools.

Features require their relevant Discord permissions and configuration. Confessions and other destination-based features need setup before use. Read [the command guide](docs/COMMANDS.md), or use `/help` and `/man` inside Discord.

## Run it

Requires Node.js 24.13+ within 24.x, npm, and persistent writable storage.

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications). Enable **Server Members Intent** and **Message Content Intent**. Invite it with the `bot` and `applications.commands` scopes and permissions for the features you use; keep its role above roles/members it must manage.
2. Copy `.env.temp` to `.env`. Set `DISCORD_TOKEN` (bot token), `DISCORD_CLIENT_ID` (application ID), and `DISCORD_GUILD_ID` (server ID). Discord's Developer Mode exposes **Copy Server ID**.
3. From the repository directory, run:

```sh
npm ci
npm run build
npm run commands
npm start
```

4. As the server owner, run `/setup`, then `/diagnose`. Configure staff roles, log destinations, and the features you want. Use `/help audience:owners` for setup guidance.

Use any host that supports this Node.js version, a continuously running process, outbound Discord connections, and persistent disk. Keep the working directory at the project root and run only one instance per token/database. A host that asks for an entry file can run `node index.js`. See [operations and recovery](docs/OPERATIONS.md) for updates and backups.

## Development

```sh
npm run check
npm run format:check
npm run build
```

`npm run docs` regenerates the manual and Discord-ready guides from the in-bot help. CI checks types, formatting, and builds; it does not deploy. Check live permissions in a dedicated server before enabling moderation actions.

## Extending the bot

Missing a feature? Fork the project and adapt it to your server. Feature handlers live in [src/modules](src/modules), with command definitions in [src/commands.ts](src/commands.ts) and routing in [src/router.ts](src/router.ts). New features should reuse the existing permission checks, store settings in configuration, and define response visibility in [src/response-policy.ts](src/response-policy.ts).

Update the in-bot help in [src/manual.ts](src/manual.ts), run `npm run docs`, then check and rebuild. Register changed commands with `npm run commands` and restart the bot. Contributions and feature suggestions are welcome through GitHub issues and pull requests.

## Privacy, security, and credits

Read [the privacy policy](PRIVACY.md) and [security guidance](SECURITY.md) before operating the bot. Confessions hide identities through the bot interface; host/database access can expose retained links and backups.

Built with OpenAI Codex. Review and testing are encouraged.

Released under the [MIT license](LICENSE)
