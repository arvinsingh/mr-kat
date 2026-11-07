# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting if available. If private reporting is unavailable, open an issue requesting a private contact route without publishing the exploit, tokens, user identities, transcripts, or database contents. Reports are handled on a best-effort basis; there is no response-time guarantee. Use the current main branch and review dependencies regularly.

## Operating the bot

- Use a Discord **bot token**, never a personal account token. Keep `.env`, databases, transcripts, backups, and host credentials out of Git. Reset an exposed token in the Developer Portal.
- Grant only the permissions your enabled features need. Respect role hierarchy and test staff restrictions with a normal member account. Administrator access is broad and not required for every feature.
- Run one instance per token/database under an unprivileged host account. Keep Node.js and dependencies updated, restrict file access, and use persistent storage.
- Backups contain private data. Store a protected copy off-host and test recovery before relying on it. Stop the bot before applying a restore; never delete SQLite WAL/SHM files as a shortcut for a lock error.
- Confession anonymity applies to the bot interface, not host/database access. See [the privacy policy](PRIVACY.md).

Build and type checks do not validate every live Discord permission or client behaviour. Review configuration and try destructive operations in a dedicated test server first. This project is provided as-is under the MIT license.
