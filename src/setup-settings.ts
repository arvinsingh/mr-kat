import { ChannelType, PermissionFlagsBits as P } from 'discord.js';

export const healthTopics = [
  'overview',
  'logging',
  'moderation',
  'roles',
  'voice',
  'tickets',
  'onboarding',
  'confessions',
  'community',
  'automation',
  'backups',
] as const;
export type HealthTopic = (typeof healthTopics)[number];

export const healthTextChannels = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
export const postingPermissions = [P.ViewChannel, P.SendMessages, P.EmbedLinks];

interface Setting {
  label: string;
  topic: HealthTopic;
  roles?: number;
  types?: ChannelType[];
  permissions?: bigint[];
  healthTypes?: ChannelType[];
  healthPermissions?: bigint[];
}
function text(label: string, topic: HealthTopic, overrides: Partial<Setting> = {}): Setting {
  return {
    label,
    topic,
    types: [ChannelType.GuildText],
    permissions: postingPermissions,
    ...overrides,
  };
}

// Preserve the picker’s supported types and minimum access separately from runtime health checks.
// Some existing destinations support announcement channels; selecting one still uses the text picker.
export const setupSettings: Record<string, Setting> = {
  logs: text('All event log destinations', 'logging', {
    healthTypes: healthTextChannels,
    healthPermissions: [...postingPermissions, P.ReadMessageHistory],
  }),
  'logs.dm': text('Private DM inbox', 'logging', {
    healthPermissions: [
      ...postingPermissions,
      P.ReadMessageHistory,
      P.CreatePublicThreads,
      P.SendMessagesInThreads,
    ],
  }),
  suggestionChannel: text('Suggestions destination', 'community', {
    healthPermissions: [
      ...postingPermissions,
      P.ReadMessageHistory,
      P.CreatePublicThreads,
      P.SendMessagesInThreads,
    ],
  }),
  staffRoles: { label: 'Staff allowlist roles', topic: 'roles', roles: 10 },
  selfRoles: { label: 'Bot self-service roles', topic: 'roles', roles: 25 },
  joinRoles: { label: 'Automatic join roles', topic: 'onboarding', roles: 25 },
  verifiedRole: { label: 'Optional verification role', topic: 'roles', roles: 1 },
  voiceLobby: {
    label: 'Join-to-create voice lobby',
    topic: 'voice',
    types: [ChannelType.GuildVoice],
    permissions: [P.ViewChannel, P.Connect, P.MoveMembers],
  },
  voiceCategory: {
    label: 'Temporary voice category',
    topic: 'voice',
    types: [ChannelType.GuildCategory],
    permissions: [P.ViewChannel, P.ManageChannels, P.ManageRoles],
    healthPermissions: [
      P.ViewChannel,
      P.ManageChannels,
      P.ManageRoles,
      P.Connect,
      P.SendMessages,
      P.EmbedLinks,
      P.ReadMessageHistory,
    ],
  },
  voiceNoticeChannel: text('Voice creation notices', 'voice', { healthTypes: healthTextChannels }),
  supportChannel: text('Support panel channel', 'tickets', {
    healthPermissions: [...postingPermissions, P.ReadMessageHistory],
  }),
  welcomeChannel: text('Join/exit message destination', 'onboarding', {
    healthTypes: healthTextChannels,
  }),
  rulesChannel: text('Rules channel link', 'onboarding', {
    permissions: [P.ViewChannel],
    healthTypes: healthTextChannels,
  }),
  introductionChannel: text('Introduction channel link', 'onboarding', {
    permissions: [P.ViewChannel],
    healthTypes: healthTextChannels,
  }),
  'mentionReplies.commandsChannel': text('Commands channel link', 'community', {
    permissions: [P.ViewChannel],
  }),
  'starboard.channel': text('Starboard destination', 'community', {
    healthPermissions: [...postingPermissions, P.ReadMessageHistory],
  }),
  'heartbeat.channel': text('Heartbeat destination', 'automation'),
};
