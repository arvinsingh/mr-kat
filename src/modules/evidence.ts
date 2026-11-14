import { modernModal } from '../presentation.js';
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits as P,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module } from '../types.js';
import { captureEvidence, type MessageEvidence } from '../evidence.js';
import { enabled, requirePermission } from '../permissions.js';
import { reply } from '../ui.js';
import { assert } from '../util.js';
import { moderateWithEvidence } from './moderation.js';

interface Draft {
  actor: string;
  channel: string;
  target: string;
  evidence: MessageEvidence;
  expires: number;
}

export async function moderationEvidenceMenu(
  app: App,
  i: MessageContextMenuCommandInteraction<'cached'>,
) {
  enabled(app, i.guildId, 'moderation');
  // The native permission for the chosen action is also checked on selection/submission.
  const member = await i.guild.members.fetch(i.user.id);
  assert(
    member.permissions.any([P.ModerateMembers, P.KickMembers, P.BanMembers]),
    'Moderation permissions are required.',
  );
  const cfg = app.store.config(i.guildId);
  assert(
    i.user.id === i.guild.ownerId ||
      !cfg.staffRoles.length ||
      cfg.staffRoles.some((r) => member.roles.cache.has(r)),
    'Staff allowlist check failed.',
  );
  const evidence = await captureEvidence(app, i, i.targetMessage);
  const key = randomUUID();
  app.store.put(i.guildId, 'moderationDraft', key, {
    actor: i.user.id,
    channel: i.channelId,
    target: evidence.author!,
    evidence,
    expires: Date.now() + 300000,
  } satisfies Draft);
  await reply(i, {
    content:
      'Message evidence captured. Choose an action; permissions and hierarchy are checked before it is applied.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`evidence:action:${key}`)
          .setPlaceholder('Moderation action')
          .addOptions(
            ['warn', 'kick', 'ban'].map((value) => ({
              label: value[0]!.toUpperCase() + value.slice(1),
              value,
            })),
          ),
      ),
    ],
  });
}

export const evidenceControls: Module = {
  component: async (app, i) => {
    if (!i.customId.startsWith('evidence:')) return false;
    const [, action, key] = i.customId.split(':');
    const draft = app.store.get<Draft>(i.guildId, 'moderationDraft', key!);
    assert(
      draft &&
        draft.actor === i.user.id &&
        draft.channel === i.channelId &&
        draft.expires > Date.now(),
      'This evidence form expired or belongs to someone else.',
    );
    enabled(app, i.guildId, 'moderation');
    if (i.isStringSelectMenu() && action === 'action') {
      const chosen = i.values[0]!;
      assert(['warn', 'kick', 'ban'].includes(chosen), 'Invalid moderation action.');
      await requirePermission(
        app,
        i,
        chosen === 'ban' ? P.BanMembers : chosen === 'kick' ? P.KickMembers : P.ModerateMembers,
      );
      await i.showModal(
        modernModal(
          new ModalBuilder()
            .setCustomId(`evidence:${chosen}:${key}`)
            .setTitle('Moderate with message evidence')
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId('reason')
                  .setLabel('Reason')
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
                  .setMaxLength(1900),
              ),
              ...(chosen === 'kick'
                ? []
                : [
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                      new TextInputBuilder()
                        .setCustomId('duration')
                        .setLabel(
                          chosen === 'warn'
                            ? 'Warning expiry, e.g. 30d (optional)'
                            : 'Ban duration, e.g. 7d (optional)',
                        )
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(30),
                    ),
                  ]),
            ),
        ),
      );
      return true;
    }
    assert(
      i.isModalSubmit() && ['warn', 'kick', 'ban'].includes(action!),
      'Unknown evidence control.',
    );
    // Consume before executing so duplicate submissions cannot apply the same warning twice.
    app.store.delete(i.guildId, 'moderationDraft', key!);
    await moderateWithEvidence(
      app,
      i,
      action!,
      draft.target,
      i.fields.getTextInputValue('reason'),
      action === 'kick' ? undefined : i.fields.getTextInputValue('duration') || undefined,
      draft.evidence,
    );
    return true;
  },
};
