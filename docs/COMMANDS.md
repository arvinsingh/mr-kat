# Command guide

## Message design

New posts and current command responses use **Discord Components V2**. Panels, logs, announcements, confessions, polls, suggestions, voice controls and DMs use integrated layouts; conversation replies, text effects and `/say` remain unboxed. Buttons and menus belong to the same card as their explanation. Forms use Discord's current labelled input layout. Files and images are displayed explicitly; long records split across messages rather than being truncated. Privacy, permissions, lasting staff receipts and confirmation requirements are unchanged.

Republish support, verification and role-selection panels to refresh older posts. Historical messages are not bulk-rewritten. `/help` includes audience and feature selectors as well as Previous/Next navigation.

All announcement paths—send, builder, everyone, schedule and edit—use the same neutral layout without a coloured side bar. Long announcements have tracked continuation messages; editing any tracked page updates the whole announcement and removes obsolete continuation posts. Everyone announcements require confirmation and allow the intentional notification only on the first page; edits and continuation pages do not ping. Typing additional `@everyone`/`@here` in an everyone announcement's title/body does not create extra mass notifications.

To insert the same divider used by the support panel, put `---` on its own line in your announcement body. Each separator becomes a native Discord divider; inside a fenced code block it remains literal text. The everyone preview uses the same divider layout as the published announcement.

```text
Welcome to the server!
---
## What is new
Community events are coming soon.
---
Thanks for being here!
```

Successful voice-room controls, channel lock/unlock/slowmode/archive changes, tags and sticky settings produce **normal persistent channel messages**. They cannot be dismissed like private interaction notices. Panels, announcements, suggestions, polls, and configured logs also remain normal messages in their designated channels.

Sensitive administrative changes keep a private acknowledgement and a **lasting staff receipt**: use `/changes` (Manage Server + staff allowlist), or read the configured admin log. Receipts survive dismissed acknowledgements, follow `retentionDays`, and are copied to the configured private admin log even when general event logging is disabled. `/changes` retains the fallback record if a log destination is absent/unavailable. They omit command arguments, file contents, DM bodies and anonymous-submission identities. Confirmation previews/cancellations do not create receipts.

Help, read-only queries, confession forms/submission acknowledgements, reports, personal preferences and sensitive exports remain private. Reports/tickets, polls and public posts retain their existing destination records. Errors are private. Each `/man` entry states its **RESPONSE** behavior; all registered command paths are checked by automated tests. Staff authorization is checked at execution time, including for buttons and scheduled jobs.

Confirm/Cancel prompts disappear after an accepted selection. A fresh private outcome message remains, with no stale confirmation controls. Expired prompts cannot execute an action; run the command again.

## Find help and share guides

**Interactive setup/health:** owners run `/setup` for a private feature selector, status checks, Refresh, Setup steps and native channel/role pickers. `/logs setup` creates a private Bot Logs category and missing log channels; reruns reuse existing private destinations under that category. Optional `category:` chooses an existing private category. Set `staffRoles` first so the appropriate roles get access. `/logs status` lists destinations. `/setup logs:#staff-bot-logs` sets combined event destinations only, preserving the separate DM inbox. Staff with Manage Server plus the allowlist use `/diagnose` or `/diagnose feature:voice` to inspect feature-specific configuration, channel overrides, role hierarchy, recent failed jobs and backup health. Owner picker selections require Confirm; permission and stale-setting checks run again before saving. Related feature enable commands remain explicit. Browsing/refreshing changes no settings; saved changes leave lasting staff receipts.

**Backup health/recovery:** `/backup` opens an owner-only private panel with Create verified backup, Refresh, file verification and downloadable recovery instructions. `/backup action:create`, `action:verify` (optional `file:`) and `action:recovery` are direct alternatives. Files stay on the host; the bot never attaches the database in Discord. New backups have integrity/schema/server checks and SHA-256 manifests. Local files share the host’s failure risk; copy them off-host yourself. Offline restore verifies first, blocks a running managed bot, preserves the old database/sidecars and requires explicit acknowledgement for pending work. See [deployment and recovery](OPERATIONS.md#restore).

**Purge records:** optional `reason:` appears in confirmation and audit records. Batches capture full available text/attachment references with actor, channel and job ID before deletion; matching gateway events do not duplicate those logs. Fresh fetches recheck pins. Completion, cancellation and errors leave a moderation summary with acknowledged, skipped, failed and uncertain counts. A timed-out/interrupted request may already have succeeded, so it is marked uncertain and is never blindly replayed. Log/excluded-channel contents are not recopied. `/jobs show id:JOB_ID` contains detailed outcomes.

- `/help` lists member commands; `/help audience:moderators` or `owners` lists the corresponding commands.
- `/help command:voice` or `/man command:voice setup` opens a detailed manual. Include a subcommand for its exact options and example. Use Previous/Next or the optional `page` field to navigate.
- `/help guide:members` downloads a guide you can copy into a Discord channel. Choose `moderators` or `owners` for staff versions.
- The [complete manual](MANUAL.md) includes every registered command and subcommand. The [member](DISCORD-MEMBERS.md), [moderator](DISCORD-MODERATORS.md), and [owner](DISCORD-OWNERS.md) guides are split into message-sized blocks for posting.

Reading help does not grant access to restricted commands. Commands marked owner require the actual server owner; staff commands also require their native Discord permission and the configured staff-role allowlist.

## Suggestions board

Owner: `/suggest setup channel:#suggestions`. Members use `/suggest create text:YOUR_IDEA` from any accessible command channel; every new suggestion goes to the configured board. The author’s name remains on the card after decisions. Existing suggestions stay where they were posted.

**Comment** opens the suggestion’s discussion thread directly. Type normally to reply under your own name; staff can alternatively use **Reply as bot** inside the thread (Manage Messages plus the staff allowlist). The suggestion title includes its current status. Staff use **Review** to choose Open, Under review, Needs info, Accepted, In progress, Implemented or Declined and enter a reason. `/suggest status id:REFERENCE state:needs_info reason:Please add more details` is a direct alternative. Review requires Manage Messages in the board and the staff allowlist. Every status change attempts an author DM with a link back; blocked DMs do not undo the decision. Members can continue commenting after resolution. Normal thread messages work when Discord permissions allow them. Give the bot Create Public Threads and Send Messages in Threads.

## Staff DM inbox

Owner: `/logs setup` provisions a separate private **bot-dms** destination. Ordinary outbound DMs are copied into one staff conversation thread per user, alongside their delivery result. Members’ incoming DMs and attachment links reach the same thread silently, without a forwarding acknowledgement. Users are never added to these staff threads, and messages tell them replies are shared with server staff. New incoming conversations require membership in the configured server; an existing conversation may continue after a member leaves.

Staff with Manage Server and the configured staff allowlist use the thread’s **Reply** button or `/dm reply message:YOUR_REPLY`. Regular messages in the staff thread remain internal notes. Outgoing replies identify the server, without naming the staff member. Confession notifications and personal reminders are excluded; replies referencing those notifications are not forwarded. DM bodies remain in the private Discord threads; the bot stores routing/delivery metadata for the relay. Existing event log destinations are preserved until `/logs setup` is run.

## Sticky notices

`/sticky set text:NOTICE` keeps a notice near the bottom of the current channel. Each new message, including bot posts, components and embeds, restarts a two-minute wait. The sticky reposts after two quiet minutes. Previous sticky copies are removed, and sticky-generated gateway events are ignored to prevent loops. Pending deadlines survive a restart. `/sticky remove` stops future refreshes.

## Text effects

All members can use **`/text`**, **reply commands**, or **Apps → Transform text** on an existing message. Results are lasting plain text, with notification pings and link previews suppressed. The source is never edited/deleted. Slash/menu confirmations remain private. Long results become complete `.txt` attachments; the bot needs Attach Files for those.

- `/text uwuify text:Hello friend! exclamations:true`
- `/text emojify text:Pizza and games tonight density:60`
- `/text faces text:Good morning density:50`
- `/text clap text:Please read the rules`
- `/text leetspeak text:Hello`
- `/text morse text:hello` or `/text morse text:.... . .-.. .-.. --- decode:true`
- `/text reverse text:Hello 👋`
- `/text zalgo text:Hello intensity:low` or `/text unzalgo text:PASTE_GLITCHED_TEXT`

**Transform someone else’s message:** right-click/long-press → Reply → send `!uwu`, `!emojify`, `!faces`, `!clap`, `!leet`, `!morse`, `!reverse`, `!zalgo` or `!unzalgo`. Optional arguments: `!emojify 60`, `!faces 30`, `!zalgo high`, `!morse decode`. Alternatively, Apps → Transform text opens a private effect picker. You can also supply `message:MESSAGE_LINK` instead of `text:` to any `/text` effect. Message links must point to this same server and channel. Both member and bot need Read Message History for existing messages, plus posting permissions. Missing/deleted messages and messages containing only attachments/embeds are rejected. Menus expire after five minutes and are bound to their opener. Selected controls are removed before delivery.

The **community** module and `textEffects.enabled` must be on; both default on. To restrict effects to chosen channels (including their threads), the owner sets `/config set key:textEffects value:{"enabled":true,"channels":["CHANNEL_ID"]}` and confirms. An empty channels list allows all otherwise eligible channels. Global excluded channels and excluded parents remain excluded. Disable with `/config set key:textEffects value:{"enabled":false}`. Preserve other nested values when replacing the setting; omitted fields return to defaults.

Input is limited to 4,000 characters. Emoji/face density is 1–100; defaults are 100/50. Zalgo has bounded low/medium/high intensity. Prose effects preserve URLs, code, mentions and custom emoji; reverse handles whole visible characters. Morse supports letters/numbers/spaces and explicit `/` word separators; unknown symbols are rejected. Unzalgo also removes decomposed accents. Emoji matching uses an original curated English vocabulary, not an external service. No new credentials, dependencies, paid APIs or command cooldowns are added. See `/help command:text` for the full manual.

## Mention replies

Explicitly tag the bot in a server message to get a random witty reply tagging you, with a `/help` reminder. It posts ordinary lasting text, with no embed or quote box. There are 36 built-in responses; the previous line is not repeated when alternatives exist. Bots, webhooks, automatic reply pings, excluded channels (including their threads), and AutoMod-flagged input are ignored. The bot needs View Channel and Send Messages (Send Messages in Threads for an active, unlocked thread). No additional API or hosting service is used, and no command cooldown is imposed.

The feature is enabled by default while the `messages` module is on. As owner, set a commands-channel destination and confirm:

`/config set key:mentionReplies value:{"enabled":true,"commandsChannel":"CHANNEL_ID"}`

Replace `CHANNEL_ID` with the numeric ID of a normal text channel. The reply includes a clickable channel mention only when both the bot and the person tagging it can see that channel; otherwise it simply points to `/help`.

To customize the lines, use `/config export` and edit `mentionReplies.responses`, then import and confirm. Alternatively, set the entire object:

`/config set key:mentionReplies value:{"enabled":true,"commandsChannel":"CHANNEL_ID","responses":["You rang?","At your service."]}`

Use 1–50 nonempty responses, each at most 250 characters. The bot adds the user mention and help footer. Only that user can be pinged, even if custom text contains other mentions. Omitted nested fields return to defaults, so include the channel/custom responses you want to preserve when replacing this object. Disable with `/config set key:mentionReplies value:{"enabled":false}`. See `/help command:config` for details.

## UwU Lock

Staff can temporarily transform a member’s **new messages server-wide or in one selected channel**. Open `/uwulock panel`, choose **Server-wide** (the default) or **This channel only**, then choose a member and duration and press **Start / replace lock**. Or use:

```text
/uwulock add member:@Friend duration:10m
/uwulock add member:@Friend duration:10m channel:#fun
/uwulock remove member:@Friend
/uwulock remove member:@Friend channel:#fun
/uwulock list
/uwulock stats
/uwulock clear
```

Duration defaults to ten minutes; allowed range is ten seconds–one day. Locks survive restarts and expire automatically. Staff need Manage Messages and the configured staff allowlist. Both their highest role and the bot’s highest role must be above the target. Administrators, the owner, bots and protected roles cannot be locked. Clear requires Manage Server plus confirmation. Successful changes leave lasting staff receipts.

**Omit `channel` to apply the lock across accessible supported text/announcement channels and public threads.** Specify `channel` to restrict it to that one channel. Access and the target/staff/bot permissions are rechecked in every destination; protected channels, explicit exclusions and any configured UwU channel allowlist still apply. Existing channel-only locks retain their scope. If both scopes are active, the channel lock takes precedence; an expired channel lock falls back to the active global lock.

**Unlock without `channel` to remove all this member’s global and channel locks.** Supplying `channel` removes only that channel-specific lock and warns if a global lock is still active. This does not create an exemption from a global lock. The panel’s server-wide Unlock performs the full unlock.

Grant the bot **Manage Webhooks, Manage Messages, View Channel, Read Message History, Attach Files and Send Messages** (Send Messages in Threads where needed). `/diagnose feature:community` checks active lock destinations. No new token, runtime, dependency or paid service is required.

The bot reuses one webhook per parent channel, posts with the member’s display name/avatar and an APP badge, confirms delivery, then deletes the original. A replacement gets a new message ID; reactions and existing reply references do not transfer. A reply includes a link to its referenced message. Unlocking affects future messages and does not restore deleted originals. Human text passes existing bot AutoMod checks first. No bulk server-wide lock is provided.

Members retain control: **right-click/long-press their replacement → Apps → Edit transformed message / Delete transformed message**. Editing opens a private form with their last submitted text and reapplies UwU conversion. Ownership/access are checked again on submission; stale forms and repeated submissions fail safely. Author actions work after unlock and are logged explicitly. Editing retains original attachments and replaces the generated text file as needed. Bot AutoMod invite/domain/mention checks apply to edits; native Discord AutoMod does not receive these forms as ordinary member messages.

Attachments are forwarded with filenames, spoiler markers and descriptions, up to **10 MiB total and ten files**. Larger or failed downloads leave the source untouched. Output over 2,000 characters becomes a complete text attachment instead of being truncated. Uncertain sends are never automatically retried; check the admin log before acting. Source messages changed or deleted during preparation are not blindly replaced. Link/code/mention/custom-emoji/timestamp syntax is protected, with notification mentions and link previews suppressed.

Locks work in ordinary text/announcement channels and active public threads with those parents. Global locks cover eligible public threads automatically; channel-only parent locks do not cover their threads. Introductions and welcome/leave chat channels are eligible; the bot’s own posts are ignored. Private threads, forum posts, voice chat, support tickets, confessions/review channels, logs, starboard, heartbeat, rules and active self-role selection destinations are excluded. An unused roles-channel setting with native role selection does not block chat. Channel-only panel/add errors identify the specific protected destination, exclusion or allowlist restriction; global locks skip those destinations. Pinned messages, thread starters, polls, stickers, forwards, attachment-only posts, bots/webhooks and `!`-prefixed commands are skipped. Existing messages and later edits of untouched originals are not converted. Messages sent while offline stay unchanged.

Owner configuration: `/config set key:uwuLock value:{"enabled":true,"channels":["CHANNEL_ID"]}`, then confirm, further restricts eligible destinations. An empty channel list still requires individual channel/member locks. Disable with `{"enabled":false}`. The community module must be enabled. Changing permissions, staff roles, protected roles or exclusions stops ineligible locks from acting. Ownership/edit records follow `retentionDays` and are included in backups; after they expire, only normal staff deletion remains available. Statistics count confirmed conversions, not attempted sends.

See `/help command:uwulock` for the full manual.

## Bot permissions and Administrator

Yes, you can grant **Administrator** to the bot role under Server Settings → Roles → the bot's role → Permissions. It grants all permissions and bypasses channel overwrites. Place the role above the roles and members the bot must manage: Administrator does not remove role hierarchy. Intents in the Developer Portal, command access under Server Settings → Integrations, and feature configuration are separate requirements. See [Discord's permission reference](https://docs.discord.com/developers/topics/permissions).

For the native AutoMod permission failure, **Manage Server on the bot role** is sufficient; the integration command checkbox controls who can invoke commands, not the bot's permission to create rules.

## Choose who can operate the bot

1. Enable Discord **Developer Mode** (User Settings → Advanced). Copy the IDs of your Moderator and Admin roles from Server Settings → Roles.
2. As the actual server owner, run `/config set key:staffRoles value:["MOD_ROLE_ID","ADMIN_ROLE_ID"]`, replacing both placeholders with numeric IDs, then **Confirm**. Include every trusted staff role you want to use the bot. This list does not grant any Discord permissions. An empty list allows anyone with the required native permission; non-owner administrators must be on a nonempty list too. The server owner bypasses the allowlist.
3. Give those Discord roles only the permissions their jobs require. **Manage Messages** covers purge, announcements and ticket management; **Moderate Members** covers warnings/timeouts/reports; **Kick Members** and **Ban Members** cover those removals; **Manage Roles** covers role changes; **Move Members** covers moving people. **Manage Server** covers staff DMs, heartbeat status and incident controls. Role hierarchy and channel overrides also apply.
4. Under **Server Settings → Integrations → mr-kat → Commands**, restrict staff-only commands to those staff roles for visibility. Leave member commands such as `/confess`, `/ticket open` and `/voice` available. Discord permissions are configured per top-level command, so mixed commands still enforce their restricted subcommands in code. Reading help does not grant access. Owner-only setup stays owner-only even for admins.
5. Put the bot above the roles/members it manages. Test a staff command with an ordinary member and a staff member. Use `/help audience:moderators` and `/help audience:owners` for the access distinction.

`protectedRoles` is a separate safeguard against acting on privileged roles/their holders. `selfRoles` and automatic join roles are for ordinary members and must never contain moderation/admin roles.

## Configure the support system

1. Create a Discord **category** called **Support Tickets** and a normal, member-visible **#support** text channel. Copy the category ID using Developer Mode. Keep staff operational discussion elsewhere.
2. As owner, configure the category and staff roles, confirming each settings change:

```text
/config set key:ticketCategory value:"CATEGORY_ID"
/config set key:staffRoles value:["MOD_ROLE_ID","ADMIN_ROLE_ID"]
/config module name:tickets state:on
```

Replace example IDs with your actual numeric IDs. Give the bot **Manage Channels**, **Manage Roles / Manage Permissions**, **View Channel**, **Send Messages**, **Embed Links**, **Attach Files** and **Read Message History**. Give support staff **Manage Messages** and include their role in `staffRoles`.

3. Publish the member-facing panel:

```text
/ticket panel channel:#support title:Contact staff description:Open a private ticket for help.
```

4. Test **Open a support ticket** with an ordinary member. The integrated Discord Components V2 card keeps its text and button together. The button opens a private subject-and-description form. Submitting creates a channel in the configured category: @everyone is denied access, and the member, bot, server owner and configured staff roles are allowed. Discord administrators can still access private channels. An empty `staffRoles` list does not give ordinary staff roles access to tickets. Republish the panel after upgrading to replace an older panel's appearance.
5. Staff use **Claim** or `/ticket claim`, chat in the private channel, then `/ticket close reason:Resolved`. The creator can close their own ticket too. Closure hides the channel from its creator and changes the ticket card to **Reopen (staff)**, **Transcript (staff)** and **Delete channel (staff)**. Only staff can reopen. Deletion requires Manage Messages, Manage Channels and confirmation; reopened/changed tickets invalidate old deletion prompts. Closed channels follow `retentionDays`. One open ticket per member, 50 per server; there is no creation cooldown.

On closure the bot attempts one DM containing **Status: Closed**, the original support request, the closing reason and a text transcript of up to the latest 1,000 accessible messages (4 MB limit). Attachment links are references and may expire. A blocked DM, failed export or unavailable control card does not undo closure: staff receive a delivery result and can still use slash commands. The member needs server DMs enabled. Staff transcript exports remain private. The closure DM does not identify who closed the ticket.

Claiming now posts a **normal, lasting message inside the private ticket** showing **Claimed by @Staff** and the claim time. The ticket creator and other staff can see who is handling it. Other staff retain access and may help, but cannot overwrite another person's claim; the error identifies the current claimant. Repeated claims by the same person do not duplicate the notice. Reopening keeps the assignment. If notice delivery fails, the assignment remains saved and the bot reports the delivery problem.

Reports are separate: `/config log kind:reports channel:#staff-reports` selects a staff-only destination. Members use `/report` or the message context menu → Apps → Report message; moderators use `/review list` and `/review resolve`.

## Heartbeat and lasting notices

```text
/heartbeat setup channel:#bot-status minutes:5
/heartbeat status
/heartbeat disable
```

Setup/disable require the owner; status requires Manage Server and the staff allowlist. Use a normal text channel where the bot can view/send messages and embed links. The interval is 1–1,440 minutes, default 5. Each normal status post shows time, uptime and gateway latency. The first follows shortly after setup; missed intervals are not replayed after restart. Failed/uncertain delivery waits until the next interval; status/host logs show the issue. Disable keeps existing posts. An offline bot cannot send an offline alert. This uses the existing bot process and no paid service.

`/panic on` and `/panic off` post lasting notices in **each affected channel**. Successful warnings, timeouts, timeout removals, kicks, bans, unbans and nickname changes post member/time/reason/case in the **original command channel**, including when a second staff member approves elsewhere. Public notices and moderation DMs do **not** name the requesting or approving moderator. Channel lock/unlock/archive/slowmode notices also omit the actor and use private acknowledgements. Private cases, staff logs and Discord's native audit log retain accountability. Use a staff channel if the reason is sensitive. Warning/timeout/removal actions attempt DMs; blocked DMs do not cancel enforcement. Private notes and exports stay private.

## Warnings, revocation and escalation

```text
/warnings panel
/warnings panel member:@Member
/warnings list
/warnings list member:@Member
/warnings revoke case:12 reason:Appeal accepted after reviewing context
/warnings status
/warnings configure threshold:3 action:kick
/warnings configure threshold:3 action:timeout timeout_minutes:10
/warnings configure threshold:0 action:none
```

**Guided panel:** `/warnings panel` opens a private dashboard; `/warnings list` opens the same controls. Staff can use the **member picker**, browse history with **Previous / Next / Refresh**, then select a warning to read its full reason. Select **Revoke warning** to open a private reason form. Submitting revokes the warning and refreshes the panel; the member receives a notice. Ordinary members see only their own history and cannot pick other members or revoke warnings. Long details have separate **Previous detail / Next detail** buttons.

**Owner policy controls:** choose **Warning policy**, select **Automatic action** and **Active warning threshold**, and use **Timeout duration** for the number of minutes. These are drafts: nothing changes until **Review changes → Confirm**. The review appears separately so the main panel stays available; Cancel keeps the saved policy. **Reload saved policy** discards unsaved choices. The panel shows saved settings, bot permission checks and second-staff approval status. A newer saved policy invalidates an older preview instead of being overwritten.

Panels expire after ten minutes; forms expire after five. Every action rechecks permissions and panel ownership. A revoke form is rejected if the selected member/warning changed, and a completed form cannot be reused. Command alternatives below remain available.

Members can inspect their own warning history. Moderate Members and the staff allowlist are required to inspect others, revoke warnings or check the policy. History has **Previous**, **Next** and **Refresh** controls and separates active, expired, revoked and total retained counts. `/mod info` also shows warning totals. Records already removed by `retentionDays` cannot be counted.

Only the server owner can configure escalation, with confirmation. At the threshold, a **new warning** can automatically trigger the selected timeout or kick; changing the policy does not punish existing members retroactively. Threshold `0` or action `none` disables escalation. Existing `warningThreshold` settings keep their timeout behavior unless `warningAction` is changed. Bot permissions, role hierarchy and protected roles apply. A warning issuer needs Moderate Members; the owner-authorized automatic kick requires Kick Members on the bot. If `secondApproval` is enabled, a different staff member with Kick Members must approve the automatic kick. Active warnings and current policy are checked again before enforcement. Failed or uncertain actions preserve the warning and are not automatically retried.

Revocation preserves the original case but stops that warning counting toward escalation. Accepting its `/appeal` through `/review resolve kind:appeals ... decision:accepted` also revokes it. A warning expiring or being revoked invalidates an outstanding kick approval based on that warning set. Revocation DMs/public notices omit staff identity; private logs retain it. Revocation does not automatically undo an earlier timeout or let a kicked member rejoin. A kicked member cannot run server slash commands until they rejoin; provide an outside-server contact route for those appeals.

## Message evidence

For warnings, kicks and bans, select the source message's **Apps → Moderate with evidence** action. A private action picker and reason form open; kicks/bans still require confirmation and any configured second approval. No public reply command is needed, so the moderator's identity is not disclosed by a typed shortcut.

Alternatively, copy the message link and supply it as `evidence`:

```text
/mod warn member:@Member reason:Repeated harassment evidence:MESSAGE_LINK
/mod kick member:@Member reason:Repeated rule violations evidence:MESSAGE_LINK
/mod ban member:@Member reason:Spam evidence:MESSAGE_LINK
/mod evidence case:123
/report member:@Member reason:Please review this evidence:MESSAGE_LINK
```

A message ID also works for a message in the command's current channel. The actor and bot need View Channel and Read Message History in the same server; excluded channels and excluded parents cannot be captured. The bot saves the message text, author, timestamps and attachment references before it disappears. It does not download evidence files or require screenshots. Case evidence can be exported privately with `/mod evidence`; it follows `retentionDays` and is included in database backups. Report evidence remains in the private report workflow. Existing attachment URLs may expire. Slash commands cannot automatically discover a replied-to message; use the message menu or link option.

## Plain channel messages

Use `/say message:Your message` to post lasting plain text as the bot in the current channel or thread. Supply `channel:#general` to choose another destination. Omit `message` to open a multiline Markdown composer (2,000 characters). Manage Messages, the staff allowlist and destination posting access apply. The post has no staff attribution or public interaction acknowledgement; staff logs record the actor and destination without copying the body. User/channel references render normally, but mention notifications are suppressed. Unknown delivery outcomes are reported without automatically sending again.

## Protected-role mention redirects

As owner, enable a polite support redirect and repeated-role-ping alerts:

```text
/mentionguard setup roles:MOD_ROLE_ID,LEAD_ROLE_ID support_channel:#support limit:3 seconds:30
/mentionguard setup roles:MOD_ROLE_ID channel:#general support_channel:#support
/mentionguard status
/mentionguard disable
```

Copy actual role IDs using Developer Mode. **Omit `channel` for server-wide monitoring** across otherwise eligible accessible channels. Supply it to restrict monitoring to that channel and its threads. `support_channel` independently selects the redirect destination; omitting it preserves an existing support destination, or falls back to `/ticket open`. Existing saved setups remain server-wide. The AutoMod module must be enabled. Members mentioning a protected role get a randomized plain-text reply pointing to support; if they cannot see that channel, the bot suggests `/ticket open`. Repeated mentions of other roles also trigger a private staff alert: by default three role-mention messages within 30 seconds across channels, or three distinct roles in one message. Automatic replies are limited to one per sender per 15 seconds to avoid flooding. Administrators and configured `roleMentions.exemptRoles` are exempt. Owners can edit the response list and exemptions through configuration export/import.

**The guard keeps the original message and does not cancel delivered notifications.** To prevent ordinary members from pinging staff, turn off **Allow anyone to @mention this role** on those roles and restrict **Mention @everyone, @here, and All Roles**. Native `/automod mentions` can block excess mentions before publication; it is separate from this redirect. Other existing AutoMod policies may still act according to their own settings.

“Lasting” means a normal Discord message that cannot be dismissed as an ephemeral interaction. Staff can still delete it; configured logs and retained receipts still follow retention. Settings changes keep their staff-only admin-log receipt even with event logging off. No bot command imposes a waiting-period cooldown; duplicate/concurrency checks, capacity limits, AutoMod spam detection, explicit channel slowmode settings and Discord API rate limits remain.

## Bulk message cleanup

Temporary text-channel creation replies and voice-room creation notices retain both the clickable channel tag and its plain-text name in parentheses. The name remains readable after Discord shows the deleted channel as unknown. Existing historical posts are unchanged.

`/purge count:100 scan:300` previews matching IDs and requires confirmation. Recent messages are deleted in batches of up to 100; a singleton uses an individual delete. Messages near/over two weeks old are skipped by default. Only `older:true` authorizes deleting those individually, because Discord forbids bulk deletion for them. Pins, current staff/bot permissions, module state and cancellation are rechecked while executing. `/jobs show` reports deleted/skipped/failed counts; `/jobs cancel` stops remaining work. Failed bulk requests are recorded without individual fallback, because an uncertain request may already have succeeded. Deletion cannot be undone. See [Discord's bulk deletion endpoint](https://docs.discord.com/developers/resources/message#bulk-delete-messages).

## Message logging

The messages log posts **edits and deletions only**, not ordinary message creation. Automatic link-preview loading, pin changes, and updates with unchanged text/attachments are ignored. Bot-authored messages, webhooks, configured log destination channels, and explicitly excluded channels do not produce message logs, preventing log feedback loops.

Edit/deletion logs include the message ID, channel, and author details when available. Cached messages supply the author and text even when `snapshotDays` is `0`. Enable `snapshotDays` (for example, `7`) to retain optional SQLite baselines beyond Discord's bounded in-memory cache; observing a new message for that purpose does not post it to a log channel.

When an uncached message has a new edit timestamp but no earlier text, the edit log labels the original text unavailable. If a message was neither cached nor stored before deletion, Discord only provides its IDs: the bot preserves those IDs and labels missing author/content unavailable. A deleted message cannot be fetched afterwards, and the original-message reference may no longer open. The author is not necessarily the person who deleted it.

Logs preserve **all available text** across numbered messages instead of cutting off long content. Bot purges now capture fresh message content **before each deletion request** and emit **Message purge** log messages containing the requester, source channel (plus its plain name), a link to the moderation purge record, and **username: message text** entries. Complete available text is split across numbered bot messages on overflow; no downloadable text transcript is sent. Failed/uncertain attempts are separated from confirmed deletions. Internal records retain message IDs, timestamps and attachment references. This includes all batches, cancellations and interrupted operations; skipped messages are not described as deleted. A separate private moderation summary records counts and accountability. Log/excluded channels and their excluded parents are respected.

Discord cannot recover content after an external deletion if the bot never saw or retained it. Optional snapshots help with ordinary external deletions; purge transcripts do not require enabling snapshots. Native role mentions in logs are clickable and notification pings are suppressed. Deleted roles can no longer resolve, so names/IDs remain as reference. Deleting only bot/log messages produces no message audit entry. Administrative channel logs are emitted only for setting changes, not message-activity metadata.

Member logs distinguish server-avatar and global-avatar changes from actual role changes. They include the current avatar through its Discord CDN URL; the bot does not download images or keep an additional avatar-history cache. An incomplete old member event is not treated as evidence that all roles changed.

## Commands

`/changes limit:10` shows retained staff-change receipts. It requires Manage Server and the staff allowlist.

### AutoMod: two separate systems

Run `/automod status` first. It reports the bot detector's module state, current enforcement mode, thresholds, log destination, and the bot's permission to manage native rules. It works even if the detector module is disabled.

**Bot spam detector:** observes rapid/repeated messages, excess mentions, and optionally invites. It starts in `report` mode, which alerts staff without deleting or timing out. As the owner, use `/automod panel` for mode buttons or configure it directly:

```text
/automod configure mode:report messages:6 seconds:8 repeats:3 mentions:6 block_invites:true
```

After testing, select `delete` or `timeout` if desired. Check `/config module` has automod enabled, the spam log destination is accessible, and the test channel/role is not excluded or exempt. Message Content Intent must be enabled in the Developer Portal. Enforcement needs the corresponding bot permissions: Manage Messages for deletion and Moderate Members for timeouts.

**Discord native AutoMod:** blocks matching messages before they appear. `/automod keyword name:Blocked words words:word1,word2` creates or updates a bot-owned keyword rule; `/automod mentions limit:6` creates or updates its mention rule. Use `/automod list` to get rule IDs, then `/automod toggle rule_id:ID state:off` to disable a bot-owned rule. Manage Server is required on both the authorized staff member and the bot. Owner-only configuration controls the separate bot detector.

Discord always exempts members with Administrator or Manage Server from native AutoMod; test with an ordinary member account. The API permits six keyword rules and one mention-spam rule per server; the bot preserves rules created by other people and explains conflicts. Native exemptions allow at most 20 roles and 50 channels. See [Discord's AutoMod FAQ](https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ) and [API reference](https://docs.discord.com/developers/resources/auto-moderation).

### Anonymous confessions and reply threads

Use internal linking for anonymous discussions. The owner configures the publication channel and, when review is enabled, a different staff-only review channel:

```text
/confession setup channel:#confessions privacy:internal review_channel:#confession-review
/confession mode value:instant
```

For a fresh instant setup, omit the review channel and pass `review_required:false`. To restore review for new submissions, run `/confession mode value:review` after configuring a private review channel. Existing pending submissions are never published automatically when switching modes.

**Privacy:** `internal` retains IDs privately for OP recognition, thread-specific aliases and reply DMs. No bot command reveals author IDs to members, moderators, administrators or the owner. Internal IDs are not included in confession posts, review cards, staff logs or job exports. Hosting/database operators and anyone with database backups can still inspect stored data; this is an application permission boundary, not cryptographic anonymity. Discord processes interactions, and identifying text can reveal its author. The compact form says only that the confession or reply is anonymous; this help explains internal retention.

Legacy `staff` configuration is normalized to `internal`, and author lookup has been removed for all records. The one-time reply compatibility upgrade switches an enabled legacy `unlinked` configuration to `internal` for future forms; internal linking is documented in this help. Older unlinked submissions retain no author mapping or OP recognition. Their new Reply buttons support fresh internally linked replies; the old OP cannot be notified unless they join/reply. A later explicit owner choice of `unlinked` is respected and is not reset by maintenance. Old posts/history from another Confessions bot are not imported.

**Member flow:**

1. Run `/confess`, fill in the private form (1–1,900 characters), and submit. The form shows a short anonymous notice; the submission result confirms publication or staff review. Distinct submissions and replies have no waiting-period cooldown. The private result says only that the confession was posted (or submitted for review) and refers to `/help command:confess` for privacy details.
2. Press **Reply** on an internal confession, fill in the private form, then submit. The bot creates/reuses the root's public thread and posts the reply inside it without user mentions or avatars. Cancelling the form leaves no empty thread. `/confess reply_to:12` opens the same flow. Review mode still requires staff approval before publication. Submitting immediately after opening the form is supported.
3. The root author is labeled **OP** on replies. Other participants receive stable **Anonymous 1**, **Anonymous 2**, etc. labels within that discussion only. The bot does not add real participants to thread membership. **Typing ordinary messages or joining a thread as your account can reveal participation.** Use the bot form for anonymous replies.
4. Each published reply sends its text and a **View reply** button by DM to the OP, prior published contributors, and current native thread members, once per person. The sender, bots, muted users and users without access are excluded. Merely reading the thread does not subscribe you. Open the post and press **Reply** to answer anonymously. Native thread members can mute DMs without posting a confession. Up to 100 anonymous contributors are supported per discussion; DMs are best effort and are not automatically replayed after interrupted delivery.
5. Use **Mute / unmute DMs** or `/confess-notifications id:12 enabled:false` (`true` to enable). This changes notifications; it does not delete posts or the bot-internal link used for OP recognition. Replies to DM notices are not monitored.
6. **Report discussion** alerts the configured staff reports destination with a post reference and no reporter/participant identities. One report per minute is allowed.

**Staff controls:** `/confession status`, `list`, and `review id:12` inspect settings/records or resend an undelivered review card. `/confession thread id:12` creates/attaches a missing thread without reposting the root. Unlocked archived threads reopen automatically on reply. `/confession close id:12` locks/archives a discussion; staff-locked/closed discussions need `/confession reopen`. Review cards keep their final published/rejected status after a decision. `/confession remove id:12 reason:TEXT` removes a post; removing a root closes its thread, retaining existing replies for staff review. Pending replies cannot publish into closed discussions.

Startup/hourly maintenance repairs Reply buttons on retained posts when threaded mode is enabled (up to 25 per pass). **Older unlinked posts retain their original privacy and cannot acquire an OP identity retrospectively.** If new posts have no Reply button, check `/confession status`: threaded replies require `privacy:internal`, selected explicitly with `/confession setup`. Blocked DMs cannot be delivered; configure the bot's thread permissions and allow server DMs.

The bot needs **Create Public Threads**, **Send Messages in Threads**, **View Channel**, **Read Message History** and **Embed Links**; **Manage Threads** is needed to close/reopen or remove threaded roots. Members need to view the discussion and use application commands, not ordinary thread posting. Deny ordinary **Send Messages in Threads** on the publication channel for button-only replies; check role/member overrides too. Direct typing is never made anonymous by the bot.

A post whose send outcome is uncertain is not automatically retried. If the root is published but thread creation fails, repair with `/confession thread` rather than resubmitting. Records and internal participant links follow retention; expired records cannot accept new replies even if public posts remain. Backups have their own expiry. To disable submissions/approvals, export configuration, set `confessions.enabled` to `false`, then import and confirm.

### Starboard

Create a normal text channel (for example `#starboard`), then run as the server owner:

```text
/starboard setup channel:#starboard threshold:1
```

One **⭐** from a human account now copies an eligible message into that channel, with its author, text, non-spoiler attachments, and a **View original** button. More stars update the same copy. Removing stars below the threshold removes the copy. Editing or deleting the source updates/removes its copy. The source message is never changed or deleted by starboard.

The author's own star counts by default. Set `self_stars:false` to exclude it, or raise `threshold` (1–100) to require more people. Normal and super reactions count as one vote per person. Bot reactions and custom star emoji are ignored.

Sources must allow **@everyone View Channel and Read Message History**. Public threads are supported; private channels/threads, bot and webhook posts, configured log/excluded channels, the confession channel and the board itself are skipped. NSFW sources require an NSFW board. Source/channel deletion cleans up copies; permission changes recheck affected copies while enabled. This avoids moving staff or anonymous discussion content into public highlights. Channel permissions gated entirely behind a Member role do not qualify as public sources.

The bot needs **View Channel** and **Read Message History** on sources, plus **Send Messages** and **Embed Links** in the board. The community module must be on. Reactions are enabled in code, with no additional privileged intent to switch on in the Developer Portal.

`/starboard status` and `/starboard refresh channel:#general message:MESSAGE_ID` require Manage Messages and the staff allowlist. Refresh can process an older starred message or recalculate it after a threshold change. Enabling/restarting does not scan the server's message history; later reaction events can process older messages. `/starboard disable` is owner-only, stops updates, and keeps existing copies; source-deletion cleanup still runs. A changed destination applies to new entries; existing entries stay in their original board.

Persistent delivery receipts prevent duplicate copies after restart or a network timeout. If delivery is uncertain, automatic reposting stops. Refresh searches the last 100 board posts to recover the existing copy; status reports unresolved deliveries. If recovery cannot find it, the owner must inspect the board before any receipt is manually removed. Rich embed previews and message replies are not copied.

### One-way staff DMs and moderation notices

```text
/dm send member:@Member message:Please review the server rules. reason:Onboarding follow-up
/dm template name:introduction text:Welcome {name} to {server}! Please introduce yourself.
/dm from-template member:@Member name:introduction reason:Requested guidance
/dm templates
```

These require **Manage Server**, the staff allowlist and the messages module. Sending requires a private preview and confirmation; authority and current target membership are checked again before delivery. One current human member is targeted, with no sender cooldown. Confirmations remain single-use. No mass messaging or DM reply relay is provided. Templates support `{user}`, `{name}`, `{server}`; names use 1–32 letters/digits/underscores/hyphens, with up to 100 saved templates. Saving a name again replaces it.

Messages identify the server and state that replies are not monitored. Staff logs contain sender, recipient, reason and delivery result, without message bodies. Temporary confirmation records retain the draft until expiry. **sent** means Discord accepted the message, not that it was read; **blocked**, **failed** and **uncertain** distinguish failures. An uncertain send may have arrived: confirm with the recipient before retrying. DMs cannot bypass recipient privacy settings.

Warnings, timeouts and timeout removals attempt automatic DMs with reasons/case details. Automatic spam timeouts also notify. Kick/ban DMs are attempted only after approval and permission checks, before removal; they say removal will be attempted next rather than claiming it already succeeded. Blocked/failed DMs do not cancel moderation. These notices cover actions performed through mr-kat, not every action performed manually in Discord or by another bot.

### Welcoming members and automatic roles

**Already using Discord Channels & Roles?** Run `/onboarding setup roles_source:native`. That native page is not a normal text channel, so it cannot appear in the `roles_channel` picker. The **initial welcome DM** contains **Open server** and **Channels & Roles (desktop)** link buttons, plus mobile instructions in its text. No Choose roles interaction or second message is needed. Older Choose roles buttons update their original message in-place when clicked. On mobile, open the server channel list → **Channels & Roles** → **Customize** if shown. The desktop shortcut can open a blank page in mobile clients; use those steps instead. No channel ID is needed for the native page. Use `roles_source:channel roles_channel:#roles` only for a real channel containing role instructions/panels. `roles_source:none` omits the role-selection button.

Roles are existing Discord server roles; the bot does not need a new set of roles of its own. These settings have different jobs:

| Setting          | What it does                                                                                     | Example                     |
| ---------------- | ------------------------------------------------------------------------------------------------ | --------------------------- |
| `staffRoles`     | Allows selected staff roles to use restricted bot commands, alongside native Discord permissions | Moderator, Admin            |
| `protectedRoles` | Prevents bot moderation of members holding those roles and prevents management of those roles    | Senior Admin                |
| `joinRoles`      | Assigns ordinary roles automatically after screening by default                                  | Member                      |
| `selfRoles`      | Roles available in the bot's optional dropdown panel                                             | Gaming, Event notifications |
| `restoreRoles`   | Community roles eligible for restoration when a member rejoins                                   | Gaming                      |
| `verifiedRole`   | Role granted by the bot's optional acknowledgement/approval panel                                | Verified                    |

**The bot role menu is optional.** `/role menu` posts a message with a dropdown. Members select interest roles and the bot adds/removes those selected roles. If native Channels & Roles already handles this, skip `selfRoles` and `/role menu`. Do not assign the same role choices through both systems. A Member role is only necessary if your server actually uses one for access or organization.

**Rules Screening versus verification:**

- Native Discord Rules Screening is configured in Server Settings → Safety Setup on a Community server. New members must accept Discord's rules prompt. Our `after_screening:true` waits for Discord's pending state to clear before automatic roles and welcome DMs. It does not turn screening on. Without native screening, those actions are immediate.
- Native Channels & Roles asks preference questions and assigns roles/channels. This is role selection, separate from agreeing to rules.
- `/verify panel` is an optional, additional bot message with an acknowledgement button. Configure `verifiedRole` first; the button grants that role immediately unless `verificationReview:true`, which queues staff approval via `/verify pending`, `approve` or `deny`. It is not age/identity verification or proof of being human.
- Recommended for servers already using native onboarding: native Channels & Roles + native Rules Screening + bot welcomes/optional automatic Member role. Skip the additional bot menu and verification panel unless you need a separate gate.

**How optional bot verification works:**

1. Create an ordinary **Verified** role in Discord, without moderation/admin permissions. Put the bot above it and give the bot **Manage Roles**.
2. As owner, run `/config set key:verifiedRole value:"ROLE_ID"` using that numeric role ID, then **Confirm**. Keep the onboarding module enabled.
3. Publish `/verify panel channel:#rules rules:Read and accept our server rules.` in a channel newcomers can access.
4. Members press **I agree to the rules**. With the default `verificationReview:false`, the bot assigns Verified immediately. With `verificationReview:true`, it queues a request: authorized staff with Manage Server and an allowed staff role use `/verify pending`, then `/verify approve member:@Member` or `/verify deny member:@Member`. Denial clears the request without assigning the role.
5. The role only unlocks channels if **you configure Discord channel/category permissions** to do so: deny @everyone View Channel on gated categories and allow Verified, while leaving the rules/panel channel accessible. The bot does not create that permission gate automatically. If no access gate is needed, the role can simply mark acknowledgement.

This does not prove identity, age or humanity. It is independent of Discord's native rules acceptance and Channels & Roles, and public welcome messages can remain off. Panic mode temporarily pauses the bot verification flow. If native Rules Screening already covers your needs, the extra bot verification panel is optional.

```text
/onboarding setup channel:#welcome public_welcome:false welcome_dm:true roles_source:native rules_channel:#rules introduction_channel:#introductions
/onboarding message text:Welcome {user} to {server}! dm_text:Welcome {name}! Choose roles and introduce yourself.
/onboarding autoroles roles:ROLE_ID_1,ROLE_ID_2 after_screening:true
/onboarding preview
/onboarding status
```

All onboarding commands are **server-owner-only**. The onboarding module must be enabled for automatic behavior. Welcome messages use colored embeds. Public and private templates support `{user}`, `{name}` and `{server}`, up to 1,500 characters. Welcome DMs are off until enabled. Native role selection places the two links above directly in the first DM; accessible **Read the rules** and **Introduce yourself** buttons appear alongside them. All new navigation buttons are URL links. Ordinary channel buttons appear only when that member can view the channel. `/onboarding preview` shows the same buttons and mobile instructions privately without sending a DM. Existing DMs keep their content until an old Choose roles button is clicked, which upgrades that same message. Bot public welcomes default off; exit messages still use the configured channel. `/onboarding setup public_welcome:false` disables bot join welcomes independently of DMs/exits; use `true` to opt in. Native Discord welcomes are unaffected. DMs are attempted once per join, with failures recorded rather than automatically retried. Bots are skipped.

Up to 25 unprivileged automatic roles can be selected by IDs or mentions. `/onboarding autoroles roles:none` clears both the role list and legacy `joinRole`. The bot must have Manage Roles and sit above them; protected, managed and verification roles are not assigned by this workflow. Explicitly configured safe community-role restoration still works on rejoin.

`after_screening:true` is the default: automatic roles and the welcome DM wait for native Rules Screening. A bot public welcome is sent on join only if explicitly enabled with `public_welcome:true`. Without pending screening these happen immediately. Pending members are reconciled after restart. Opting out with `false` permits immediate assignment, so review your role-gating policy first.

Preview is private and does not send a DM. Status shows configuration, Manage Roles, pending screening and recent role/DM failures; `/diagnose` covers channel permissions. Options omitted during setup keep their existing values. Advanced settings, clearing optional channel links and goodbye text remain available through configuration import. Changes do not backfill every existing member.

### Announcements with @everyone

Use `/announce everyone channel:#announcements` to open a builder for an announcement that **pings @everyone**. It accepts a title up to 256 characters and a multiline body up to 4,000 characters. Discord Markdown works: `**bold**`, `*italics*`, headings, lists, links, quotes and code blocks. Submitting the form shows a **private formatted preview** and **Confirm / Cancel**. Confirm sends one announcement with `@everyone` above its embed; cancelling sends nothing. The preview expires after five minutes, and its prompt disappears after selection.

Both the sender and bot need **Mention @everyone, @here, and All Roles** in the destination. The sender also needs **Manage Messages** and the staff allowlist; the bot needs View Channel, Send Messages (or Send Messages in Threads), and Embed Links. These permissions are checked again on confirmation. Discord members' notification preferences still apply.

Optional `mention_user` and `mention_channel` selections work with `{user}` and `{channel}` in the body, just like the normal builder. Only the fixed `@everyone` in message content is allowed to notify; embedded user/role references do not add separate pings. Tags appended by these options can take the final body up to 4,096 characters; overflow is rejected rather than silently cut off.

The normal `/announce builder`, `send`, `schedule`, and `edit` keep notification pings suppressed. The normal builder also supports 4,000-character bodies. Editing an everyone announcement does not re-ping. Scheduling an everyone ping is not included in this command.

Delivery receipts and a message nonce prevent the same confirmation from sending twice. If Discord does not confirm delivery, check the destination before creating another announcement; the bot does not automatically resend a possibly delivered ping. Use `/man command:announce everyone` for detailed help.

### Announcement tags and links

```text
/announce send channel:#announcements title:Welcome! text:Hello {user}! Please read {channel}. mention_user:@Member mention_channel:#rules
/announce builder channel:#announcements mention_user:@Member mention_channel:#rules
```

Select actual entries in the **mention_user** and **mention_channel** pickers. In the text/body, `{user}` becomes the selected member tag and `{channel}` becomes the selected channel tag. If a selected placeholder is omitted, that tag is appended below the text. In the builder, choose the references before opening the form, then use these placeholders in its Announcement field. The same options work for send, edit and schedule.

You can also paste native Discord markup into the body: `<@USER_ID>` for a member, `<#CHANNEL_ID>` for a channel, or `<@&ROLE_ID>` for a role. Replace the placeholder with the numeric ID. Plain `@Name` or `#channel-name` typed as text does not identify an account/channel. Discord Markdown and links remain supported. Keep tags in the message body; the embed title is plain text.

Tags are clickable references, while notification pings remain disabled in the ordinary send/builder/schedule/edit commands. Use `/announce everyone` and confirm its preview for an intentional everyone ping. You must be able to view a selected reference channel, and selected users must be current server members. Existing announcements can be corrected with `/announce edit` using their message ID.

### Easter egg

Anyone can use `/easteregg` in a channel where they and the bot can post. It publishes the server's surprise text, with the footer **Mr. Kat · Curiosity rewarded**. There is no command cooldown and mentions do not ping. The community module must be enabled.

The server owner can edit the text without changing code:

```text
/config set key:easterEggText value:"Your interesting message goes here."
```

Confirm the configuration change. The creator credit stays fixed when the text changes.

### Message colors

Log categories have distinct colors. Edits are yellow, deletions red, member joins green and departures orange. Voice logs are purple, administrative logs blue, reports orange, and AutoMod logs fuchsia. Public confessions are pink; review cards and confirmations are yellow. Polls are teal, pending suggestions amber, accepted/implemented suggestions green and declined suggestions red. Announcements have no coloured accent; reminders are purple and Easter eggs gold. Existing messages retain their old color until edited; newly sent messages use the new palette.

### Voice rooms: setup and troubleshooting

Voice room creation requires an existing, permanent voice channel as a lobby and an existing category as the destination. As the server owner, select both using Discord's channel picker:

```text
/voice setup lobby:Create a Room category:Voice Rooms notice_channel:#voice-updates
```

Discord already provides text chat inside voice channels; the bot uses it directly and no longer offers a companion option. Setup validates the bot's server permissions and the lobby/category overrides before saving. The bot requires Manage Channels, Manage Roles (called Manage Permissions in channel settings), Move Members, Send Messages, Embed Links and Read Message History; it also needs View Channel and Connect in the lobby and access to the destination category.

**Leave and rejoin the selected lobby after setup.** Setup does not process members already sitting there. Joining the lobby creates a room and moves you into it; toggling mute/deafen does not trigger creation. Commands such as `/voice rename`, `/voice limit`, and `/voice lock` act on your current managed voice room, not the text channel in which you type them. Only its owner may use owner controls; `/voice claim` is available to another occupant once the owner leaves.

Run `/voice status` to inspect the configured lobby, category, module state, tracked room count, and missing bot permissions. It works even when the voice module is disabled. If the lobby/category is unconfigured or deleted, the status explains what the owner needs to fix. Re-register commands after updating the bot to make this new subcommand available.

Failed creation or movement is reported in the configured admin log and, where DMs are allowed, directly to the affected member. There is no creation cooldown; after a room is cleaned up you may immediately create another. A previously owned room is reused if it still exists; a deleted room is removed from tracking before a replacement is created.

After moving the creator, the bot posts a message in the new voice channel’s **built-in text chat**, tagging only its owner and showing a short card with right-side Rename, Capacity, Lock, Unlock, Permit, Block, Transfer and Claim buttons. Forms and member pickers recheck the current room and ownership on submission. Open the voice channel’s chat bubble to see it. The bot needs Send Messages and Embed Links there. A failed intro does not delete an occupied room. Native chat is visible to members with View Channel, even if they are not connected; locking joins does not make chat private. Blocking a member denies access to both room and chat.

The last person leaving a managed room triggers deletion of that room and its built-in chat. No separate companion is created, even with legacy `voiceCompanion:true`; already-existing companions stay until their tracked room is cleaned up. The bot checks for stale/empty managed rooms again after restart and during maintenance. It does not delete ordinary voice channels through this cleanup.

`notice_channel:#voice-updates` selects a normal text channel for a short creation notice: creator, creation time, room link and the room name in plain text. Room controls appear only in the voice room’s built-in chat. The bot needs Send Messages there. The creation notice remains after the room is deleted; a failed notice does not remove a successfully occupied room. Omitting the option keeps its current setting. To disable notices, remove `voiceNoticeChannel` through configuration import. `/voice status` shows the current notice channel.

### Command reference

| Command                                      | Actions                                                                                                                  | Access                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `/help`, `/man`                              | Private command index, detailed manuals, page navigation, downloadable guides                                            | Members; reading help does not grant execution permissions                                                 |
| `/confess`                                   | Private confession form; reviewed or immediate publication                                                               | Members, after owner setup                                                                                 |
| `/confess-notifications`                     | Enable/mute reply DMs for a root confession                                                                              | Published contributors and native thread members                                                           |
| `/say`                                       | Plain bot-authored channel post or multiline composer                                                                    | Manage Messages + destination access + staff allowlist                                                     |
| `/mentionguard`                              | setup, status, disable; non-deleting support redirects and repeated-ping alerts                                          | Setup/disable: owner; status: Manage Server + allowlist                                                    |
| Message menu → Apps → Moderate with evidence | Private Warn/Kick/Ban picker using the selected message                                                                  | Action-specific moderation permission + staff allowlist                                                    |
| `/dm`                                        | send, reply, template, templates, from-template                                                                          | Manage Server + allowlist; send/from-template require confirmation; reply uses a staff conversation thread |
| `/logs`                                      | setup, status                                                                                                            | Setup: owner; status: Manage Server + allowlist                                                            |
| `/onboarding`                                | setup, message, autoroles, preview, status                                                                               | Server owner                                                                                               |
| `/heartbeat`                                 | setup, status, disable                                                                                                   | Setup/disable: owner; status: Manage Server + staff allowlist                                              |
| `/starboard`                                 | setup, status, refresh, disable                                                                                          | Setup/disable: owner; status/refresh: Manage Messages + allowlist                                          |
| `/easteregg`                                 | Public custom surprise with creator credit                                                                               | Members; text configuration: server owner                                                                  |
| `/text`                                      | Nine text effects, reply shortcuts and Apps → Transform text                                                             | Members who can post; existing messages also require Read Message History                                  |
| `/confession`                                | setup, mode, status, list, review, thread, close, reopen, remove                                                         | Manage Messages + allowlist; setup/mode: server owner; no author lookup                                    |
| `/setup`                                     | Interactive guided setup and owner channel/role pickers; direct private-log shortcut                                     | Owner                                                                                                      |
| `/config`                                    | show, set, log, module, export, import                                                                                   | Owner                                                                                                      |
| `/status`                                    | Connection latency, uptime, enabled modules                                                                              | Members                                                                                                    |
| `/diagnose`                                  | Interactive per-feature health checks and setup guidance                                                                 | Manage Server + allowlist                                                                                  |
| `/backup`                                    | Backup health, verified creation, local file checks and offline recovery guide                                           | Owner                                                                                                      |
| `/mod`                                       | warn, timeout, untimeout, kick, ban, unban, info, cases, note, amend, export, evidence, summary, nickname, bulk-nickname | Action-specific native permission + allowlist                                                              |
| `/warnings`                                  | list, status, revoke, configure; counts and paginated history                                                            | Members: own list; staff: other histories/revoke/status; configuration: owner                              |
| `/purge`                                     | Filtered, confirmed deletion of selected messages                                                                        | Manage Messages in target channel + allowlist                                                              |
| `/role`                                      | add, remove, temporary, menu, bulk                                                                                       | Manage Roles + hierarchy + allowlist                                                                       |
| `/voice`                                     | status, setup, rename, limit, lock, unlock, permit, block, transfer, claim, panel, move                                  | Status: members; room controls: owner; setup: server owner; move: Move Members + hierarchy                 |
| `/automod`                                   | status, show, panel, configure, mode, keyword, mentions, list, toggle                                                    | Manage Server + allowlist; panel/configure/mode: owner                                                     |
| `/verify`                                    | panel, approve, deny, pending                                                                                            | Manage Server + allowlist                                                                                  |
| `/ticket`                                    | panel, open, claim, close, reopen, transcript, delete                                                                    | Open: members; close: ticket owner/staff; other management: staff                                          |
| `/report`                                    | Submit private member report                                                                                             | Members; no command cooldown                                                                               |
| Message menu → Apps → Report message         | Report a message with available evidence                                                                                 | Members; no command cooldown                                                                               |
| `/appeal`                                    | Appeal own retained moderation case                                                                                      | Members with server access                                                                                 |
| `/review`                                    | List or resolve reports/appeals                                                                                          | Moderate Members + allowlist                                                                               |
| `/announce`                                  | send, schedule, edit, builder, everyone                                                                                  | Manage Messages + destination access + allowlist; everyone also needs Mention Everyone                     |
| `/tag`                                       | set, get, list, delete                                                                                                   | Get/list: members; management: Manage Messages + allowlist                                                 |
| `/sticky`                                    | set, remove                                                                                                              | Manage Messages in channel + allowlist                                                                     |
| `/poll`                                      | create, close, results; buttons record votes                                                                             | Create: members who can post; close: creator or authorized staff; results/voting: members with access      |
| `/suggest`                                   | setup, create, status                                                                                                    | Setup: owner; create: members; status: Manage Messages + allowlist                                         |
| `/remind`                                    | Personal DM reminder                                                                                                     | Members; maximum 20 pending                                                                                |
| `/event`                                     | Scheduled channel reminder                                                                                               | Manage Messages + destination access + allowlist                                                           |
| `/channel`                                   | temporary, lock, unlock, slowmode, archive, unarchive, inspect, snapshot                                                 | Manage Channels + allowlist                                                                                |
| `/panic`                                     | on, off with confirmation                                                                                                | Manage Server and Manage Channels in selected channels + allowlist                                         |
| `/stats`                                     | Aggregate server metrics                                                                                                 | Moderate Members + allowlist                                                                               |
| `/activity`                                  | Previously observed members past a chosen activity cutoff                                                                | Moderate Members + allowlist                                                                               |
| `/jobs`                                      | list, show, cancel                                                                                                       | Own jobs; Manage Server staff can inspect all                                                              |

## Examples

**Member polls:** anyone who can post in a channel can use `/poll create question:Game night? choices:Friday | Saturday duration:1d`. Choose 2–5 options separated by `|`; vote using the numbered buttons. The creator can `/poll close id:POLL_ID`, and authorized staff with Manage Messages can close other people's polls. `/poll results id:POLL_ID` shows current results. Closing and viewing results require access to the original channel. Polls also close automatically after their duration; up to 25 can be active per server. The staff allowlist does not restrict member poll creation.

```text
/mod warn member:@Member reason:Repeated unsolicited advertising expires:30d
/mod timeout member:@Member duration:30m reason:Continued disruption
/mod ban member:@Member reason:Repeated harassment duration:7d
/mod cases member:@Member
/mod nickname member:@Member name:Community Member reason:Requested change
/mod bulk-nickname members:ID1,ID2 template:{name} reason:Nickname reset

/purge count:50 scan:300 member:@Member filter:links
/purge count:20 contains:unwanted text older:true

/role temporary member:@Member role:@Event duration:2d reason:Event access
/role bulk role:@Event members:ID1,ID2 action:add reason:Event attendees
/voice setup lobby:Join to create category:Community rooms
/voice permit member:@Friend

/announce schedule channel:#announcements title:Game night text:Starting soon! in:2h
/poll create question:Which game? choices:Game A | Game B | Game C duration:1d anonymous:true
/remind in:2h text:Check the event schedule

/panic on channels:CHANNEL_ID_1,CHANNEL_ID_2
/panic off
```

Durations use a positive integer with `s`, `m`, `h`, `d`, or `w`, with a minimum of 10 seconds. The general maximum is 365 days; Discord timeouts are limited to 28 days.

The role menu treats its selection as the desired set of roles for that panel. Unselected roles from that panel are removed. Exclusive groups and prerequisite rules are checked before changes. Publishing a new panel is recommended after changing its role allowlist.

Ticket closure hides the retained channel from its creator; only staff can reopen it. The creator receives a closure DM with their request and transcript when delivery succeeds; manual transcript exports are staff-only. A member with closed tickets can create a new ticket immediately. One open ticket per member and the 50-open-ticket server cap remain.

Enabling `secondApproval` requires a different authorized staff member to approve kicks/bans within ten minutes in the moderation log channel. Both staff members' current authority is rechecked. The original confirmation and final approval do not bypass hierarchy.

Accepting an appeal for a warning revokes that warning and removes it from active escalation counts while retaining its original case. For other case types staff explicitly change punishment; previous timeouts/kicks are not automatically undone.

Scheduled jobs recheck relevant permissions, and safety cleanup (for example temporary-role expiry) may continue after a feature is disabled. Keep required bot permissions until pending cleanup finishes.
