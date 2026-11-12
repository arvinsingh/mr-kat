import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits as P } from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { enabled, owner, requirePermission } from '../permissions.js';
import { assert } from '../util.js';
import { reply, type Confirmation } from '../ui.js';
import { revokeWarning } from '../warnings.js';
import {
  openWarningPanel,
  warningPanelControl,
  previewWarningPolicy,
  currentWarningPolicy,
  sameWarningPolicy,
  type WarningPolicy,
} from '../warning-panel.js';

export async function applyWarningPolicy(app: App, i: Interaction, pending: Confirmation) {
  owner(i);
  await requirePermission(app, i, P.ManageGuild);
  const cfg = app.store.config(i.guildId!);
  if (pending.payload.base)
    assert(
      sameWarningPolicy(currentWarningPolicy(cfg), pending.payload.base as WarningPolicy),
      'The warning policy changed since preview. Reload and review it again.',
    );
  cfg.warningThreshold = Number(pending.payload.threshold);
  cfg.warningAction = pending.payload.action as typeof cfg.warningAction;
  cfg.warningTimeoutMinutes = Number(pending.payload.minutes);
  app.store.setConfig(i.guildId!, cfg, i.user.id);
  await reply(i, {
    content: `Warning policy saved: ${cfg.warningThreshold && cfg.warningAction !== 'none' ? cfg.warningAction + ' at ' + cfg.warningThreshold + ' active warnings' : 'automatic escalation disabled'}. Applies to future warnings; existing members are not punished retroactively. Revoked/expired warnings do not count. Automatic kicks respect second-staff approval when enabled.`,
    components: pending.payload.panelKey
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`warnings:policy:${pending.payload.panelKey}`)
              .setLabel('Back to warning policy')
              .setStyle(ButtonStyle.Secondary),
          ),
        ]
      : [],
  });
}
export const warnings: Module = {
  commands: {
    warnings: async (app, i) => {
      enabled(app, i.guildId, 'moderation');
      const action = i.options.getSubcommand();
      if (action === 'list' || action === 'panel') {
        await openWarningPanel(app, i, i.options.getUser('member')?.id ?? i.user.id);
        return;
      }
      await requirePermission(app, i, P.ModerateMembers);
      if (action === 'revoke') {
        const result = await revokeWarning(
          app,
          i,
          i.options.getInteger('case', true),
          i.options.getString('reason', true),
        );
        await reply(i, `Warning revoked. Active warnings: ${result.active}. DM: ${result.dm}.`);
        return;
      }
      const cfg = app.store.config(i.guildId);
      if (action === 'status') {
        await reply(
          i,
          `Warning policy: ${cfg.warningThreshold > 0 && cfg.warningAction !== 'none' ? cfg.warningAction + ' at ' + cfg.warningThreshold + ' active warnings' : 'automatic escalation disabled'}. Timeout: ${cfg.warningTimeoutMinutes} minutes. Second-staff approval for kicks: ${cfg.secondApproval ? 'required' : 'off'}. Only active retained warnings count. Accepted warning appeals revoke the warning; historical enforcement is not automatically undone.`,
        );
        return;
      }
      owner(i);
      await requirePermission(app, i, P.ManageGuild);
      const threshold = i.options.getInteger('threshold', true),
        mode = i.options.getString('action', true),
        minutes = i.options.getInteger('timeout_minutes') ?? cfg.warningTimeoutMinutes;
      assert(['none', 'timeout', 'kick'].includes(mode), 'Choose none, timeout or kick.');
      await previewWarningPolicy(
        app,
        i,
        { threshold, action: mode as WarningPolicy['action'], minutes },
        currentWarningPolicy(cfg),
      );
    },
  },
  component: warningPanelControl,
};
