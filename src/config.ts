import { z } from 'zod';
import { defaultMentionResponses } from './mention-responses.js';
import { roleMentionResponses } from './role-mentions.js';

export const id = z.string().regex(/^\d{17,22}$/, 'Expected a Discord ID');
export const modules = [
  'logging',
  'moderation',
  'roles',
  'automod',
  'voice',
  'tickets',
  'onboarding',
  'community',
  'messages',
  'channels',
  'stats',
] as const;
export const logKinds = [
  'moderation',
  'messages',
  'members',
  'voice',
  'admin',
  'reports',
  'automod',
] as const;
export type LogKind = (typeof logKinds)[number];
export const configSchema = z
  .object({
    modules: z
      .record(z.enum(modules), z.boolean())
      .default(
        Object.fromEntries(modules.map((m) => [m, true])) as Record<
          (typeof modules)[number],
          boolean
        >,
      ),
    logs: z
      .record(z.enum(logKinds), id.optional())
      .default({} as Record<LogKind, string | undefined>),
    protectedRoles: z.array(id).max(25).default([]),
    staffRoles: z.array(id).max(10).default([]),
    excludedChannels: z.array(id).max(100).default([]),
    selfRoles: z.array(id).max(25).default([]),
    restoreRoles: z.array(id).max(25).default([]),
    rolePrerequisites: z.record(id, id).default({}),
    roleExclusiveGroups: z.array(z.array(id).min(2).max(25)).max(10).default([]),
    selfRoleExpiryMinutes: z.number().int().min(0).max(525600).default(0),
    welcomeChannel: id.optional(),
    publicWelcome: z.boolean().default(false),
    welcomeText: z.string().max(1500).default('Welcome {user} to {server}!'),
    goodbyeText: z.string().max(1500).default('{name} has left {server}.'),
    joinRole: id.optional(),
    joinRoles: z.array(id).max(25).default([]),
    rolesAfterScreening: z.boolean().default(true),
    welcomeDM: z.boolean().default(false),
    welcomeDMText: z
      .string()
      .trim()
      .min(1)
      .max(1500)
      .default(
        'Welcome {name} to {server}! Please read the rules, choose your community roles, and introduce yourself.',
      ),
    rulesChannel: id.optional(),
    rolesChannel: id.optional(),
    rolesSource: z.enum(['channel', 'native', 'none']).default('channel'),
    introductionChannel: id.optional(),
    textEffects: z
      .object({
        enabled: z.boolean().default(true),
        channels: z.array(id).max(100).default([]),
      })
      .default(() => ({ enabled: true, channels: [] })),
    uwuLock: z
      .object({
        enabled: z.boolean().default(true),
        channels: z.array(id).max(100).default([]),
      })
      .default(() => ({ enabled: true, channels: [] })),
    mentionReplies: z
      .object({
        enabled: z.boolean().default(true),
        commandsChannel: id.optional(),
        responses: z
          .array(z.string().trim().min(1).max(250))
          .min(1)
          .max(50)
          .default(() => [...defaultMentionResponses]),
      })
      .default(() => ({ enabled: true, responses: [...defaultMentionResponses] })),
    roleMentions: z
      .object({
        enabled: z.boolean().default(false),
        roles: z.array(id).max(25).default([]),
        exemptRoles: z.array(id).max(25).default([]),
        supportChannel: id.optional(),
        channel: id.optional(),
        repeatLimit: z.number().int().min(2).max(20).default(3),
        windowSeconds: z.number().int().min(5).max(300).default(30),
        responses: z
          .array(z.string().trim().min(1).max(250))
          .min(1)
          .max(50)
          .default(() => [...roleMentionResponses]),
      })
      .default(() => ({
        enabled: false,
        roles: [],
        exemptRoles: [],
        repeatLimit: 3,
        windowSeconds: 30,
        responses: [...roleMentionResponses],
      })),
    starboard: z
      .object({
        enabled: z.boolean().default(false),
        channel: id.optional(),
        threshold: z.number().int().min(1).max(100).default(1),
        selfStars: z.boolean().default(true),
      })
      .default(() => ({ enabled: false, threshold: 1, selfStars: true })),
    verifiedRole: id.optional(),
    verificationReview: z.boolean().default(false),
    verificationPaused: z.boolean().default(false),
    secondApproval: z.boolean().default(false),
    warningThreshold: z.number().int().min(0).max(20).default(0),
    warningAction: z.enum(['none', 'timeout', 'kick']).default('timeout'),
    warningTimeoutMinutes: z.number().int().min(1).max(1440).default(10),
    ticketCategory: id.optional(),
    voiceLobby: id.optional(),
    voiceCategory: id.optional(),
    // Read legacy exports, but use Discord's built-in voice text chat for new rooms.
    voiceCompanion: z
      .boolean()
      .transform(() => false)
      .default(false),
    voiceNoticeChannel: id.optional(),
    heartbeat: z
      .object({
        enabled: z.boolean().default(false),
        channel: id.optional(),
        minutes: z.number().int().min(1).max(1440).default(5),
      })
      .default(() => ({ enabled: false, minutes: 5 })),
    easterEggText: z
      .string()
      .trim()
      .min(1)
      .max(1500)
      .default(
        'You found the secret room. 🗝️ Behind every great server is a little chaos, a lot of late nights, and someone who refuses to leave things unfinished.',
      ),
    confessions: z
      .object({
        enabled: z.boolean().default(false),
        channel: id.optional(),
        reviewChannel: id.optional(),
        reviewRequired: z.boolean().default(true),
        privacy: z
          .enum(['unlinked', 'internal', 'staff'])
          .transform((value) => (value === 'staff' ? ('internal' as const) : value))
          .default('internal'),
        // Accept older exports; no command waiting period is enforced anymore.
        cooldownSeconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .transform(() => 0)
          .default(0),
      })
      .default(() => ({
        enabled: false,
        privacy: 'internal' as const,
        reviewRequired: true,
        cooldownSeconds: 0,
      })),
    snapshotDays: z.number().int().min(0).max(30).default(0),
    retentionDays: z.number().int().min(7).max(365).default(90),
    automod: z
      .object({
        mode: z.enum(['report', 'delete', 'timeout']).default('report'),
        windowSeconds: z.number().int().min(3).max(60).default(8),
        messageLimit: z.number().int().min(3).max(50).default(7),
        repeatLimit: z.number().int().min(2).max(20).default(4),
        mentionLimit: z.number().int().min(2).max(50).default(6),
        attachmentLimit: z.number().int().min(2).max(50).default(10),
        blockInvites: z.boolean().default(false),
        blockedDomains: z
          .array(z.string().regex(/^[a-z0-9.-]+$/i))
          .max(100)
          .default([]),
        exemptRoles: z.array(id).max(25).default([]),
        exemptChannels: z.array(id).max(100).default([]),
        timeoutMinutes: z.number().int().min(1).max(60).default(5),
        joinLimit: z.number().int().min(3).max(50).default(8),
        joinWindowSeconds: z.number().int().min(10).max(300).default(60),
        youngAccountDays: z.number().int().min(0).max(90).default(7),
      })
      .default(() => ({
        mode: 'report' as const,
        windowSeconds: 8,
        messageLimit: 7,
        repeatLimit: 4,
        mentionLimit: 6,
        attachmentLimit: 10,
        blockInvites: false,
        blockedDomains: [],
        exemptRoles: [],
        exemptChannels: [],
        timeoutMinutes: 5,
        joinLimit: 8,
        joinWindowSeconds: 60,
        youngAccountDays: 7,
      })),
  })
  .strict();
export type GuildConfig = z.infer<typeof configSchema>;
export function defaultConfig(): GuildConfig {
  return configSchema.parse({});
}

export function environment() {
  const schema = z.object({
    DISCORD_TOKEN: z.string().min(20),
    DISCORD_CLIENT_ID: id,
    DISCORD_GUILD_ID: id,
    DATABASE_PATH: z.string().default('./data/bot.sqlite'),
    BACKUP_DIR: z.string().default('./backups'),
  });
  const result = schema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. Copy .env.temp to .env and set the three Discord values.`,
    );
  return result.data;
}
