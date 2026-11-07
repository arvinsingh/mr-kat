# Privacy policy

Last updated: 7 November 2026

Mr. Kat is self-hosted software, not a centrally operated bot service. Each installation's operator controls its application, host, database, backups, settings, and access. Contact your server's administrators for the operator's privacy arrangements and data requests. Publishing this repository does not give its maintainer access to your installation.

## Data processed

The bot receives Discord events and interactions for its configured server. Depending on enabled features, it processes or stores:

- User, server, channel, role, and message IDs; display names and avatars used in messages.
- Moderation cases, reasons, reports, appeals, staff actions, configuration, and scheduled jobs.
- Ticket metadata and transcripts; confession text, reply relationships, notification preferences, and internally linked participant IDs.
- Role assignments, onboarding progress, managed voice rooms, activity counters, polls, suggestions, and starboard records.
- Message text and attachment references needed for logging, purge records, announcements, tags, text effects, and UwU replacements/editing.

Message Content access lets the bot process readable server messages for enabled features. It does not publish every message to a log. Optional persistent message snapshots default off (`snapshotDays: 0`); enabling them retains content for edit/deletion logs. Configured log messages, ticket transcripts, confessions, and transformed posts may disclose content to people who can access their destination.

## Confessions and DMs

Internal confession linking retains user IDs for OP labels, anonymous reply aliases, and reply DMs. No in-bot identity lookup is provided to members, moderators, or the server owner. **This is not anonymity from the host/database operator, backups, or Discord.** It is not end-to-end encryption. Read the notice shown in the submission form and avoid identifying details.

Automatic or staff-requested DMs may include welcome instructions, moderation notices, reminders, or confession replies. A successful send does not establish that someone read it. Reply notifications can be muted with the confession controls. Replies to the bot's DMs are not a monitored support inbox.

## Storage, recipients, and retention

Application data is stored in local SQLite and backup files, without application-level database encryption. Discord stores messages and processes interactions under its own policies. Attachment forwarding may fetch media from Discord-provided URLs and upload it to Discord. The shipped application has no advertising, analytics, AI-provider integration, or automatic off-host backup upload. Host providers and any services an operator adds have their own access and policies.

Selected historical records follow `retentionDays` (90 days by default, configurable from 7–365); snapshot retention is separate and configurable up to 30 days. Cleanup runs during maintenance, not as an immediate deletion guarantee. Settings, active jobs, and other operational records can persist until cleared. Automatic local backups are kept for seven days; manual and operator-created off-host copies need separate cleanup. Backups can contain records already removed from the active database. Messages and files on Discord have separate lifecycles; local deletion does not guarantee removal of every Discord copy.

## Operator responsibilities and requests

Operators must explain which features are enabled, restrict logs/tickets/database access, protect tokens, select suitable retention, and provide a private contact route. Users should contact their installation's operator for access, correction, deletion, or complaints. The software does not offer a universal user-data erasure command; requests may require coordinated database, backup, and Discord cleanup by the operator. Stopping the bot does not erase its stored data.
