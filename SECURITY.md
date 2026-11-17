# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting if available. If private reporting is unavailable, open an issue requesting a private contact route without publishing the exploit, tokens, user identities, transcripts, or database contents. Reports are handled on a best-effort basis; there is no response-time guarantee. Use the current main branch and review dependencies regularly.

## Operating the bot

- Use a Discord **bot token**, never a personal account token. Keep `.env`, databases, transcripts, backups, and host credentials out of Git. Reset an exposed token in the Developer Portal.
- Grant only the permissions your enabled features need. Respect role hierarchy and test staff restrictions with a normal member account. Administrator access is broad and not required for every feature.
- Warning escalation is opt-in. Review the threshold/action before confirming an owner policy, and use second-staff approval for kicks when appropriate. Revoked/expired warnings do not count; revocation does not undo earlier removals or timeouts. Keep message evidence, purge logs, and case exports in staff-only destinations.
- Honeypot protection is opt-in. Keep its warning visible and review the cleanup window before enabling it: the bot can delete legitimate messages from the triggering account too. Staff can stop pending cleanup and release the incident's timeout, but deletion cannot be undone. Disabling detection does not lift existing timeouts.
- Run one instance per token/database under an unprivileged host account. Keep Node.js and dependencies updated, restrict file access, and use persistent storage.
- Backups contain private data. Store a protected copy off-host and test recovery before relying on it. Stop the bot before applying a restore; never delete SQLite WAL/SHM files as a shortcut for a lock error.
- `/logs setup` creates private event-log destinations and a separate DM inbox. Configure staff roles first, inspect member-role overrides, and keep DM threads private. Ordinary incoming/outgoing DMs can contain personal information; staff must use Reply or `/dm reply` to send a response, while other thread messages remain internal. Confession notifications and personal reminders are excluded from the relay.
- Confession anonymity applies to the bot interface, not host/database access. See [the privacy policy](PRIVACY.md).

Build and type checks do not validate every live Discord permission or client behaviour. Review configuration and try destructive operations in a dedicated test server first. This project is provided as-is under the MIT license.
