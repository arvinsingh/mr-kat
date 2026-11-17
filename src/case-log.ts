import type { App } from './types.js';
import type { Delivery } from './dm.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { privateLogChannel } from './logging.js';
import { textChannel } from './discord.js';
import { modernEdit } from './presentation.js';
import { logError } from './util.js';
import { noMentions } from './ui.js';

export interface CaseLog {
  url?: string;
  delivery: Delivery | 'pending';
  duration?: string;
}
export async function caseDelivery(app: App, id: number, delivery: Delivery) {
  const saved = app.store.get<CaseLog>(app.guildId, 'caseLog', String(id));
  app.store.put(app.guildId, 'caseLog', String(id), { ...saved, delivery });
  const link =
    saved?.url && /^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/.exec(saved.url);
  if (!link || link[1] !== app.guildId || app.store.config(app.guildId).logs.moderation !== link[2])
    return;
  try {
    const channel = await textChannel(app, app.guildId, link[2]!);
    await privateLogChannel(app, channel);
    const message = await channel.messages.fetch(link[3]!);
    if (message.embeds.length) {
      const embeds = message.embeds.map((embed) => EmbedBuilder.from(embed));
      for (const embed of embeds)
        if (embed.data.description)
          embed.setDescription(
            embed.data.description.replace(/^Member DM: pending$/m, 'Member DM: ' + delivery),
          );
      await message.edit({ embeds, allowedMentions: noMentions });
      return;
    }
    // Retained V2 case cards from previous releases must remain editable.
    const components = message.components.map((component) => component.toJSON());
    const update = (node: any) => {
      if (typeof node.content === 'string')
        node.content = node.content.replace(/^Member DM: pending$/m, 'Member DM: ' + delivery);
      for (const child of node.components ?? []) update(child);
    };
    for (const component of components) update(component);
    await message.edit(
      modernEdit({ components, flags: MessageFlags.SuppressEmbeds, allowedMentions: noMentions }),
    );
  } catch (error) {
    logError('case DM status update', error);
    await app.audit(
      app.guildId,
      'admin',
      'Case notification status unavailable',
      `Case #${id}: member DM status is ${delivery}, but its card could not be updated. The case remains recorded.`,
      { force: true },
    );
  }
}
