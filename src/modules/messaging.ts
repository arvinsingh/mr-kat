import { PermissionFlagsBits as P } from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { enabled, requirePermission } from '../permissions.js';
import { assert, safe, safeMentions, renderTemplate } from '../util.js';
import { confirm, reply, type Confirmation } from '../ui.js';
import { directMessage } from '../dm.js';

export async function deliverStaffDM(app: App, i: Interaction, pending: Confirmation) {
  enabled(app, i.guildId!, 'messages');
  await requirePermission(app, i, P.ManageGuild);
  const target = await i.guild!.members.fetch(String(pending.payload.target));
  assert(!target.user.bot, 'Choose a human server member.');
  const result = await directMessage(
    app,
    target.id,
    `${i.guild!.name.slice(0, 180)} · staff notice`,
    `${safe(pending.payload.text, 2200)}\n\nSent by the server staff. This is a one-way notice; replies to this bot are not monitored.`,
  );
  await app.audit(
    i.guildId!,
    'moderation',
    'Staff DM delivery',
    `Staff: <@${i.user.id}> · Recipient: <@${target.id}> · ${result}\nReason: ${safeMentions(pending.payload.reason)}\nMessage body is not logged.`,
  );
  await reply(i, {
    content: `DM delivery: ${result}. ${result === 'uncertain' ? 'Check with the recipient before retrying; it may have arrived.' : ''}`,
    components: [],
  });
}
export const messaging: Module = {
  commands: {
    dm: async (app, i) => {
      enabled(app, i.guildId, 'messages');
      await requirePermission(app, i, P.ManageGuild);
      const action = i.options.getSubcommand();
      const name = i.options.getString('name');
      if (name)
        assert(
          /^[a-z0-9_-]{1,32}$/i.test(name),
          'Use a template name with 1–32 letters, digits, underscores or hyphens.',
        );
      if (action === 'template') {
        assert(
          app.store.get(i.guildId, 'dmTemplate', name!) ||
            app.store.entries(i.guildId, 'dmTemplate', 101).length < 100,
          'Maximum 100 templates.',
        );
        app.store.put(i.guildId, 'dmTemplate', name!, { text: i.options.getString('text', true) });
        await reply(i, 'Template saved. Placeholders: {name}, {user}, {server}.');
        return;
      }
      if (action === 'templates') {
        await reply(
          i,
          app.store
            .entries(i.guildId, 'dmTemplate', 100)
            .map((e) => safe(e.key))
            .join('\n') || 'No DM templates saved.',
        );
        return;
      }
      assert(action === 'send' || action === 'from-template', 'Unknown DM action.');
      const target = i.options.getUser('member', true);
      assert(!target.bot, 'Choose a human server member.');
      await i.guild.members.fetch(target.id);
      const template =
        action === 'from-template'
          ? app.store.get<{ text: string }>(i.guildId, 'dmTemplate', name!)
          : undefined;
      assert(action !== 'from-template' || template, 'Template not found.');
      const text = template
        ? renderTemplate(template.text, target, i.guild.name)
        : i.options.getString('message', true);
      await confirm(
        app,
        i,
        `Send one DM to ${safe(target.tag)}?\n\n${safe(text, 1200)}`,
        'staffDM',
        { target: target.id, text, reason: i.options.getString('reason', true) },
      );
    },
  },
};
