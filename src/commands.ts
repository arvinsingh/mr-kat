import {
  ApplicationCommandOptionType as T,
  ApplicationCommandType,
  PermissionFlagsBits as P,
  type RESTPostAPIApplicationCommandsJSONBody,
  type APIApplicationCommandOption,
} from 'discord.js';
import { logKinds, modules } from './config.js';
import { textEffects } from './text-effects.js';
import { healthTopics } from './setup-health.js';
type Opt = {
  type: T;
  name: string;
  description: string;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  min_value?: number;
  max_value?: number;
  max_length?: number;
  options?: Opt[];
};
const s = (
  name: string,
  description: string,
  required = false,
  choices?: readonly string[],
): Opt => ({
  type: T.String,
  name,
  description,
  required,
  max_length: 1900,
  ...(choices ? { choices: choices.map((value) => ({ name: value, value })) } : {}),
});
const n = (name: string, description: string, required = false, min = 1, max = 1000): Opt => ({
  type: T.Integer,
  name,
  description,
  required,
  min_value: min,
  max_value: max,
});
const u = (name = 'member', required = true): Opt => ({
  type: T.User,
  name,
  description: 'Server member or user',
  required,
});
const r = (name = 'role', required = true): Opt => ({
  type: T.Role,
  name,
  description: 'Server role',
  required,
});
const c = (name = 'channel', required = true): Opt => ({
  type: T.Channel,
  name,
  description: 'Server channel',
  required,
});
const b = (name: string, description: string): Opt => ({ type: T.Boolean, name, description });
const a = (name: string, description: string): Opt => ({
  type: T.Attachment,
  name,
  description,
  required: true,
});
const sub = (name: string, description: string, options: Opt[] = []): Opt => ({
  type: T.Subcommand,
  name,
  description,
  options,
});
const root = (
  name: string,
  description: string,
  options: Opt[] = [],
  permission?: bigint,
): RESTPostAPIApplicationCommandsJSONBody => ({
  type: ApplicationCommandType.ChatInput,
  name,
  description,
  contexts: [0],
  default_member_permissions: permission?.toString() ?? null,
  options: options as APIApplicationCommandOption[],
});

export const commands: RESTPostAPIApplicationCommandsJSONBody[] = [
  {
    name: 'Edit transformed message',
    type: ApplicationCommandType.Message,
    contexts: [0],
  },
  {
    name: 'Delete transformed message',
    type: ApplicationCommandType.Message,
    contexts: [0],
  },
  root(
    'uwulock',
    'Staff: timed automatic UwU text server-wide or in one channel',
    [
      sub('panel', 'Choose server-wide or channel scope, member and duration'),
      sub('add', 'Temporarily transform a member’s new messages', [
        u(),
        s('duration', 'Lifetime such as 10m or 2h (maximum 1 day)'),
        {
          ...c('channel', false),
          description: 'Optional: limit to one channel; omit for server-wide',
        },
      ]),
      sub('remove', 'Fully unlock a member, or remove one channel lock', [
        u(),
        {
          ...c('channel', false),
          description: 'Optional: remove just this channel lock; omit to fully unlock',
        },
      ]),
      sub('list', 'Show current locks and expiry times'),
      sub('stats', 'Show successful conversion counts'),
      sub('clear', 'Preview removing every active UwU lock'),
    ],
    P.ManageMessages,
  ),
  root(
    'heartbeat',
    'Configure periodic bot status posts',
    [
      sub('setup', 'Owner: enable regular status messages', [
        c(),
        n('minutes', 'Minutes between posts', false, 1, 1440),
      ]),
      sub('status', 'Staff: inspect heartbeat settings and delivery'),
      sub('disable', 'Owner: stop heartbeat posts'),
    ],
    P.ManageGuild,
  ),
  root(
    'changes',
    'Staff: read lasting command-change receipts',
    [n('limit', 'Recent changes to show', false, 1, 20)],
    P.ManageGuild,
  ),
  root(
    'starboard',
    'Configure and maintain starred community messages',
    [
      sub('setup', 'Owner: enable starboard and choose its destination', [
        c(),
        n('threshold', 'Unique people needed to star a message', false, 1, 100),
        b('self_stars', 'Count the original author’s star (default true)'),
      ]),
      sub('status', 'Show starboard settings and unresolved deliveries'),
      sub('disable', 'Owner: stop starboard updates; keep existing posts'),
      sub('refresh', 'Refresh an existing message or recover a missed reaction event', [
        c(),
        s('message', 'Original message ID', true),
      ]),
    ],
    P.ManageMessages,
  ),
  root('help', 'Read the command manual or get a channel-ready guide', [
    s('command', 'Command or subcommand, e.g. voice setup or mod timeout'),
    s('audience', 'Show commands for this audience', false, [
      'members',
      'moderators',
      'owners',
      'all',
    ]),
    n('page', 'Manual page', false, 1, 100),
    s('guide', 'Download a guide to post in Discord', false, ['members', 'moderators', 'owners']),
  ]),
  root('man', 'Detailed manual for a command', [
    s('command', 'Command or subcommand, e.g. confess or voice setup', true),
    n('page', 'Manual page', false, 1, 100),
  ]),
  root('confess', 'Privately submit an anonymous confession or reply', [
    n('reply_to', 'Root confession number to reply to', false, 1, 2147483647),
  ]),
  root('confess-notifications', 'Manage your anonymous discussion reply DMs', [
    n('id', 'Root confession number', true, 1, 2147483647),
    { ...b('enabled', 'Receive a DM for new replies'), required: true },
  ]),
  root('easteregg', 'Reveal a little secret in this channel'),
  root(
    'text',
    'Transform your text or a message in this channel',
    textEffects.map((effect) =>
      sub(effect, `Apply ${effect} to text or a message`, [
        { ...s('text', 'Your text (choose text OR message)'), max_length: 4000 },
        s('message', 'Discord message link from this same channel'),
        ...(effect === 'uwuify' ? [b('exclamations', 'Add expressive punctuation')] : []),
        ...(['emojify', 'faces'].includes(effect)
          ? [n('density', 'Percentage of matching words to decorate', false, 1, 100)]
          : []),
        ...(effect === 'morse' ? [b('decode', 'Decode Morse back to text')] : []),
        ...(effect === 'zalgo'
          ? [s('intensity', 'Glitch intensity (default medium)', false, ['low', 'medium', 'high'])]
          : []),
      ]),
    ),
  ),
  root(
    'confession',
    'Configure and moderate anonymous confessions',
    [
      sub('setup', 'Owner: choose channels and the disclosed privacy policy', [
        c(),
        s('privacy', 'Internal IDs for replies/DMs, or no author links', true, [
          'internal',
          'unlinked',
        ]),
        c('review_channel', false),
        b('review_required', 'Require staff approval before publication (default: current mode)'),
      ]),
      sub('mode', 'Owner: choose staff review or immediate publication', [
        s('value', 'Publishing mode', true, ['review', 'instant']),
      ]),
      sub('status', 'Show confession setup and privacy policy'),
      sub('list', 'List recent submissions'),
      sub('review', 'Show or resend a review card', [
        n('id', 'Confession number', true, 1, 2147483647),
      ]),
      sub('remove', 'Remove a published confession', [
        n('id', 'Confession number', true, 1, 2147483647),
        s('reason', 'Removal reason', true),
      ]),
      sub('thread', 'Create or repair an anonymous discussion thread', [
        n('id', 'Root confession number', true, 1, 2147483647),
      ]),
      sub('close', 'Close a confession discussion and stop replies', [
        n('id', 'Root confession number', true, 1, 2147483647),
      ]),
      sub('reopen', 'Reopen a retained confession discussion', [
        n('id', 'Root confession number', true, 1, 2147483647),
      ]),
    ],
    P.ManageMessages,
  ),
  root(
    'dm',
    'Send one-way server notices to a member',
    [
      sub('send', 'Preview and confirm a one-way staff DM', [
        u(),
        s('message', 'Message text', true),
        s('reason', 'Staff audit reason', true),
      ]),
      sub('template', 'Save a reusable notice template', [
        s('name', 'Template name', true),
        s('text', 'Template text', true),
      ]),
      sub('templates', 'List saved notice templates'),
      sub('from-template', 'Preview a template DM for one member', [
        u(),
        s('name', 'Template name', true),
        s('reason', 'Staff audit reason', true),
      ]),
    ],
    P.ManageGuild,
  ),
  root(
    'onboarding',
    'Owner: configure welcome messages and automatic roles',
    [
      sub('setup', 'Choose welcome and onboarding destinations', [
        c('channel', false),
        b('welcome_dm', 'Send one welcome DM after screening'),
        b('public_welcome', 'Post bot join welcomes (default off; exit messages are separate)'),
        c('rules_channel', false),
        c('roles_channel', false),
        s(
          'roles_source',
          'Role-selection link: Discord native page, normal channel or none',
          false,
          ['native', 'channel', 'none'],
        ),
        c('introduction_channel', false),
      ]),
      sub('message', 'Customize public and private welcome text', [
        s('text', 'Public welcome text; {user}, {name}, {server}'),
        s('dm_text', 'Welcome DM text; {user}, {name}, {server}'),
      ]),
      sub('autoroles', 'Set up to 25 safe join roles, or clear them', [
        s('roles', 'Role IDs/mentions, or none to clear', true),
        b('after_screening', 'Wait for native Rules Screening (default true)'),
      ]),
      sub('preview', 'Privately preview welcome messages and links'),
      sub('status', 'Show onboarding settings, permissions and recent failures'),
    ],
    P.ManageGuild,
  ),
  root(
    'setup',
    'Owner: open interactive setup or set private log destinations',
    [c('logs', false), s('feature', 'Health/setup section', false, healthTopics)],
    P.ManageGuild,
  ),
  root(
    'config',
    'Owner configuration and settings backup',
    [
      sub('show', 'Show settings'),
      sub('set', 'Set a setting using its exact JSON value', [
        s('key', 'Top-level setting name', true),
        s('value', 'JSON value: string, number, boolean, array, or object', true),
      ]),
      sub('log', 'Set a log destination', [s('kind', 'Log category', true, logKinds), c()]),
      sub('module', 'Enable or disable a module', [
        s('name', 'Module', true, modules),
        s('state', 'State', true, ['on', 'off']),
      ]),
      sub('export', 'Export configuration'),
      sub('import', 'Validate and preview a configuration file', [
        a('file', 'JSON configuration exported by this bot'),
      ]),
    ],
    P.ManageGuild,
  ),
  root(
    'say',
    'Staff: send a plain bot message to a server channel',
    [c(), s('message', 'Message text (omit to open a multiline composer)')],
    P.ManageMessages,
  ),
  root(
    'mentionguard',
    'Redirect protected-role mentions and detect repeated role pings',
    [
      sub('setup', 'Owner: configure roles and a support destination', [
        s('roles', '1–25 protected role IDs or mentions', true),
        {
          ...c('channel', false),
          description: 'Monitor this channel and its threads; omit for server-wide',
        },
        {
          ...c('support_channel', false),
          description: 'Optional support destination for the redirect reply',
        },
        n('limit', 'Repeat/mass-mention alert threshold', false, 2, 20),
        n('seconds', 'Repeat detection window', false, 5, 300),
      ]),
      sub('status', 'Inspect mention redirect settings and prevention limits'),
      sub('disable', 'Owner: disable mention redirects'),
    ],
    P.ManageGuild,
  ),
  root('warnings', 'Warning history, revocation and automatic escalation', [
    sub('panel', 'Open the guided private warnings panel', [u('member', false)]),
    sub('list', 'View your warnings; staff can inspect another member', [u('member', false)]),
    sub('status', 'Staff: inspect the warning policy'),
    sub('revoke', 'Staff: revoke a warning without erasing history', [
      n('case', 'Warning case number', true, 1, 2147483647),
      s('reason', 'Why this warning is revoked', true),
    ]),
    sub('configure', 'Owner: configure automatic warning escalation', [
      n('threshold', 'Active warnings needed (0 disables)', true, 0, 20),
      s('action', 'Action at threshold', true, ['none', 'timeout', 'kick']),
      n('timeout_minutes', 'Timeout duration when action is timeout', false, 1, 1440),
    ]),
  ]),
  root('status', 'Bot connection and job status'),
  root(
    'diagnose',
    'Staff: interactive feature health and setup guidance',
    [s('feature', 'Feature to inspect', false, healthTopics)],
    P.ManageGuild,
  ),
  root(
    'mod',
    'Moderate members',
    [
      sub('warn', 'Record a warning', [
        u(),
        s('reason', 'Reason', true),
        s('expires', 'Optional expiry such as 30d'),
        s('evidence', 'Optional message link or message ID from this channel'),
      ]),
      sub('timeout', 'Temporarily restrict a member', [
        u(),
        s('duration', 'Duration such as 30m (maximum 28 days)', true),
        s('reason', 'Reason', true),
      ]),
      sub('untimeout', 'Remove a timeout', [u(), s('reason', 'Reason', true)]),
      sub('kick', 'Kick a member', [
        u(),
        s('reason', 'Reason', true),
        s('evidence', 'Optional message link or ID'),
      ]),
      sub('ban', 'Ban a member; optional scheduled unban', [
        u(),
        s('reason', 'Reason', true),
        s('duration', 'Optional duration such as 7d'),
        s('evidence', 'Optional message link or message ID from this channel'),
      ]),
      sub('unban', 'Unban a user', [
        s('user_id', 'Discord user ID', true),
        s('reason', 'Reason', true),
      ]),
      sub('info', 'Inspect a member', [u()]),
      sub('cases', 'Search moderation cases', [u('member', false)]),
      sub('evidence', 'Staff: export captured message evidence for a case', [
        n('case', 'Case number', true, 1, 2147483647),
      ]),
      sub('nickname', 'Change a member nickname', [
        u(),
        s('name', 'New nickname (up to 32 characters)', true),
        s('reason', 'Reason', true),
      ]),
      sub('bulk-nickname', 'Preview nickname changes for selected members', [
        s('members', '1–25 member IDs/mentions', true),
        s('template', 'Nickname, optionally containing {name} or {index}', true),
        s('reason', 'Reason', true),
      ]),
      sub('note', 'Add a private staff note', [u(), s('text', 'Staff-only note', true)]),
      sub('amend', 'Append a correction to a case', [
        n('case', 'Case number', true, 1, 2147483647),
        s('text', 'Correction; original case remains recorded', true),
      ]),
      sub('export', 'Export case history', [u('member', false)]),
      sub('summary', 'Staff activity summary'),
    ],
    P.ModerateMembers,
  ),
  root(
    'purge',
    'Preview filtered message deletion',
    [
      n('count', 'Maximum matching messages to delete', true, 1, 1000),
      n('scan', 'Maximum messages to inspect (default 200)', false, 1, 1000),
      u('member', false),
      s('filter', 'Additional filter', false, ['all', 'bots', 'links', 'attachments']),
      s('contains', 'Case-insensitive text filter'),
      s('after', 'After ISO date/time'),
      s('before', 'Before ISO date/time'),
      b('older', 'Include messages older than two weeks using individual deletes'),
      { ...s('reason', 'Reason recorded with the purge logs'), max_length: 500 },
    ],
    P.ManageMessages,
  ),
  root(
    'role',
    'Assign roles or publish a self-service panel',
    [
      sub('add', 'Assign a role', [u(), r(), s('reason', 'Reason', true)]),
      sub('remove', 'Remove a role', [u(), r(), s('reason', 'Reason', true)]),
      sub('temporary', 'Assign an expiring role', [
        u(),
        r(),
        s('duration', 'Duration such as 7d', true),
        s('reason', 'Reason', true),
      ]),
      sub('menu', 'Publish the configured self-service role menu', [c()]),
      sub('bulk', 'Preview changes for a list of members', [
        r(),
        s('members', '1–25 member IDs/mentions, comma separated', true),
        s('action', 'Change', true, ['add', 'remove']),
        s('reason', 'Reason', true),
      ]),
    ],
    P.ManageRoles,
  ),
  root('voice', 'Manage your temporary voice room', [
    sub('status', 'Check voice setup, room tracking, and bot permissions'),
    sub('setup', 'Configure join-to-create', [
      c('lobby'),
      c('category'),
      c('notice_channel', false),
    ]),
    sub('rename', 'Rename your room', [s('name', 'Room name', true)]),
    sub('limit', 'Set room capacity', [n('count', '0 means unlimited', true, 0, 99)]),
    sub('lock', 'Prevent new members joining'),
    sub('unlock', 'Allow members to join'),
    sub('permit', 'Permit a member', [u()]),
    sub('block', 'Block a member from this room', [u()]),
    sub('transfer', 'Transfer ownership to a room member', [u()]),
    sub('claim', 'Claim a room whose owner has left'),
    sub('panel', 'Show room controls'),
    sub('move', 'Staff: move a member to a voice channel', [u(), c()]),
  ]),
  root(
    'automod',
    'Configure spam prevention and native Discord rules',
    [
      sub('show', 'Show spam settings'),
      sub('status', 'Diagnose bot filtering and native Discord AutoMod'),
      sub('panel', 'Show owner-only response-mode buttons'),
      sub('configure', 'Owner: adjust the bot spam detector', [
        s('mode', 'Response', false, ['report', 'delete', 'timeout']),
        n('messages', 'Message threshold', false, 3, 50),
        n('seconds', 'Detection window', false, 3, 60),
        n('repeats', 'Repeated-text threshold', false, 2, 20),
        n('mentions', 'Mention threshold', false, 2, 50),
        b('block_invites', 'Block Discord invite links'),
      ]),
      sub('list', 'List native Discord rules and their enabled state'),
      sub('toggle', 'Enable or disable a native rule owned by this bot', [
        s('rule_id', 'Native rule ID', true),
        s('state', 'State', true, ['on', 'off']),
      ]),
      sub('mode', 'Set response mode', [s('value', 'Mode', true, ['report', 'delete', 'timeout'])]),
      sub('keyword', 'Create a native blocked-keyword rule', [
        s('name', 'Rule name', true),
        s('words', 'Comma-separated blocked words', true),
      ]),
      sub('mentions', 'Create a native mention-spam rule', [
        n('limit', 'Unique mention limit', true, 1, 50),
      ]),
    ],
    P.ManageGuild,
  ),
  root(
    'verify',
    'Onboarding and verification',
    [
      sub('panel', 'Publish a rules acknowledgement panel', [
        c(),
        s('rules', 'Rules or a link to rules', true),
      ]),
      sub('approve', 'Approve a pending member', [u()]),
      sub('deny', 'Deny a pending member', [u(), s('reason', 'Reason', true)]),
      sub('pending', 'List pending verification requests'),
    ],
    P.ManageGuild,
  ),
  root('ticket', 'Private support tickets', [
    sub('panel', 'Staff: publish a support panel', [
      c(),
      s('title', 'Panel title'),
      s('description', 'Panel description'),
    ]),
    sub('open', 'Open a private ticket', [s('subject', 'What do you need help with?', true)]),
    sub('claim', 'Staff: claim this ticket'),
    sub('close', 'Close this ticket', [s('reason', 'Closure reason', true)]),
    sub('reopen', 'Staff: reopen this ticket'),
    sub('delete', 'Staff: confirm permanent deletion of a closed ticket channel'),
    sub('transcript', 'Staff: export this ticket transcript'),
  ]),
  root('report', 'Privately report a member', [
    u(),
    s('reason', 'Report details', true),
    s('evidence', 'Optional message link or ID'),
  ]),
  root('appeal', 'Submit an appeal to staff', [
    n('case', 'Case number', true, 1, 2147483647),
    s('reason', 'Appeal details', true),
  ]),
  root(
    'review',
    'Staff: review reports and appeals',
    [
      sub('list', 'List pending reports or appeals', [
        s('kind', 'Queue', true, ['reports', 'appeals']),
      ]),
      sub('resolve', 'Resolve a report or appeal', [
        s('kind', 'Queue', true, ['reports', 'appeals']),
        s('id', 'Reference ID', true),
        s('decision', 'Decision', true, ['accepted', 'declined', 'resolved']),
        s('reason', 'Staff explanation', true),
      ]),
    ],
    P.ModerateMembers,
  ),
  {
    name: 'Moderate with evidence',
    type: ApplicationCommandType.Message,
    contexts: [0],
    default_member_permissions: P.ModerateMembers.toString(),
  },
  {
    name: 'Report message',
    type: ApplicationCommandType.Message,
    contexts: [0],
    default_member_permissions: null,
  },
  {
    name: 'Transform text',
    type: ApplicationCommandType.Message,
    contexts: [0],
    default_member_permissions: null,
  },
  root(
    'announce',
    'Publish or schedule a bot announcement',
    [
      sub('send', 'Publish an announcement', [
        c(),
        s('title', 'Title', true),
        s('text', 'Announcement', true),
        u('mention_user', false),
        c('mention_channel', false),
      ]),
      sub('schedule', 'Schedule an announcement', [
        c(),
        s('title', 'Title', true),
        s('text', 'Announcement', true),
        s('in', 'Delay such as 2h', true),
        u('mention_user', false),
        c('mention_channel', false),
      ]),
      sub('edit', 'Edit a bot-authored announcement', [
        c(),
        s('message', 'Message ID', true),
        s('title', 'Title', true),
        s('text', 'Announcement', true),
        u('mention_user', false),
        c('mention_channel', false),
      ]),
      sub('builder', 'Open an announcement form', [
        c(),
        u('mention_user', false),
        c('mention_channel', false),
      ]),
      sub('everyone', 'Build, preview and confirm an announcement that pings everyone', [
        c(),
        u('mention_user', false),
        c('mention_channel', false),
      ]),
    ],
    P.ManageMessages,
  ),
  root('tag', 'Reusable FAQ replies', [
    sub('set', 'Staff: save a reply', [s('name', 'Tag name', true), s('text', 'Reply', true)]),
    sub('get', 'Get a saved reply', [s('name', 'Tag name', true)]),
    sub('list', 'List available tags'),
    sub('delete', 'Staff: delete a reply', [s('name', 'Tag name', true)]),
  ]),
  root(
    'sticky',
    'Staff: configure a rate-limited sticky message',
    [
      sub('set', 'Set this channel sticky', [s('text', 'Message', true)]),
      sub('remove', 'Remove this channel sticky'),
    ],
    P.ManageMessages,
  ),
  root('poll', 'Create and vote in polls', [
    sub('create', 'Create a poll in this channel', [
      s('question', 'Question', true),
      s('choices', '2–5 choices separated by |', true),
      s('duration', 'Voting period such as 1d', true),
      b('anonymous', 'Hide individual voters from members'),
    ]),
    sub('close', 'Close your own poll; staff can close any accessible poll', [
      s('id', 'Poll ID', true),
    ]),
    sub('results', 'Show poll results', [s('id', 'Poll ID', true)]),
  ]),
  root('suggest', 'Submit and review suggestions', [
    sub('create', 'Submit a suggestion', [s('text', 'Suggestion', true)]),
    sub('status', 'Staff: update a suggestion', [
      s('id', 'Suggestion ID', true),
      s('state', 'Decision', true, ['open', 'accepted', 'declined', 'implemented']),
      s('reason', 'Decision reason', true),
    ]),
  ]),
  root('remind', 'Set a personal reminder', [
    s('in', 'Delay such as 2h', true),
    s('text', 'Reminder', true),
  ]),
  root(
    'event',
    'Staff: schedule a channel event reminder',
    [c(), s('in', 'Delay such as 2h', true), s('text', 'Event reminder', true)],
    P.ManageMessages,
  ),
  root(
    'channel',
    'Staff channel management',
    [
      sub('temporary', 'Create an expiring text channel', [
        s('name', 'Channel name', true),
        s('duration', 'Lifetime such as 1d', true),
      ]),
      sub('lock', 'Lock this channel'),
      sub('unlock', 'Restore pre-lock permissions'),
      sub('slowmode', 'Set slowmode', [n('seconds', 'Seconds between messages', true, 0, 21600)]),
      sub('archive', 'Archive a text channel (read-only)'),
      sub('unarchive', 'Restore pre-archive permissions'),
      sub('inspect', 'Inspect effective member permissions', [u('member', false)]),
      sub('snapshot', 'Export role/channel configuration for reference'),
    ],
    P.ManageChannels,
  ),
  root(
    'panic',
    'Staff: emergency lockdown of selected text channels',
    [
      sub('on', 'Preview emergency lockdown', [s('channels', '1–25 channel IDs', true)]),
      sub('off', 'Preview restoring panic changes'),
    ],
    P.ManageGuild,
  ),
  root('stats', 'View aggregate server statistics'),
  root(
    'activity',
    'Staff: report activity observed by this bot',
    [n('days', 'Days without observed activity', false, 1, 90)],
    P.ModerateMembers,
  ),
  root('jobs', 'Inspect and cancel scheduled work', [
    sub('list', 'List your jobs; staff can see all'),
    sub('show', 'Show job progress and outcomes', [s('id', 'Job ID', true)]),
    sub('cancel', 'Cancel a pending/running job', [s('id', 'Job ID', true)]),
  ]),
  root(
    'backup',
    'Owner: backup health, verification and offline recovery',
    [
      s('action', 'Open panel or perform an action', false, [
        'panel',
        'create',
        'verify',
        'recovery',
      ]),
      s('file', 'Local backup filename to verify (default newest)'),
    ],
    P.ManageGuild,
  ),
];
