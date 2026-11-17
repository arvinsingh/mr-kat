import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits as P } from 'discord.js';
import type { App, Module, Interaction } from '../types.js';
import { requirePermission, botPermission, enabled, safeRole } from '../permissions.js';
import { assert, safe } from '../util.js';
import { reply, embed, noMentions } from '../ui.js';
import { destination } from '../discord.js';
import { sendModern } from '../presentation.js';
import { logProfile } from '../log-profile.js';
export async function grantVerification(app: App, i: Interaction, target: string) {
  const cfg = app.store.config(i.guildId!);
  assert(!cfg.verificationPaused, 'Verification is temporarily paused.');
  assert(cfg.verifiedRole, 'Configure verifiedRole first.');
  const role = await i.guild!.roles.fetch(cfg.verifiedRole);
  assert(role, 'Verification role no longer exists.');
  safeRole(role);
  assert(!cfg.protectedRoles.includes(role.id), 'Verification role is protected.');
  const me = await botPermission(i.guild!, P.ManageRoles);
  assert(me.roles.highest.comparePositionTo(role) > 0, 'The bot needs a higher role.');
  const member = await i.guild!.members.fetch(target);
  await member.roles.add(role, 'Rules acknowledgement / staff verification');
  app.store.delete(i.guildId!, 'verification', target);
}
export const verification: Module = {
  commands: {
    verify: async (app, i) => {
      enabled(app, i.guildId, 'onboarding');
      await requirePermission(app, i, P.ManageGuild);
      const action = i.options.getSubcommand();
      const cfg = app.store.config(i.guildId);
      if (action === 'panel') {
        assert(cfg.verifiedRole, 'Configure verifiedRole first.');
        const channel = await destination(app, i, i.options.getChannel('channel', true).id);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('verify:ack')
            .setLabel('I agree to the rules')
            .setStyle(ButtonStyle.Success),
        );
        const message = await sendModern(channel, {
          embeds: [embed('Server rules', i.options.getString('rules', true))],
          components: [row],
          allowedMentions: noMentions,
        });
        app.store.put(i.guildId, 'verifyPanel', message.id, {});
        await reply(i, 'Rules acknowledgement panel published.');
        return;
      }
      if (action === 'pending') {
        await reply(
          i,
          app.store
            .entries<{ name: string }>(i.guildId, 'verification', 50)
            .map((e) => `<@${e.key}> · ${safe(e.data.name)}`)
            .join('\n') || 'No pending requests.',
        );
        return;
      }
      const target = i.options.getUser('member', true);
      assert(
        app.store.get(i.guildId, 'verification', target.id),
        'No pending verification request.',
      );
      if (action === 'approve') await grantVerification(app, i, target.id);
      else app.store.delete(i.guildId, 'verification', target.id);
      await app.audit(i.guildId, 'members', `Verification ${action}`, `Staff: <@${i.user.id}>`, {
        profile: logProfile(app, target.id, undefined, target),
      });
      await reply(i, `Request ${action} completed.`);
    },
  },
  component: async (app, i) => {
    if (i.isButton() && i.customId === 'verify:ack') {
      enabled(app, i.guildId, 'onboarding');
      assert(
        app.store.get(i.guildId, 'verifyPanel', i.message.id),
        'This verification panel is no longer valid.',
      );
      const cfg = app.store.config(i.guildId);
      assert(!cfg.verificationPaused, 'Verification is temporarily paused.');
      if (cfg.verificationReview) {
        assert(
          !app.store.get(i.guildId, 'verification', i.user.id),
          'Your request is already pending.',
        );
        app.store.put(i.guildId, 'verification', i.user.id, {
          name: i.user.tag,
          created: Date.now(),
        });
        await app.audit(
          i.guildId,
          'members',
          'Verification requested',
          'Acknowledged the rules. Waiting for staff review.',
          { profile: logProfile(app, i.user.id, i.member, i.user) },
        );
        await reply(i, 'Your request is waiting for staff approval.');
      } else {
        await grantVerification(app, i, i.user.id);
        await reply(i, 'Rules acknowledged. Your member role has been assigned.');
      }
      return true;
    }
    return false;
  },
};
