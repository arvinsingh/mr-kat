import type { GuildBasedChannel } from 'discord.js';

export function channelSettingChanges(
  old: GuildBasedChannel,
  channel: GuildBasedChannel,
): string[] {
  const settings = (value: GuildBasedChannel): Record<string, unknown> => ({
    name: value.name,
    type: value.type,
    category: value.parentId,
    ...('position' in value ? { position: value.position } : {}),
    ...('topic' in value ? { topic: value.topic } : {}),
    ...('nsfw' in value ? { nsfw: value.nsfw } : {}),
    ...('rateLimitPerUser' in value ? { slowmode: value.rateLimitPerUser } : {}),
    ...('bitrate' in value ? { bitrate: value.bitrate } : {}),
    ...('userLimit' in value ? { userLimit: value.userLimit } : {}),
    ...('rtcRegion' in value ? { rtcRegion: value.rtcRegion } : {}),
    ...('videoQualityMode' in value ? { videoQuality: value.videoQualityMode } : {}),
    ...('defaultAutoArchiveDuration' in value
      ? { autoArchive: value.defaultAutoArchiveDuration }
      : {}),
    ...('availableTags' in value ? { tags: value.availableTags } : {}),
    ...('defaultReactionEmoji' in value ? { reaction: value.defaultReactionEmoji } : {}),
    ...('permissionOverwrites' in value
      ? {
          permissions: value.permissionOverwrites.cache
            .map((overwrite) => [
              overwrite.id,
              overwrite.type,
              overwrite.allow.bitfield.toString(),
              overwrite.deny.bitfield.toString(),
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        }
      : {}),
  });
  const before = settings(old);
  const after = settings(channel);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}
