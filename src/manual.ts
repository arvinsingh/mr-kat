import {
  ApplicationCommandOptionType as T,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type APIApplicationCommandOption,
} from 'discord.js';
import { commands } from './commands.js';
import { responsePolicies } from './response-policy.js';

export type Audience = 'members' | 'moderators' | 'owners';
export interface Topic {
  path: string;
  description: string;
  audience: Audience;
  access: string;
  options: APIApplicationCommandOption[];
  subcommands: string[];
}
interface Overview {
  purpose: string;
  examples: string[];
  notes: string[];
}
const overviews: Record<string, Overview> = {
  warnings: {
    purpose:
      'Use a guided private dashboard to inspect warnings, revoke invalid cases and configure automatic escalation.',
    examples: [
      '/warnings panel',
      '/warnings list',
      '/warnings list member:@Member',
      '/warnings revoke case:12 reason:Appeal accepted',
      '/warnings configure threshold:3 action:kick',
      '/warnings status',
    ],
    notes: [
      'Members can inspect only their own warnings. Staff with Moderate Members and staff allowlist access can inspect others or revoke a warning. /warnings panel and list open the same private dashboard: staff get a member picker, everyone can select a warning to read its full reason, and authorized staff get Revoke with a private reason form. Previous/Next/Refresh browse history; long details have separate page buttons. Ordinary members cannot inspect others or revoke warnings. Active, expired, revoked and total retained counts are distinct; only active warnings count toward escalation. Original cases are never erased by revocation.',
      'The owner sees Warning policy: action and threshold dropdowns, a Timeout duration form, saved settings and bot permission checks. These edits are drafts; Review changes opens a separate Confirm/Cancel prompt, preserving the dashboard. Reload saved policy discards the draft. Stale previews cannot overwrite a newer policy. The configure command remains an alternative and also opens confirmation. Choose none, timeout or kick; threshold 0 disables automatic action. Timeout duration is configurable. Existing warningThreshold configurations retain timeout behavior until changed. Changes apply on future warnings, not retroactively. Bot permissions, hierarchy and protected members still apply. Automatic kicks respect secondApproval and revalidate warnings/policy after DMs and at approval. Failed or uncertain enforcement does not erase the warning or automatically replay removal.',
      'Accepting an appeal for a warning revokes it and reduces the active count. /warnings revoke does the same directly and notifies the member without staff identity. Revoking a warning does not undo a historical timeout or rejoin a kicked member. Kicked users cannot invoke server commands until they rejoin; use an outside-server contact route for those appeals. Counts cover retained database history, not records already deleted by retentionDays. Panels expire in ten minutes and forms in five; actor, channel, selected member/case and current permissions are rechecked. Submitted forms cannot be reused.',
    ],
  },
  say: {
    purpose:
      'Send a plain bot-authored message into an accessible server channel, without exposing the requesting staff member.',
    examples: ['/say channel:#general message:Welcome everyone!', '/say channel:#general'],
    notes: [
      'Staff need Manage Messages and the staff allowlist, plus permission to post in the destination. The bot must also be able to post. Omit message to open a multiline composer (2,000 characters). Markdown and native references display normally; mention notifications are suppressed, including everyone/here.',
      'Messages are permanent channel posts; acknowledgements are private. Actor/destination are recorded privately; the audit receipt does not copy the body. Uncertain delivery is not retried automatically.',
    ],
  },
  mentionguard: {
    purpose:
      'Redirect protected-role mentions to support and alert staff about repeated role pings, without deleting the original message.',
    examples: [
      '/mentionguard setup roles:ROLE_ID_1,ROLE_ID_2 support_channel:#support limit:3 seconds:30',
      '/mentionguard status',
      '/mentionguard disable',
    ],
    notes: [
      'Owner-only setup/disable; status requires Manage Server and the staff allowlist. The automod module must be enabled. Role IDs/mentions choose protected roles. Omit channel for server-wide monitoring; supplying channel restricts monitoring to it and its threads. support_channel independently selects the support redirect destination; omitting it preserves any previously configured support link, otherwise replies suggest /ticket open. Existing configurations keep their server-wide scope. The default alert threshold is three role-mention messages in 30 seconds across channels, or three distinct roles in one message. Administrator accounts and configured exemptRoles are exempt.',
      'Deleting a message cannot retract delivered notifications. This redirect guard never deletes messages or cancels pings. For prevention, make roles unmentionable and restrict Mention Everyone/All Roles, or configure a native per-message rule with /automod mentions. Existing independent AutoMod rules may still moderate messages.',
      'Owner can edit roleMentions.exemptRoles and responses using configuration export/import. Automatic replies are bounded to one per sender per 15 seconds to avoid bot floods; commands have no waiting-period cooldown. Support-channel links are shown only to members who can access the destination. Incident records follow retentionDays.',
    ],
  },
  uwulock: {
    purpose:
      'Temporarily transform a selected member’s new messages server-wide, or in one selected channel, using a webhook with their display name/avatar.',
    examples: [
      '/uwulock panel',
      '/uwulock add member:@Friend duration:10m',
      '/uwulock add member:@Friend duration:10m channel:#fun',
      '/uwulock remove member:@Friend',
      '/uwulock remove member:@Friend channel:#fun',
      '/uwulock list',
      '/uwulock stats',
      '/uwulock clear',
    ],
    notes: [
      'STAFF: Manage Messages plus the staff allowlist; channel actions recheck View Channel and Manage Messages there. Both the staff and bot role must be above the target. Bots, administrators, server owner and protected roles cannot be targeted. Clear additionally needs Manage Server and confirmation. A changed/new lock after the clear preview is kept.',
      'TIMING AND SCOPE: default duration 10 minutes; range 10 seconds–1 day. OMIT channel for a server-wide member lock across accessible supported channels and public threads. SUPPLY channel to limit it to that channel; a parent-only lock does not cover its threads. Global locks skip destinations where the target, applying staff or bot lack required permissions and still respect protected destinations, exclusions and uwuLock.channels. At most 100 active scope/member locks. Existing channel-only locks keep their scope. If both scopes exist, the active channel-specific lock takes precedence; after it expires, the global lock still applies. Expiry stops conversion immediately; admin expiry notices follow within about 30 seconds while online, or on restart. Locks/statistics survive restarts and are included in backups.',
      'UNLOCK: /uwulock remove member:@Friend with no channel removes ALL this member’s server-wide and channel locks. Adding channel removes only that channel-specific lock; if a server-wide lock remains, the reply warns that it still applies. There is no per-channel exemption from a global lock. Remove the global/member locks first and create channel-only locks if narrower coverage is needed.',
      'PANEL: open /uwulock panel, choose scope (Server-wide by default, or This channel only), member and duration, then Start / replace lock or Unlock member. Server-wide Unlock removes every lock for that member. Existing already-open channel-only panels preserve their scope. Selections are private and create no change receipt. Applying/removing a lock consumes the controls and records a lasting staff receipt. Panels expire in ten minutes; only their opener can use them. List labels each scope and shows expiry/applying staff, attaching the full list if more than ten locks. Stats counts confirmed successful replacements only.',
      'BOT PERMISSIONS: View Channel, Send Messages (Send Messages in Threads), Read Message History, Manage Messages, Manage Webhooks and Attach Files. One bot-owned webhook is reused per parent channel. New webhooks may appear in administrative webhook-change logs. No new credentials, Python runtime, paid API or hosting service is needed.',
      'CHANNELS: ordinary text/announcement channels and active unlocked public threads with text/announcement parents. Introductions and welcome/leave chat channels are eligible; the bot’s own posts are ignored. Skip private threads, forum posts, voice chat, tickets/ticket category, confession/review channels and their threads, log destinations, starboard, heartbeat, rules, active self-role selection channels, and excluded channels/parents. Panel and add errors name the exact restriction, including disabled settings and allowlist failures. The community module and uwuLock.enabled must be on. Owner can further restrict channels with /config set key:uwuLock value:{"enabled":true,"channels":["CHANNEL_ID"]}, then confirm. An empty list permits otherwise eligible channels but never creates a lock by itself. Disable with {"enabled":false}; old posts remain editable/deletable while their records exist.',
      'BEHAVIOR: new ordinary human text messages only. Existing messages and later edits of unconverted originals are not processed. Bot/webhook/system posts, !-prefixed shortcuts, pinned messages, posts with attached threads, polls, stickers, forwards and attachment-only messages are left untouched. AutoMod checks human input before conversion; flagged messages are not converted. Current applying-staff authorization, hierarchy, channel permissions, exclusions and expiry are rechecked before replacement/deletion, so changing roles or access stops that lock from acting.',
      'DELIVERY: confirm the replacement before deleting the original. Preserve attachments, filenames, spoiler markers and descriptions up to a total 10 MiB; larger/failed downloads leave the original. Maximum ten attachments including any generated text file. Text over 2,000 characters is attached in full, never truncated. Links/code/mentions/custom emojis/timestamps are protected; notification mentions and link previews are suppressed. No command cooldown is added. Concurrent work is bounded; excess messages are left untouched.',
      'LOGS AND LIMITS: one explicit transformation entry contains original/full transformed text, author, channel, applying staff and replacement link, without a duplicate ordinary deletion event. Failed or uncertain deliveries are reported for staff review and never blindly retried. A replacement gets a new ID and APP badge. Original reactions/reply links do not move; replies receive a link to the referenced message. Unlocking affects future messages and cannot restore deleted originals. Messages sent while offline remain unchanged.',
      'AUTHOR CONTROLS: right-click/long-press your replacement → Apps → Edit transformed message (private form, up to 4,000 characters) or Delete transformed message. No Manage Messages permission is needed for your own replacement, including after unlock. Original attachments are retained on edit; the generated long-text attachment is replaced as needed. The bot requires its original webhook to remain accessible. Forms expire in five minutes, reject stale revisions, and check access/ownership again when submitted. Bot AutoMod invite/domain/mention checks apply to submitted edits; native Discord AutoMod does not inspect the edit form as a normal member chat message. Author edits/deletions have explicit message logs.',
      'RETENTION: ownership links and the last submitted source text for edit forms are stored internally for retentionDays, and removed earlier when deleted through the author action. After retention, staff can still delete a post normally, but its author menu can no longer identify it. Backups include these records. The text-only /text commands continue to leave their originals unchanged.',
    ],
  },
  text: {
    purpose:
      'Transform your text or an existing message into a lasting plain-text bot post in the same channel.',
    examples: [
      '/text uwuify text:Hello friend! exclamations:true',
      '/text emojify text:Pizza and games tonight density:60',
      '/text faces text:Good morning density:50',
      '/text clap text:Please read the rules',
      '/text leetspeak text:Hello',
      '/text morse text:hello decode:false',
      '/text morse text:.... . .-.. .-.. --- decode:true',
      '/text reverse text:Hello 👋',
      '/text zalgo text:Hello intensity:low',
      '/text unzalgo text:PASTE_GLITCHED_TEXT',
      '/text uwuify message:https://discord.com/channels/SERVER_ID/CHANNEL_ID/MESSAGE_ID',
    ],
    notes: [
      'THREE WAYS: supply text with /text; reply to a message with !uwu or another exact effect command; or right-click/long-press a message → Apps → Transform text and choose an effect from the private menu. No copy/paste is needed for reply or message-menu use. Selecting Reply before a SLASH command does not attach a source; use !uwu or the message link option instead.',
      'Available effects: uwuify (word substitutions, optional expressive punctuation), emojify (original local word-to-emoji vocabulary), faces (random faces), clap (spaces → 👏), leetspeak (number substitutions), morse (encode/decode), reverse (whole visible characters), zalgo (combining marks), and unzalgo (remove combining marks). All run locally with no paid API or extra credentials.',
      'REPLY COMMANDS: !uwu / !uwuify, !emojify, !faces, !clap, !leet / !leetspeak, !morse, !reverse, !zalgo, !unzalgo. Optional reply arguments: !emojify 60, !faces 30, !zalgo low (or medium/high), !morse decode. Send only that command as a Discord reply. Commands are case-insensitive. The triggering reply remains in chat.',
      'POSTING AND PRIVACY: members and the bot need View Channel and Send Messages (Send Messages in Threads for active unlocked threads). Transforming an existing message also requires both to have Read Message History. Message links must target this same server AND channel; private sources cannot be copied to another channel. The source is fetched again when used, so deleted messages fail and recent edits are respected. No attachments or embed text are converted.',
      'OUTPUT: results are normal lasting text messages with all notification mentions and link previews suppressed; they are not embeds and do not alter the source. Results exceeding 2,000 characters are attached as a complete UTF-8 .txt file, requiring the bot’s Attach Files permission. Slash/menu acknowledgements and errors remain private. Reply-command errors, where a channel is available, are ordinary messages. No command cooldown is imposed; AutoMod and Discord rate limits still apply.',
      'INPUT AND OPTIONS: supply exactly one of text or message, up to 4,000 characters. Density is 1–100, default 100 for emojify and 50 for faces. Zalgo intensity is low/medium/high, default medium, and output growth is bounded. The menu uses default options and expires in five minutes; only its opener can use it. Its controls are consumed before publication, preventing a stale menu from reposting after uncertain delivery.',
      'TEXT DETAILS: prose effects preserve URLs, code spans/blocks and Discord mention/custom-emoji tokens. Reverse acts on complete visible characters across the input. Morse accepts A–Z/numbers/spaces; / separates words and whitespace separates Morse letters. Unsupported text or unknown Morse sequences is rejected rather than discarded. Unzalgo removes U+0300–U+036F/U+0489 combining marks, including decomposed accents; precomposed accented letters stay intact. Emojify matches a curated English vocabulary and leaves unmatched words alone.',
      'OWNER SETUP: enabled by default with the community module. /config set key:textEffects value:{"enabled":true,"channels":["CHANNEL_ID"]}, then confirm, restricts it to selected text channels (their threads are included). An empty channels array allows all otherwise eligible channels. excludedChannels still applies, including excluded parent channels. Disable with {"enabled":false}. Preserve other nested values when replacing this setting; omitted fields use defaults.',
    ],
  },
  heartbeat: {
    purpose:
      'Post normal status messages at a configured interval so members/staff can see the bot is running.',
    examples: [
      '/heartbeat setup channel:#bot-status minutes:5',
      '/heartbeat status',
      '/heartbeat disable',
    ],
    notes: [
      'Setup/disable require the server owner. Status requires Manage Server and the staff allowlist. The bot needs View Channel, Send Messages and Embed Links in a normal text channel.',
      'Intervals are 1–1440 minutes, default 5. The first post follows shortly after setup. Each post remains in the channel; disable keeps earlier messages. An offline bot cannot post an offline alert.',
      'The last attempt is saved before sending. Restarts do not replay missed intervals or retry uncertain sends immediately. Failed delivery is visible in status/host logs and the next interval tries again. No external service or paid API is used.',
    ],
  },
  changes: {
    purpose:
      'Staff read retained receipts for successful moderation, configuration and other administrative changes, even after dismissing their private acknowledgement.',
    examples: ['/changes', '/changes limit:20'],
    notes: [
      'Requires Manage Server and the staff allowlist. Receipts are stored for retentionDays and copied to the configured admin log even when event logging is disabled. Configure that private channel with /setup or /config log. Command arguments, file contents, DM bodies and anonymous submission identities are not copied. Confirmation previews and cancelled actions create no receipt. Existing public posts, private reports and tickets keep their own records.',
    ],
  },
  starboard: {
    purpose:
      'Copy community messages into a shared highlight channel when they receive enough ⭐ reactions. The default threshold is one person.',
    examples: [
      '/starboard setup channel:#starboard threshold:1',
      '/starboard setup channel:#starboard threshold:3 self_stars:false',
      '/starboard status',
      '/starboard refresh channel:#general message:MESSAGE_ID',
      '/starboard disable',
    ],
    notes: [
      'Setup/disable are owner-only; status/refresh require Manage Messages and the staff allowlist. The community module must be enabled. The bot needs View Channel and Read Message History on sources, plus Send Messages and Embed Links in the board. Guild Message Reactions is enabled in code; no extra privileged Developer Portal switch is needed.',
      'Counts unique human accounts, ignores bot stars, and optionally excludes the original author. Default self_stars:true counts the author too. Uses the Unicode ⭐ emoji, not a custom emoji. Further stars update the existing copy; falling below threshold removes it. Source edits update the copy, and source deletion removes it even when starboard is disabled.',
      'Sources must allow @everyone View Channel and Read Message History. Public threads inherit this check from their parent; private threads, bot/webhook posts, logs, exclusions, confession channels and the board itself are skipped. NSFW sources are copied only into an NSFW board. Content and non-spoiler attachments are shown with the author and a View original button, without notification pings.',
      'New reaction events are watched, including uncached older messages. No server-wide history scan runs on enable or restart. Refresh one message to recover missed events or recalculate after changing the threshold. Disable keeps existing copies. Changing the destination affects new entries; existing copies stay in their original channel. Replies and rich embed previews are not copied.',
      'Delivery receipts persist across restarts to avoid duplicates. If a send is uncertain, automatic reposting stops; refresh tries to recover its receipt from the last 100 board posts. Status reports unresolved deliveries. Do not manually delete database receipts without checking for an existing copy.',
    ],
  },
  help: {
    purpose:
      'Read private, paginated help without posting messages to the channel. Choose a full command path for a manual page, or an audience to browse.',
    examples: [
      '/help',
      '/help audience:moderators',
      '/help command:voice setup',
      '/help guide:members',
    ],
    notes: [
      'Previous/Next buttons update your private help message.',
      'The manual describes permissions; it never grants them. Download channel-ready guides with the guide option.',
      'Explicitly mention @mr-kat in a server message for a random witty response tagging you, followed by /help and an accessible configured commands-channel link. Replies are lasting plain text. Automatic reply pings, bots/webhooks, excluded channels and AutoMod-flagged input do not trigger them. The messages module and mentionReplies.enabled must be on. No command cooldown or paid API is used.',
    ],
  },
  man: {
    purpose: 'Alias for the detailed command manual, like a man page.',
    examples: ['/man command:voice setup', '/man command:mod timeout'],
    notes: ['Include the subcommand name for its exact arguments and audience.'],
  },
  setup: {
    purpose:
      'Owner opens interactive guided setup and feature health checks, or assigns private log destinations.',
    examples: ['/setup', '/setup feature:voice', '/setup logs:#staff-bot-logs'],
    notes: [
      'Without logs, opens a private feature selector with status counts, Previous/Next, Refresh and Setup steps. Checks effective channel overrides, channel types, role safety/hierarchy, configured destinations, module switches, jobs and backup metadata. Intentionally disabled features are marked off, not broken. Developer Portal toggles, actual DM delivery and arbitrary member-role combinations cannot all be proven automatically; the panel explains these limits.',
      'Owners can choose existing channels/roles through native pickers. Selecting a value opens a preview; only Confirm saves it. Changing a setting keeps unrelated concurrent changes, rejects a stale preview of the same setting, rechecks current permissions and leaves a lasting admin receipt. No channels/roles/permissions are created or granted. Staff can inspect with /diagnose but cannot use owner settings.',
      'Pickers cover staff/self/join/verification roles, private logs, voice lobby/category/notices, support category, onboarding links, commands-channel link, starboard and heartbeat destinations. Choosing a destination does not silently enable a feature; follow its Setup steps. Confession mode/privacy must be chosen explicitly through /confession setup.',
      'logs:#staff-bot-logs remains the direct owner shortcut and replaces ALL log destinations. The bot must have the needed channel permissions, @everyone must lack access, and ordinary member-role access must be removed. Use /config log for separate log categories. /setup without arguments only inspects and creates no change receipt.',
    ],
  },
  config: {
    purpose:
      'Owner-only server configuration, module switches, and validated settings import/export.',
    examples: [
      '/config export',
      '/config module name:voice state:on',
      '/config set key:selfRoles value:["ROLE_ID"]',
      '/config set key:mentionReplies value:{"enabled":true,"commandsChannel":"CHANNEL_ID"}',
    ],
    notes: [
      'Values for set must be valid JSON, including quotes around string IDs.',
      'set/import require confirmation. Exported IDs must exist in this server; bot authority is checked.',
      'staffRoles is an additional allowlist, not a source of Discord permissions.',
      'Mention replies default on with 36 built-in lines. Set mentionReplies to {"enabled":true,"commandsChannel":"CHANNEL_ID"} to add a normal text commands-channel destination, or {"enabled":false} to disable the feature. Replace CHANNEL_ID with its numeric ID and confirm. The messages module also controls this feature. A missing or inaccessible destination falls back to /help.',
      'Edit mentionReplies.responses through /config export/import or /config set: {"enabled":true,"commandsChannel":"CHANNEL_ID","responses":["Your first line","Your second line"]}. Supply 1–50 nonempty lines, at most 250 characters each. Omitted nested fields use defaults, so preserve the other values when replacing mentionReplies. Text is used literally; the bot adds the sender mention and help footer. Only the sender can be pinged. Consecutive responses differ when multiple distinct lines exist; this memory resets on restart.',
      'Owner setup: /config set key:staffRoles value:["MOD_ROLE_ID","ADMIN_ROLE_ID"], then confirm. Use actual numeric role IDs, not names. Include every trusted admin/mod role; an empty list allows anyone with the native permission. Non-owner administrators must also be listed. Set matching command visibility under Server Settings → Integrations → this bot. Keep mixed member commands such as voice/ticket available to members; restricted subcommands still enforce staff checks.',
      "staffRoles selects trusted command users; protectedRoles prevents moderation/role management of sensitive roles or their holders. joinRoles grants ordinary roles automatically. selfRoles is only for this bot's optional role menu; native Channels & Roles does not use that list. restoreRoles is the explicit community-role list eligible for restoration on rejoin.",
    ],
  },
  status: {
    purpose: 'Show the bot connection, uptime and enabled modules.',
    examples: ['/status'],
    notes: ['Use /voice status or /automod status for feature-specific diagnosis.'],
  },
  diagnose: {
    purpose: 'Interactive, private per-feature setup and health checks with actionable fixes.',
    examples: [
      '/diagnose',
      '/diagnose feature:logging',
      '/diagnose feature:voice',
      '/diagnose feature:backups',
    ],
    notes: [
      'Requires Manage Server plus the staff allowlist. Feature dropdowns, page buttons, Refresh and Setup steps update the same private message. Owner-only pickers lead to confirmed setting changes; other staff get inspection and guidance only.',
      'Checks logging, moderation, roles, voice, tickets, onboarding, confessions, community features, automation and backups. Missing optional setup is a review warning; disabled modules are off. Channel type/access checks and automatic-role hierarchy identify concrete blockers. Failed jobs and stale/failed backup metadata are surfaced.',
      'Channel overrides can still restrict actions. Administrator bypasses channel overrides but does not bypass role hierarchy.',
      'Requested client intents are checked. Developer Portal toggles/approval and successful real-world onboarding/DM flows still require verification in Discord. Health checks do not automatically grant access or modify settings. Private diagnostics are dismissible and create no change receipt.',
    ],
  },
  mod: {
    purpose:
      'Staff moderation, case history and private notes. Every member action checks your authority and the bot hierarchy.',
    examples: [
      '/mod warn member:@Member reason:Repeated spam expires:30d',
      '/mod timeout member:@Member duration:30m reason:Disruption',
      '/mod cases member:@Member',
    ],
    notes: [
      'MESSAGE EVIDENCE: /mod warn, kick or ban accepts optional evidence:MESSAGE_LINK (or a message ID from the current channel). Apps → Moderate with evidence opens a private action picker and reason form. Message text, author, timestamps and attachment references are retained with the case; no screenshot/file-upload workflow is required. /mod evidence case:NUMBER exports retained evidence privately. Source permissions, staff roles and action-specific hierarchy are checked. Public reply shortcuts are not added because they reveal who typed them.',
      'PRIVACY: public moderation notices and moderation DMs show the action, target, reason and case without naming the requesting/approving staff member. Private case/audit records retain actor and approval metadata. Discord native audit logs remain visible to authorized administrators.',
      'Warn records a case and attempts a DM; the warning remains recorded if DMs fail. Expiry affects active-warning counts.',
      'Warnings, timeouts and timeout removals attempt a one-way DM with reason/case details. Kick/ban notices are attempted after approval, before removal; they say removal will be attempted next. Failed DMs do not cancel punishment. Delivery status appears in the response and staff log.',
      'Successful member actions also post a normal message in the original command channel with case, member, time and reason; actor identities remain private. Two-person approval preserves that original channel. Use a staff channel if the reason is sensitive. Notes/case exports remain private. A failed channel notice is reported without reversing the completed action. Unbans also attempt a DM.',
      'Timeout maximum: 28 days. Kick/ban require confirmation; optional secondApproval requires another authorized staff member.',
      'Temporary bans use scheduled unbans; externally changed bans are not blindly removed.',
      'Notes, cases, corrections and exports are staff-only. Corrections append rather than erase history.',
      'Bulk nickname changes accept 1–25 selected member IDs. {name} and {index} are supported; generated names are capped at 32 characters.',
    ],
  },
  purge: {
    purpose: 'Preview a bounded search, then delete matched message IDs after confirmation.',
    examples: [
      '/purge count:20 scan:200 member:@Member',
      '/purge count:10 filter:links',
      '/purge count:10 contains:unwanted older:true',
    ],
    notes: [
      'COMPLETE OPERATION LOG: content is persisted before deletion and Message purge logs display the requester, channel (with plain name), link to the moderation purge record, and username/text entries directly in bot messages. Overflow becomes numbered message pages; no downloadable transcript is sent. Failed/uncertain attempts are separated from confirmed deletions. Missing/pinned/unsupported-old messages are skipped, not claimed as deleted. Captured text survives cache eviction, bulk gateway events and interrupted jobs. Evidence follows retentionDays; original attachment links may expire. Do not confuse this operation transcript with general deletion events, which cannot recover content never cached/stored before deletion.',
      'Pinned messages are excluded. Scan and deletion counts are capped at 1000.',
      'Recent messages use bulk deletion in batches of 2–100. Singletons use one deletion. Messages near/over two weeks old are skipped unless older:true, then deleted individually because Discord forbids bulk deletion for them. Pins, permissions, module state and cancellation are checked during execution. A failed bulk request is recorded, not retried individually. Deletions cannot be undone.',
      'Use /jobs show for counts and failures, or /jobs cancel to stop remaining work.',
      'Optional reason is shown in the confirmation and recorded with the job and complete operation transcript. Message IDs, actor, source channel, time, full available pre-delete text and attachment references are captured before each eligible deletion request. Known purge deletions suppress duplicate generic gateway logs. Log destinations/excluded channels do not have their contents recopied; the moderation summary still records outcomes.',
      'Pins/content are fetched fresh rather than trusting stale cache. Logs survive cache eviction because the purge captures the fetched messages before deleting them. Full text appears directly in numbered bot-message pages for the whole operation, without a text attachment. Cancellation and permission/error stops also produce a final summary with processed/remaining counts.',
      'Deletion-acknowledged, skipped, failed/rejected and uncertain outcomes are separate. A timeout or interrupted request can already have deleted messages; uncertain batches are never automatically replayed. Recovery skips an in-flight batch and marks it uncertain. Gateway deduplication markers contain metadata only and expire after one day; they do not retain full message bodies in the database.',
    ],
  },
  role: {
    purpose: 'Staff role assignment, temporary roles, batch changes and member role panels.',
    examples: [
      '/role temporary member:@Member role:@Event duration:2d reason:Event access',
      '/role menu channel:#roles',
      '/role bulk role:@Event members:ID1,ID2 action:add reason:Event',
    ],
    notes: [
      'Self-service menus are configured with selfRoles. Normal members use the menu, not /role add.',
      'Menus apply the selected set, removing unselected roles from that panel. Exclusive groups and prerequisites apply.',
      'Automated roles must be unprivileged and below the bot. Temporary roles expire after restarts too.',
      'A self-service menu is a bot message with a dropdown for optional roles such as Gaming or Event notifications. It does not create roles or grant staff permissions. If you already use Discord Channels & Roles, you can skip selfRoles and /role menu. Do not manage the same role selection with both systems.',
    ],
  },
  voice: {
    purpose:
      'Create a temporary voice room by joining a configured lobby. Controls act on the managed room you are currently connected to.',
    examples: [
      '/voice status',
      '/voice setup lobby:Create a Room category:Voice Rooms notice_channel:#voice-updates',
      '/voice rename name:Gaming',
      '/voice limit count:5',
      '/voice permit member:@Friend',
    ],
    notes: [
      'OWNER SETUP: Create a permanent voice lobby and a category in Discord; select them with /voice setup. Then leave and rejoin that lobby.',
      'MEMBER USE: Joining the lobby creates your room and moves you into it. You own it; no Manage Channels permission is required for your own room controls.',
      'lock restricts new joins; it does not disconnect current occupants. permit allows a selected member; block disconnects and blocks that member from this room and its chat, not the server. Native chat visibility follows View Channel, so locking new joins does not make chat private.',
      'transfer requires the new owner to be in the room. claim requires the existing owner to have left. Staff/protected members cannot be blocked.',
      'Discord voice channels already include text chat. New rooms get one tagged owner message in that chat with commands and Lock/Unlock/Claim buttons. No separate companion channel is created, even with an older voiceCompanion:true export. The last person leaving deletes the room and its built-in chat; any legacy tracked companion is cleaned up at that time too. Ordinary voice channels are not cleaned up.',
      'One owned room per member, 30 tracked rooms total, with no command creation cooldown. An existing owned room is reused.',
      'notice_channel selects a normal text channel for lasting creation messages: creator, creation time, room link, cleanup behavior and member controls. These messages remain after room deletion. Give the bot Send Messages and Embed Links there. Clear voiceNoticeChannel through configuration import to disable notices. Omitted notice_channel keeps its current value.',
      'panel shows private Lock/Unlock/Claim buttons. move is a separate staff action with native permissions and hierarchy checks.',
      'If nothing happens: /voice status, check View Channel/Connect/Manage Channels/Manage Roles/Move Members/Send Messages/Embed Links/Read Message History, and leave/rejoin. Mute/deafen changes do not count as a join.',
    ],
  },
  automod: {
    purpose:
      'Diagnose and configure two separate systems: the online bot spam detector and native Discord AutoMod rules.',
    examples: [
      '/automod status',
      '/automod configure mode:report messages:7 seconds:8 repeats:4',
      '/automod panel',
      '/automod keyword name:Advertising words:badword,anotherword',
      '/automod mentions limit:5',
    ],
    notes: [
      'A checkbox grants permission or enables a rule; it does not by itself create a bot rule. The bot needs Manage Server for native rules.',
      'The bot detector starts in report mode: it logs detections without deleting/timeouts. Owner controls mode/configure and the panel buttons.',
      'Native keyword/mention rules block before posting and remain active when the bot is offline. /automod list shows their actual enabled state.',
      'Discord exempts Administrator and Manage Server members from native filters. Test with a normal member; bots and configured exemptions also matter.',
      'Reusing a bot-owned keyword rule name updates it. mentions updates the existing bot-owned rule. Other administrators’ rules are never overwritten.',
      'Discord limits native keyword rules to six and mention-spam rules to one. Use the existing rule rather than creating duplicates.',
      'Bot delete/timeout enforcement needs Manage Messages/Moderate Members and appropriate hierarchy. Excluded channels and protected/exempt roles are skipped.',
    ],
  },
  verify: {
    purpose:
      'Staff publish rules acknowledgement and review optional verification requests. Members use the panel button.',
    examples: [
      '/verify panel channel:#rules rules:Read and accept our server rules.',
      '/verify pending',
      '/verify approve member:@Member',
    ],
    notes: [
      'The owner first creates an ordinary Verified role in Discord, puts it below the bot, and configures /config set key:verifiedRole value:"ROLE_ID", then confirms. The bot needs Manage Roles. Publish /verify panel in an accessible rules channel. Members press I agree to the rules; verificationReview:false (default) grants that role immediately.',
      'For staff approval, set /config set key:verificationReview value:true and confirm. Button clicks queue requests; authorized Manage Server staff use /verify pending, /verify approve member:@Member or /verify deny member:@Member. Approve grants the role; deny clears the request without granting it. Panic mode can pause verification.',
      'The bot assigns the role; it does not automatically hide/unlock channels. To make verification an access gate, configure the relevant category/channel permissions in Discord: deny View Channel to @everyone and allow it for Verified, while keeping #rules and the panel accessible before verification. Use an unprivileged role; never use an admin/staff role as verifiedRole.',
      'This is separate from Discord native Rules Screening and Channels & Roles. The button either grants verifiedRole immediately or queues a staff decision when verificationReview:true. It does not enable native screening or prove age/identity. If you use native screening, this extra panel is optional; do not publish it just to make welcomes work.',
    ],
  },
  ticket: {
    purpose:
      'Private support tickets with a member, bot and configured staff. One open ticket per member.',
    examples: [
      '/ticket open subject:I need help',
      '/ticket panel channel:#support',
      '/ticket close reason:Resolved',
    ],
    notes: [
      'The owner must configure ticketCategory and staffRoles first. Panels use integrated Discord Components V2 cards with text and buttons. Panel/claim/reopen/transcript are staff workflows; deletion additionally requires Manage Channels and confirmation.',
      'SETUP: create a Discord category called Support Tickets and a public #support channel. As owner: /config set key:ticketCategory value:"CATEGORY_ID", confirm; /config set key:staffRoles value:["MOD_ROLE_ID","ADMIN_ROLE_ID"], confirm; /config module name:tickets state:on. Give the bot Manage Channels, Manage Roles (Manage Permissions), View Channel, Send Messages, Embed Links and Read Message History. Grant support staff Manage Messages and include their role in staffRoles. Then /ticket panel channel:#support title:Contact staff description:Open a private ticket for help. Test the button with an ordinary member.',
      'Each ticket explicitly hides @everyone and allows only its creator, the bot and configured staff roles (Discord administrators can bypass this). If staffRoles is empty, ordinary staff roles will not be added to the ticket. There is no creation cooldown; one open ticket per member and 50 open tickets per server still apply.',
      'Claim assigns the current ticket to a staff member and posts a lasting Ticket claimed message inside that private channel, with their mention and time. Other staff may still help, but cannot claim over them. Repeated claims by the same person do not duplicate the notice. The ticket owner can close their ticket; closure hides it from its creator and staff can reopen it. Assignment is retained on reopen.',
      'Closing removes the creator’s channel access and attempts one DM containing Closed status, the original request, closing reason and a transcript (latest 1000 messages, at most 4 MB). Blocked/failed DMs and transcript failures are recorded for staff and do not undo closing. Staff transcript exports remain private. Attachment links can expire. Only staff can reopen; only closed channels can be deleted, with a fresh confirmation. Reopen/delete buttons survive bot restarts and recheck current permissions and ticket state. Closed channels expire under retention.',
    ],
  },
  report: {
    purpose:
      'Privately report a member to staff. For a specific message use its Apps → Report message action.',
    examples: ['/report member:@Member reason:Harassment in general'],
    notes: [
      'Reports need a configured private reports log. There is no command cooldown. Optional evidence accepts a same-server message link or a message ID from the current channel. Both the reporter and bot need source access. Message text is captured immediately; evidence contains references to original attachments rather than uploaded files.',
      'A reference is returned privately; staff review through /review. Do not post private evidence publicly.',
    ],
  },
  appeal: {
    purpose: 'Ask staff to review your own retained moderation case.',
    examples: ['/appeal case:12 reason:Please review the context'],
    notes: [
      'You must still have server access. Banned members need another agreed submission route.',
      'Accepting a warning appeal revokes that warning and removes it from active escalation counts. For other case types staff explicitly change any punishment separately. Historical kicks/timeouts are not automatically undone.',
    ],
  },
  review: {
    purpose: 'Staff review reports and moderation appeals, then record a decision and reason.',
    examples: [
      '/review list kind:reports',
      '/review resolve kind:appeals id:REFERENCE decision:accepted reason:Reviewed',
    ],
    notes: [
      'Restricted to Moderate Members and the configured staff allowlist. Accepting a warning appeal revokes the warning. Other accepted appeals do not automatically unban, rejoin a kicked member or remove a timeout.',
    ],
  },
  announce: {
    purpose:
      'Staff publish, schedule, build or edit bot-authored announcements in accessible channels.',
    examples: [
      '/announce builder channel:#announcements',
      '/announce everyone channel:#announcements',
      '/announce send channel:#announcements title:Welcome text:Hello {user}! Read {channel}. mention_user:@Member mention_channel:#rules',
      '/announce schedule channel:#announcements title:Game night text:Starting soon in:2h',
    ],
    notes: [
      'builder opens a form; send publishes immediately; schedule uses a durable job. The builder and everyone form accept a title up to 256 characters and a multiline body up to 4000 characters. Selected reference tags may extend the body to 4096 characters; oversized output is rejected instead of truncated.',
      'everyone opens the Markdown-capable builder, then shows a private formatted preview and Confirm/Cancel. Confirm posts @everyone as message content above the announcement embed, notifying the destination audience according to their Discord settings. Cancelling sends nothing. The preview expires after five minutes and its prompt disappears after selection.',
      'everyone requires Manage Messages and Mention Everyone on the sender in the destination, the staff allowlist, and bot permission to Mention Everyone, Embed Links and send there. Authority is checked when opening, previewing and confirming. Revoked permissions or a disabled messages module prevent delivery.',
      'edit accepts a tracked bot announcement ID, never arbitrary member messages.',
      'Scheduled delivery is attempted at most once; inspect /jobs after an interrupted send before rescheduling.',
      'Use mention_user and mention_channel pickers to select a member/channel. Put {user} and {channel} in the announcement body to insert the selected tags there; otherwise selected tags are appended. The builder accepts those selections before opening its form. Missing selections for placeholders produce a clear error.',
      'Actual Discord mention markup such as <@USER_ID>, <#CHANNEL_ID> and <@&ROLE_ID> is preserved in the body. Plain @Name or #name text is not automatically looked up. Use the pickers or native mention markup. Formatting and Markdown links in the body remain supported. Keep tags in the body; the embed title is plain text.',
      'Ordinary send/builder/schedule/edit suppress notification pings. everyone is the explicit opt-in exception and enables only the fixed @everyone in message content; selected user/role references do not add separate pings. Selected members must belong to the server, and the staff member must be able to view a selected channel. All modes preserve the same formatting.',
      'Everyone delivery is attempted once per confirmation with a persisted receipt and nonce. If delivery is uncertain, check the destination before opening a new builder; the old confirmation cannot resend. Editing a tracked everyone announcement does not re-ping. everyone publishes immediately after confirmation; scheduling remains non-pinging.',
    ],
  },
  tag: {
    purpose:
      'Reusable FAQ replies. Members can privately read/list tags; staff create or delete them.',
    examples: [
      '/tag list',
      '/tag get name:rules',
      '/tag set name:rules text:Read the rules channel',
    ],
    notes: ['Names use 1–32 letters, numbers, underscores or hyphens. Replies suppress mentions.'],
  },
  sticky: {
    purpose: 'Staff configure a persistent notice that is refreshed when a text channel is active.',
    examples: ['/sticky set text:Please read the channel rules', '/sticky remove'],
    notes: [
      'Refresh is limited to once per five minutes; the previous bot notice is removed. This is not a timer that posts to inactive channels.',
    ],
  },
  poll: {
    purpose:
      'Members publish polls where they can send messages. Members vote using numbered buttons and can change their vote before closure.',
    examples: [
      '/poll create question:Which game? choices:Game A | Game B duration:1d anonymous:true',
      '/poll results id:POLL_ID',
      '/poll close id:POLL_ID',
    ],
    notes: [
      'Two to five choices separated by |. One current choice per member.',
      'Creating polls needs View Channel and Send Messages (Send Messages in Threads for threads), not moderation permissions or a staff role. The bot needs View Channel, Send Messages and Embed Links. The community module must be enabled. Up to 25 active polls per server; polls close automatically at their chosen duration.',
      'Creators may close their own polls. Closing someone else’s poll requires Manage Messages in its original channel and the staff allowlist. Viewing results or closing requires View Channel and Read Message History in the original channel, even when invoked from elsewhere. Poll IDs are shown after publication. Closure removes voting buttons.',
      'Anonymous polls hide voter names from members, but voter IDs are retained internally to enforce uniqueness.',
    ],
  },
  suggest: {
    purpose: 'Members submit suggestions; staff track decisions with reasons.',
    examples: [
      '/suggest create text:Could we have a game night?',
      '/suggest status id:REFERENCE state:accepted reason:Scheduled',
    ],
    notes: [
      'Suggestions are public in the current channel. States: open, accepted, declined, implemented.',
    ],
  },
  remind: {
    purpose: 'Schedule a personal reminder delivered privately by DM.',
    examples: ['/remind in:2h text:Check the event schedule'],
    notes: [
      'Enable DMs from this server. Maximum 20 pending reminders. Inspect/cancel your jobs using /jobs.',
      'Delivery is best effort; interrupted delivery is flagged rather than automatically duplicated.',
    ],
  },
  event: {
    purpose: 'Staff schedule an event reminder to a selected text channel.',
    examples: ['/event channel:#events in:2h text:Game night starts now'],
    notes: [
      'This schedules a bot message, not a Discord scheduled event object. You need access to the destination.',
    ],
  },
  channel: {
    purpose: 'Staff manage text-channel lifetimes, slowmode, locks and permission snapshots.',
    examples: [
      '/channel slowmode seconds:10',
      '/channel lock',
      '/channel unlock',
      '/channel temporary name:planning duration:1d',
    ],
    notes: [
      'temporary creates a private room for the creator/configured staff and schedules deletion.',
      'archive/lock save affected permission bits; unarchive/unlock restore them. Administrators bypass locks.',
      'snapshot exports reference configuration, not a full server backup or deleted-message recovery.',
    ],
  },
  panic: {
    purpose:
      'Staff temporarily lock selected text channels and pause verification during an incident.',
    examples: ['/panic on channels:CHANNEL_ID_1,CHANNEL_ID_2', '/panic off'],
    notes: [
      'Both operations require confirmation. on preserves prior settings; off restores changes made by panic mode.',
      'Each affected channel receives a normal Panic mode is in effect / Panic mode ended notice, including time but no staff identity. The bot keeps its own writing permission during a lock, restoring it afterwards. Failed notice delivery is reported to the admin log. Messages remain after restoration.',
      'Manage Server plus Manage Channels/Manage Roles in selected channels are required. Administrators retain access.',
    ],
  },
  stats: {
    purpose:
      'Staff view aggregate member growth, observed messages, recorded voice connection time and moderation counts.',
    examples: ['/stats'],
    notes: [
      'Observations start when this bot runs; excluded channels are omitted. Voice time is not speaking/activity measurement.',
    ],
  },
  activity: {
    purpose: 'Staff list members whose previously observed activity is older than a threshold.',
    examples: ['/activity days:30'],
    notes: [
      'Only retained observations are included. This does not prove inactivity and never kicks members automatically.',
    ],
  },
  jobs: {
    purpose:
      'Inspect your own scheduled work, download results, or cancel remaining user-requested work.',
    examples: ['/jobs list', '/jobs show id:JOB_ID', '/jobs cancel id:JOB_ID'],
    notes: [
      'Manage Server staff can inspect all jobs. Other members see only their own.',
      'Required expiry/cleanup jobs cannot be cancelled here. Cancelling a batch does not undo completed changes.',
    ],
  },
  backup: {
    purpose:
      'Owner-only interactive backup health, verified creation, file checks and offline recovery instructions.',
    examples: [
      '/backup',
      '/backup action:create',
      '/backup action:verify',
      '/backup action:verify file:manual-TIMESTAMP-ID.sqlite',
      '/backup action:recovery',
    ],
    notes: [
      'The private panel has Create verified backup, Refresh, a backup-file verification dropdown and Recovery guide download. It shows last attempt/success, verification, failures and stale/missing copies. Buttons are bound to the opener and recheck owner access. No database contents or confession identities are sent to Discord; the download is instructions only.',
      'Creation uses SQLite’s consistent backup API, checks integrity/foreign keys/schema/server, atomically publishes the file and writes a SHA-256 manifest. Concurrent creation is rejected. Verification detects corrupt files and mismatched manifests; legacy backups can pass database checks without a manifest. Filenames cannot traverse outside the configured backup directory and symbolic links are refused. Verification is limited to 512 MB files.',
      'Automatic daily backups run independently of unrelated Discord cleanup failures. Automatic copies and matching manifests older than seven days are pruned; manual copies are kept until the host operator removes them. Failures remain in health metadata and changed automatic failures alert the admin log. Copy backup + manifest off-host yourself; neither a local copy nor verification proves an off-host copy exists.',
      'RECOVERY: stop the bot. Run node --env-file-if-exists=.env dist/src/recover.js --source BACKUP_FILE --target DATABASE_FILE for a verification-only plan. Add --apply --stopped only after review. The server ID must be configured; pending jobs block apply unless explicitly acknowledged with --allow-pending-jobs after reviewing pendingKinds.',
      'Apply takes the managed database lock, validates a staging copy and preserves the previous database/WAL/SHM files in a sibling recovery-before-* folder before installation. Running managed bot processes block restore. Unmanaged database writers must also be stopped. No live Discord restore button exists. This restores bot state, not deleted Discord messages or channels. Review roles/bans/timers/jobs against current server state before restarting one instance.',
    ],
  },
  confess: {
    purpose:
      'Open a private form and submit a confession anonymously to members. The form discloses whether staff review or instant publication is enabled.',
    examples: ['/confess'],
    notes: [
      'The owner first configures /confession setup. The form states the current privacy mode before submission.',
      'internal: IDs are kept only for OP labels, thread-specific anonymous aliases and reply notifications. No bot command reveals them to members, moderators, administrators or the owner. Host/database operators and backups can still access stored data. unlinked: no author link is retained and linked threads/DMs are unavailable.',
      'The bot posts approved text as a new bot message, without public command attribution, author avatar or member ID. Mentions do not ping.',
      'Discord processes the interaction; the bot cannot promise anonymity from Discord, the host operator, or identifying details you write yourself.',
      'Review mode queues submissions for approval. Instant mode publishes immediately, without a review card. Both retain the same privacy policy and mention suppression. No command cooldown is imposed. The private acknowledgement simply confirms posted/submitted for review and points to this help for privacy details.',
      'Changing publishing mode while a form is open requires the member to reopen it. Existing queued submissions are not automatically published when instant mode is selected.',
      'In internal mode every new post has Reply. Click it, fill the private form, then submit: the bot creates/reuses the root discussion thread and posts your reply there (after approval in review mode). Cancelling the form creates no empty thread. /confess reply_to:12 opens the same flow. Valid modal submissions bypass the ordinary 600ms command delay. The bot does not add participants to thread membership; direct typing/joining exposes your account.',
      'The OP is labeled OP; other authors keep Anonymous 1, Anonymous 2, etc. only within that discussion. The OP, prior published contributors and current native thread members each receive at most one DM per published reply, excluding the sender, bots, muted users and users without access. Merely reading a thread does not subscribe you. Up to 100 anonymous contributors per discussion; joining the native thread also enables notifications without reserving an anonymous alias.',
      'Mute/unmute with the post button or /confess-notifications. DMs include reply text and a View reply button. Open that post and press Reply to answer through the private form; typing in the DM is ignored. Delivery is best effort and never automatically retried after an uncertain send. Membership and channel access are checked before delivery. Distinct submissions/replies can be made immediately; duplicate interactions and concurrent operations are still guarded.',
    ],
  },
  confession: {
    purpose:
      'Owner configures confession channels/privacy; moderators review, remove, report and close discussions without author lookup.',
    examples: [
      '/confession setup channel:#confessions review_channel:#confession-review privacy:internal',
      '/confession setup channel:#confessions privacy:internal review_required:false',
      '/confession mode value:instant',
      '/confession list',
      '/confession remove id:12 reason:Breaks server rules',
    ],
    notes: [
      'Use a public destination and, for review mode, a staff-only review channel. Instant mode needs no review channel. Confessions are disabled until explicitly configured.',
      'The server owner selects /confession mode value:review or value:instant. Review is the default for existing servers. Returning to review mode requires a valid private review channel.',
      'Approve/Reject buttons require current Manage Messages permission and staff allowlist membership. A submission is published at most once.',
      'Author lookup has been removed for everyone, including the owner and legacy submissions. Old staff settings normalize to internal mode. A one-time compatibility upgrade enables internal linking for future forms on enabled legacy unlinked setups. Older records keep their unlinked privacy and unknown OP; new replies disclose internal linking. A later explicit owner choice of unlinked is respected.',
      'thread creates or attaches the discussion thread after a partial creation failure. Unlocked archived threads reopen automatically on reply; staff locks and closed discussions require reopen. close locks/archives it; reopen unlocks/unarchives a retained discussion. Replies pending review stay pending while closed. remove deletes a post and closes a root discussion without deleting its replies. Startup/hourly maintenance repairs Reply controls on retained posts in threaded mode, up to 25 per pass. Older unlinked roots can receive newly linked replies, but their original authors remain unknown and cannot receive OP DMs until they join/reply.',
      'The bot needs Create Public Threads, Send Messages in Threads and Embed Links for internal mode, plus Manage Threads for close/reopen/remove. Members only need to read the discussion and use application commands. Deny ordinary Send Messages in Threads in the publication channel to encourage bot-only anonymous replies; staff/role overrides may still permit direct typing.',
      'Report discussion sends staff a post reference without participant identities. Staff review cards, public posts, logs and /jobs do not expose internal recipient records. Participant records expire with retention; an expired discussion cannot accept replies even if its public post remains.',
      'A send interrupted after it started is marked uncertain for manual review; it is not automatically sent again.',
    ],
  },
  'confess-notifications': {
    purpose:
      'Privately mute or enable reply DMs for a confession discussion in which you have published a submission.',
    examples: [
      '/confess-notifications id:12 enabled:false',
      '/confess-notifications id:12 enabled:true',
    ],
    notes: [
      'Run this in the server; use the root confession number. A post button also toggles your preference. Available to published anonymous contributors and members who joined the native discussion thread.',
      'Muting stops future reply DMs, but keeps the internal link needed for OP recognition and stable aliases. It does not delete your posts or prevent other participants receiving notifications. Incoming DM replies are ignored.',
      'Access and membership are checked. Leaving the server or losing discussion access prevents further content notifications. No participant list is exposed.',
    ],
  },
  dm: {
    purpose:
      'Authorized staff send a confirmed one-way server notice to one current member, or maintain reusable templates.',
    examples: [
      '/dm send member:@Member message:Please check the rules reason:Onboarding follow-up',
      '/dm template name:welcome text:Welcome {name} to {server}!',
      '/dm from-template member:@Member name:welcome reason:Requested help',
      '/dm templates',
    ],
    notes: [
      'Requires Manage Server and the configured staff allowlist; the messages module must be enabled. Normal members cannot send notices. Permission and target membership are checked again at confirmation.',
      'Send/from-template show a private preview and require confirmation. There is no sender cooldown; confirmations remain single-use. No mass DM operation or reply relay is provided.',
      'Templates support {user}, {name}, {server}. Names use 1–32 letters/digits/underscores/hyphens; at most 100 templates. Saving the same name replaces it.',
      'Staff logs record sender, recipient, audit reason and delivery result, not the message body. sent means accepted by Discord, not read. blocked/failed/uncertain are reported; uncertain sends are never automatically retried. Confirmation records temporarily retain the draft and expire.',
      'Incoming DM replies are not monitored. Messages identify the server and say they are one-way staff notices.',
    ],
  },
  onboarding: {
    purpose:
      'Owner configures welcome embeds, an optional one-way welcome DM, onboarding links and multiple safe automatic roles.',
    examples: [
      '/onboarding setup channel:#welcome welcome_dm:true rules_channel:#rules roles_channel:#roles introduction_channel:#introductions',
      '/onboarding message text:Welcome {user} to {server}! dm_text:Welcome {name}! Choose roles and introduce yourself.',
      '/onboarding autoroles roles:ROLE_ID_1,ROLE_ID_2 after_screening:true',
      '/onboarding autoroles roles:none',
      '/onboarding preview',
      '/onboarding status',
    ],
    notes: [
      'Server owner only. The onboarding module must be on for automatic behavior. Setup options left out keep their current settings; clearing optional channels uses /config import.',
      "For Discord's built-in Channels & Roles page, use /onboarding setup roles_source:native. It is a navigation page, not a real channel ID, so it never appears in roles_channel. roles_source:channel uses the selected normal roles_channel; roles_source:none omits the role-selection link. Native role assignment is configured under Discord Server Settings > Onboarding, independently of selfRoles.",
      'Bot public welcomes default off, including older configurations without publicWelcome. Native Discord welcomes are unaffected. /onboarding setup public_welcome:false leaves exit messages and welcome DMs enabled independently; keep the configured channel for exit messages. Opt in with public_welcome:true for bot join welcomes. Templates accept {user}, {name}, {server}. Welcome and DM text are capped at 1500 characters.',
      'Set up to 25 automatic role IDs/mentions. roles:none clears both the new list and the legacy single joinRole. Automated roles must be unprivileged, not protected, and below the bot; verifiedRole is granted only by verification.',
      'after_screening defaults to true: automatic roles and the welcome DM wait for native Rules Screening; a bot public welcome is sent on join only when public_welcome:true. Pending work is reconciled after restart. With no native screening, roles/DM are immediate.',
      "The bot does not enable native Rules Screening. Configure Community and the rules-acceptance requirement in Discord Safety Setup. A new member accepts Discord's rules prompt, their pending flag clears, then this bot applies configured automatic roles and sends its welcome DM. This does not require /verify.",
      'Welcome DMs are opt-in for the owner (default off), sent once per join. With roles_source:native, the FIRST message includes Open server and Channels & Roles (desktop) link buttons, plus mobile navigation instructions directly in its text. There is no intermediate Choose roles interaction or second message. Older Choose roles buttons upgrade their original message in-place when clicked. The desktop shortcut may open a blank page in mobile clients; open the server channel list → Channels & Roles → Customize instead. Accessible rules/introduction links remain alongside these buttons. No automatic retry after blocked/uncertain delivery. Bots are skipped.',
      'preview is private and sends no DM. status shows missing Manage Roles, pending screening and recent delivery/role failures. Use /diagnose for channel permissions. Setting changes do not backfill all current members.',
      'Give the bot Manage Roles, View Channel, Send Messages and Embed Links as required; position it above automatic roles.',
    ],
  },
  easteregg: {
    purpose:
      'Reveal an owner-customizable surprise as a public bot post in the current channel, with a Mr. Kat footer.',
    examples: ['/easteregg', '/config set key:easterEggText value:"Your own secret message"'],
    notes: [
      'Members can trigger it where both they and the bot can post; the community module must be enabled.',
      'The server owner changes easterEggText with /config set and confirms the change. The footer remains Mr. Kat even when the text changes.',
      'There is no command cooldown. Mentions do not ping. The command acknowledgement is private; the Easter egg post is public.',
    ],
  },
};

const memberPaths = new Set([
  'warnings panel',
  'warnings list',
  'poll create',
  'poll close',
  'ticket open',
  'ticket close',
  'tag get',
  'tag list',
  'poll results',
  'suggest create',
  'voice status',
  'voice rename',
  'voice limit',
  'voice lock',
  'voice unlock',
  'voice permit',
  'voice block',
  'voice transfer',
  'voice claim',
  'voice panel',
]);
const ownerPaths = new Set([
  'warnings configure',
  'mentionguard setup',
  'mentionguard disable',
  'heartbeat setup',
  'heartbeat disable',
  'starboard setup',
  'starboard disable',
  'voice setup',
  'confession setup',
  'confession mode',
  'automod mode',
  'automod configure',
]);
const memberRoots = new Set([
  'warnings',
  'help',
  'man',
  'status',
  'confess',
  'confess-notifications',
  'easteregg',
  'text',
  'voice',
  'ticket',
  'report',
  'appeal',
  'tag',
  'poll',
  'suggest',
  'remind',
  'jobs',
]);
function audience(path: string, root: string): Audience {
  if (['setup', 'config', 'backup', 'onboarding'].includes(root) || ownerPaths.has(path))
    return 'owners';
  if (
    memberPaths.has(path) ||
    (!path.includes(' ') && memberRoots.has(root)) ||
    ['help', 'man', 'status', 'confess', 'report', 'appeal', 'remind', 'jobs', 'text'].includes(
      root,
    )
  )
    return 'members';
  return 'moderators';
}
export const topics: Topic[] = commands.flatMap((command) => {
  if (command.type !== 1 || !('description' in command)) return [];
  const options = ('options' in command ? command.options : []) ?? [];
  const subs = options.filter((option) => option.type === T.Subcommand);
  const build = (
    path: string,
    description: string,
    opts: APIApplicationCommandOption[],
    subcommands: string[],
  ): Topic => {
    const group = audience(path, command.name);
    let access =
      group === 'owners'
        ? 'Server owner only'
        : group === 'moderators'
          ? 'Moderator: native permission plus configured staff allowlist'
          : 'Members';
    if (path.startsWith('voice ') && !['voice status', 'voice setup', 'voice move'].includes(path))
      access =
        path === 'voice claim'
          ? 'Member connected to a managed room whose owner has left'
          : 'Owner of your current managed voice room';
    if (path === 'ticket close') access = 'Ticket creator or authorized staff';
    if (path === 'warnings list' || path === 'warnings panel')
      access = 'Members: own history; Moderate Members and staff allowlist: other members';
    if (path === 'poll create') access = 'Members who can post in this channel';
    if (path === 'poll close')
      access = 'Poll creator; other polls require Manage Messages plus the staff allowlist';
    if (command.name === 'jobs') access = 'Members: own jobs; Manage Server staff: all jobs';
    const native = command.default_member_permissions
      ? new PermissionsBitField(BigInt(command.default_member_permissions)).toArray().join(', ')
      : '';
    if (native && group === 'moderators')
      access += ` (command default: ${native}; action-specific checks apply)`;
    return { path, description, audience: group, access, options: opts, subcommands };
  };
  return [
    build(
      command.name,
      command.description,
      subs.length ? [] : options,
      subs.map((sub) => `${command.name} ${sub.name}`),
    ),
    ...subs.map((sub) =>
      build(`${command.name} ${sub.name}`, sub.description, sub.options ?? [], []),
    ),
  ];
});
export function findTopic(input: string): Topic | undefined {
  return topics.find(
    (topic) => topic.path === input.trim().replace(/^\//, '').replace(/\s+/g, ' ').toLowerCase(),
  );
}
function optionLines(options: APIApplicationCommandOption[]): string[] {
  return options.map((option) => {
    const type = T[option.type];
    const choices =
      'choices' in option && option.choices
        ? ` Choices: ${option.choices.map((choice) => choice.value).join(', ')}.`
        : '';
    const min =
      'min_value' in option && option.min_value !== undefined
        ? ` Minimum: ${option.min_value}.`
        : '';
    const max =
      'max_value' in option && option.max_value !== undefined
        ? ` Maximum: ${option.max_value}.`
        : '';
    return `• ${option.name} (${type}, ${'required' in option && option.required ? 'required' : 'optional'}): ${option.description}.${choices}${min}${max}`;
  });
}
export function manualText(topic: Topic): string {
  const root = topic.path.split(' ')[0]!;
  const info = overviews[root]!;
  const usage = `/${topic.path}${topic.subcommands.length ? ' <subcommand>' : ''}${topic.options.map((option) => ` ${'required' in option && option.required ? '<' : '['}${option.name}${'required' in option && option.required ? '>' : ']'}`).join('')}`;
  const values: Record<string, string> = {
    command: '"voice setup"',
    reason: '"Staff-reviewed reason"',
    duration: '30m',
    expires: '30d',
    in: '2h',
    text: '"Your message"',
    subject: '"I need help"',
    name: '"Example"',
    title: '"Announcement"',
    words: 'word1,word2',
    members: 'MEMBER_ID_1,MEMBER_ID_2',
    channels: 'CHANNEL_ID_1,CHANNEL_ID_2',
    key: 'snapshotDays',
    value: '7',
    user_id: 'USER_ID',
    id: 'REFERENCE_ID',
    rule_id: 'RULE_ID',
    choices: '"Option A | Option B"',
    question: '"Choose an option"',
    rules: '"Read and accept the rules"',
    template: '"{name}"',
  };
  const exactExample = `/${topic.path}${topic.options
    .filter((option) => 'required' in option && option.required)
    .map((option) => {
      const value =
        'choices' in option && option.choices?.length
          ? String(option.choices[0]!.value)
          : option.type === T.User
            ? '@Member'
            : option.type === T.Role
              ? '@Community'
              : option.type === T.Channel
                ? option.name === 'category'
                  ? 'VoiceRooms'
                  : option.name === 'lobby'
                    ? 'CreateRoom'
                    : '#channel'
                : option.type === T.Integer
                  ? String('min_value' in option ? Math.max(1, Number(option.min_value ?? 1)) : 1)
                  : (values[option.name] ?? 'VALUE');
      return ` ${option.name}:${value}`;
    })
    .join('')}`;
  return [
    `/${topic.path}`,
    topic.description,
    '',
    `ACCESS: ${topic.access}`,
    `RESPONSE: ${responsePolicies[topic.path] === 'public' ? 'Persistent message in the command channel' : responsePolicies[topic.path] === 'staff' ? 'Private acknowledgement; lasting staff receipt in /changes and configured admin log' : responsePolicies[topic.path] === 'published' ? 'Persistent destination post/panel; private acknowledgement' : topic.subcommands.length ? 'See each subcommand for response visibility' : 'Private response; sensitive information is not broadcast'}`,
    '',
    'PURPOSE',
    info.purpose,
    '',
    'USAGE',
    usage,
    ...(topic.options.length ? ['', 'OPTIONS', ...optionLines(topic.options)] : []),
    ...(topic.subcommands.length
      ? [
          '',
          'SUBCOMMANDS',
          ...topic.subcommands.map(
            (path) => `• /${path} — ${findTopic(path)!.description} [${findTopic(path)!.access}]`,
          ),
        ]
      : []),
    '',
    'EXAMPLES',
    ...(topic.subcommands.length ? [] : [exactExample]),
    ...info.examples,
    '',
    'BEHAVIOR AND TROUBLESHOOTING',
    ...info.notes.map((note) => `• ${note}`),
    '',
    'Durations: 30s, 10m, 2h, 7d, 1w (10 seconds minimum; general maximum 365 days). Help is private; content posted by the described command follows its own access rules.',
  ].join('\n');
}
export function splitPages(text: string, limit = 1750): string[] {
  const pages: string[] = [];
  let page = '';
  for (const line of text.split('\n')) {
    let remaining = line;
    while (remaining.length > limit) {
      if (page) {
        pages.push(page);
        page = '';
      }
      pages.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    if (page.length + remaining.length + 1 > limit) {
      pages.push(page);
      page = '';
    }
    page += (page ? '\n' : '') + remaining;
  }
  if (page) pages.push(page);
  return pages.length ? pages : ['No entries.'];
}
export function indexText(group: Audience | 'all'): string {
  const selected = topics.filter((topic) => group === 'all' || topic.audience === group);
  return [
    `COMMAND MANUAL · ${group}`,
    'Use /help command:voice setup or /man command:mod timeout for exact options and examples.',
    'Member help does not grant moderator powers. Mixed command groups label access on each subcommand.',
    '',
    ...selected.map((topic) => `/${topic.path} — ${topic.description} [${topic.access}]`),
  ].join('\n');
}
