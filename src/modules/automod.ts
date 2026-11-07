import {
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType as Trigger,
  AutoModerationActionType,
  PermissionFlagsBits as P,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { requirePermission, botPermission, enabled, owner } from '../permissions.js';
import { reply } from '../ui.js';
import { assert, safe } from '../util.js';
import { id } from '../config.js';

async function status(app: App, i: Interaction, panel = false) {
  const cfg = app.store.config(i.guildId!);
  const me = await i.guild!.members.fetchMe();
  const native = me.permissions.has(P.ManageGuild);
  const rows = panel
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...(['report', 'delete', 'timeout'] as const).map((mode) =>
            new ButtonBuilder()
              .setCustomId(`automodMode:${mode}`)
              .setLabel(
                mode === 'report'
                  ? 'Report only'
                  : mode === 'delete'
                    ? 'Delete spam'
                    : 'Delete + timeout',
              )
              .setStyle(cfg.automod.mode === mode ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ),
      ]
    : [];
  await reply(i, {
    content: [
      '**Bot spam detector**',
      `Module: ${cfg.modules.automod ? 'enabled' : 'disabled'} · Mode: **${cfg.automod.mode}**`,
      `Window: ${cfg.automod.windowSeconds}s · Messages: ${cfg.automod.messageLimit} · Repeats: ${cfg.automod.repeatLimit} · Mentions: ${cfg.automod.mentionLimit}`,
      `Invites: ${cfg.automod.blockInvites ? 'blocked' : 'allowed'} · Log destination: ${cfg.logs.automod ? `<#${cfg.logs.automod}>` : 'not configured'}`,
      `Bot permissions: Manage Messages ${me.permissions.has(P.ManageMessages) ? '✓' : 'missing'}; Moderate Members ${me.permissions.has(P.ModerateMembers) ? '✓' : 'missing'} (channel overrides also apply).`,
      '',
      '**Native Discord AutoMod**',
      native
        ? 'Manage Server: granted. Use /automod list to inspect native rules.'
        : 'Missing **Manage Server** on the bot role. Permission checkboxes do not create rules.',
      'Native rules are separate from the bot detector. Configure them with /automod keyword or /automod mentions; they operate even when the bot is offline.',
      'Test native rules using an ordinary member account: Discord exempts Administrator and Manage Server members. The bot detector exempts administrators, bots, and configured roles/channels.',
      'Owner: /automod configure or the buttons change the bot response. Report mode reports detections without deleting or timing out.',
    ].join('\n'),
    components: rows,
  });
}
export const automod: Module = {
  commands: {
    automod: async (app, i) => {
      await requirePermission(app, i, P.ManageGuild);
      const action = i.options.getSubcommand();
      if (['show', 'status', 'panel'].includes(action)) {
        if (action === 'panel') owner(i);
        await status(app, i, action === 'panel');
        return;
      }
      const cfg = app.store.config(i.guildId);
      if (action === 'mode' || action === 'configure') {
        owner(i);
        enabled(app, i.guildId, 'automod');
        const mode = i.options.getString(action === 'mode' ? 'value' : 'mode');
        if (mode) cfg.automod.mode = mode as typeof cfg.automod.mode;
        if (action === 'configure') {
          for (const [option, key] of [
            ['messages', 'messageLimit'],
            ['seconds', 'windowSeconds'],
            ['repeats', 'repeatLimit'],
            ['mentions', 'mentionLimit'],
          ] as const) {
            const value = i.options.getInteger(option);
            if (value !== null) cfg.automod[key] = value;
          }
          const invites = i.options.getBoolean('block_invites');
          if (invites !== null) cfg.automod.blockInvites = invites;
        }
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await status(app, i, true);
        return;
      }
      await botPermission(i.guild, P.ManageGuild);
      const rules = await i.guild.autoModerationRules.fetch();
      if (action === 'list') {
        await reply(
          i,
          [...rules.values()]
            .map(
              (rule) =>
                `${rule.id} · ${safe(rule.name, 80)} · ${rule.enabled ? 'enabled' : 'disabled'} · trigger ${rule.triggerType} · ${rule.creatorId === app.client.user!.id ? 'owned by this bot' : 'managed elsewhere'}`,
            )
            .join('\n')
            .slice(0, 1850) ||
            'No native AutoMod rules. Granting permissions alone does not create any.',
        );
        return;
      }
      if (action === 'toggle') {
        const rule = rules.get(id.parse(i.options.getString('rule_id', true)));
        assert(rule, 'Native rule not found.');
        assert(
          rule.creatorId === app.client.user!.id,
          'This command only changes native rules created by this bot. Manage other rules in Discord Server Settings.',
        );
        await rule.edit({
          enabled: i.options.getString('state', true) === 'on',
          reason: `By ${i.user.id}`,
        });
        await reply(i, 'Native rule updated.');
        return;
      }
      assert(action === 'keyword' || action === 'mentions', 'Unknown AutoMod action.');
      assert(
        cfg.automod.exemptRoles.length <= 20 && cfg.automod.exemptChannels.length <= 50,
        'Native Discord rules support at most 20 exempt roles and 50 exempt channels. Reduce the exemptions before creating a native rule.',
      );
      const trigger = action === 'keyword' ? Trigger.Keyword : Trigger.MentionSpam;
      const name =
        action === 'keyword'
          ? i.options.getString('name', true).slice(0, 100)
          : 'mr-kat mention protection';
      const existing = rules.find(
        (rule) =>
          rule.creatorId === app.client.user!.id &&
          rule.triggerType === trigger &&
          (action === 'mentions' || rule.name === name),
      );
      const count = rules.filter((rule) => rule.triggerType === trigger).size;
      assert(
        existing || count < (trigger === Trigger.Keyword ? 6 : 1),
        action === 'mentions'
          ? 'Discord permits one mention-spam rule. An existing rule is managed elsewhere; edit it in Server Settings → AutoMod.'
          : 'Discord permits six keyword rules. Edit an existing bot rule using its same name, or remove an unused rule in Server Settings → AutoMod.',
      );
      const words =
        action === 'keyword'
          ? [
              ...new Set(
                i.options
                  .getString('words', true)
                  .split(',')
                  .map((word) => word.trim())
                  .filter(Boolean),
              ),
            ]
          : [];
      if (action === 'keyword')
        assert(
          words.length > 0 && words.length <= 100 && words.every((word) => word.length <= 60),
          'Supply 1–100 words, each at most 60 characters.',
        );
      const common = {
        name,
        triggerMetadata:
          action === 'keyword'
            ? { keywordFilter: words }
            : {
                mentionTotalLimit: i.options.getInteger('limit', true),
                mentionRaidProtectionEnabled: true,
              },
        actions: [{ type: AutoModerationActionType.BlockMessage }],
        enabled: true,
        exemptRoles: cfg.automod.exemptRoles,
        exemptChannels: cfg.automod.exemptChannels,
        reason: `By ${i.user.id}`,
      };
      const rule = existing
        ? await existing.edit(common)
        : await i.guild.autoModerationRules.create({
            ...common,
            eventType: AutoModerationRuleEventType.MessageSend,
            triggerType: trigger,
          });
      await reply(
        i,
        `Native rule ${existing ? 'updated' : 'created'}: ${safe(rule.name, 100)} (${rule.id}). It is enabled and blocks matching messages. Test with a normal member account; administrators and Manage Server members are exempt.`,
      );
    },
  },
  component: async (app, i) => {
    if (!i.isButton() || !i.customId.startsWith('automodMode:')) return false;
    owner(i);
    await requirePermission(app, i, P.ManageGuild);
    enabled(app, i.guildId, 'automod');
    const value = i.customId.split(':')[1];
    assert(
      value === 'report' || value === 'delete' || value === 'timeout',
      'Unknown response mode.',
    );
    const cfg = app.store.config(i.guildId);
    cfg.automod.mode = value;
    app.store.setConfig(i.guildId, cfg, i.user.id);
    await status(app, i, true);
    return true;
  },
};
