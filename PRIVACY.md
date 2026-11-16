# Privacy policy

Last updated: 15 November 2026

Mr. Kat is self-hosted software, not a centrally operated bot service. Each installation's operator controls its application, host, database, backups, settings, and access. Contact your server's administrators for the operator's privacy arrangements and data requests. Publishing this repository does not give its maintainer access to your installation.

## Data processed

The bot receives Discord events and interactions for its configured server. Depending on enabled features, it processes or stores:

- User, server, channel, role, and message IDs; display names and avatars used in messages.
- Moderation cases, warning expiry/revocation/escalation records, reasons, reports, appeals, staff actions, configuration, and scheduled jobs.
- Message evidence: captured text, author/message/channel IDs, timestamps, and attachment references. Evidence capture does not download attachments or require screenshot uploads.
- Ticket metadata and transcripts; confession text, reply relationships, notification preferences, and internally linked participant IDs.
- Role assignments, onboarding progress, managed voice rooms, activity counters, polls, suggestions, and starboard records.
- Message text and attachment references needed for logging, purge records, announcements, tags, text effects, and UwU replacements/editing.
- Staff DM conversation mappings, message delivery receipts, and private-notification routing markers; suggestion authors, status updates, and discussion-thread references.
- Roast participation preferences, public custom-roast submissions and author references, review decisions, delivery receipts, and recent channel choices used to reduce repeats.

Message Content access lets the bot process readable server messages for enabled features. It does not publish every message to a log. Optional persistent message snapshots default off (`snapshotDays: 0`); enabling them retains content for edit/deletion logs. Configured log messages, ticket transcripts, confessions, and transformed posts may disclose content to people who can access their destination.

Purge operations capture available content before deletion and display usernames/text in paginated Discord log messages, linked to a moderation record when delivery succeeds. Protected-role mention redirects can retain repeat-mention incident details; the redirect itself leaves the original message intact. Members can inspect their own retained warnings; authorized staff can inspect others and revoke warnings. Revocation preserves the original case. Public moderation notices and recipient DMs omit staff attribution, but private records, host access, and Discord's audit log can identify staff.

## Confessions and DMs

Internal confession linking retains user IDs for OP labels, anonymous reply aliases, and reply DMs. No in-bot identity lookup is provided to members, moderators, or the server owner. **This is not anonymity from the host/database operator, backups, or Discord.** It is not end-to-end encryption. Read the notice shown in the submission form and avoid identifying details.

Automatic or staff-requested DMs may include welcome instructions, moderation/revocation notices, ticket closure summaries and transcripts, suggestion updates, reminders, or confession replies. Ticket closure removes the creator's channel access; the bot attempts to send the original request and a limited transcript to that member. Attachment references may expire. A successful send does not establish that someone read it. Confession reply notifications can be muted with the confession controls.

When the operator configures the separate private DM inbox, ordinary outgoing DM text and delivery results are copied into a staff-only Discord thread for that user. Incoming member DMs and attachment links are forwarded to the same thread. Outgoing notices disclose that replies are shared with staff. Successful forwarding is silent. Staff use an explicit Reply button or command to send as the bot; other messages in staff threads remain internal. Existing conversations can continue after someone leaves the server. Only authorized staff should have access to the inbox.

Confession notifications and personal reminders are excluded from the staff relay. Replies referencing those private notifications are not forwarded. The bot retains private-notification message markers to distinguish these references. An ordinary DM sent without a private-notification reference can reach staff; use the confession's own Reply controls for an anonymous response. Suggestion discussions are public to people with channel access and retain the original author's name after resolution.

Roast participation preferences are private bot settings. Custom roast proposals, their authors, and approval/rejection status are public in the configured submission channel; submitted text is not anonymous. Approved text can be reused in roast messages. Review-result DMs do not identify the reviewing staff member. Opt-outs, pending submissions, and approved/disabled lines persist until cleared; rejected submissions and request receipts follow the configured retention period. Recent channel choices and setup panels are temporary. These records are included in database backups.

## Storage, recipients, and retention

Application data is stored in local SQLite and backup files, without application-level database encryption. Discord stores messages and processes interactions under its own policies. Attachment forwarding may fetch media from Discord-provided URLs and upload it to Discord. The shipped application has no advertising, analytics, AI-provider integration, or automatic off-host backup upload. Host providers and any services an operator adds have their own access and policies.

Selected historical records follow `retentionDays` (90 days by default, configurable from 7–365); snapshot retention is separate and configurable up to 30 days. Cleanup runs during maintenance, not as an immediate deletion guarantee. Settings, active jobs, DM conversation mappings, private-notification markers, and other operational records can persist until cleared. DM conversation bodies remain in Discord staff threads and require operator-managed retention/deletion there. Automatic local backups are kept for seven days; manual and operator-created off-host copies need separate cleanup. Backups can contain records already removed from the active database. Messages and files on Discord have separate lifecycles; local deletion does not guarantee removal of every Discord copy.

## Operator responsibilities and requests

Operators must explain which features are enabled, restrict logs/tickets/database access, protect tokens, select suitable retention, and provide a private contact route. Users should contact their installation's operator for access, correction, deletion, or complaints. The software does not offer a universal user-data erasure command; requests may require coordinated database, backup, and Discord cleanup by the operator. Stopping the bot does not erase its stored data.
