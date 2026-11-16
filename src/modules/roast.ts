import {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits as P,
} from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { destination } from '../discord.js';
import { assert } from '../util.js';
import { reply, noMentions } from '../ui.js';
import { sendModern } from '../presentation.js';
import { chooseRoast, roastAllowed, roastChannelAllowed } from '../roasts.js';
import { openRoastSetup, roastSetupControl } from '../roast-setup.js';
import { submitRoast, reviewRoast } from '../roast-reviews.js';

async function preferences(app: App, i: Interaction) {
  const allowed = roastAllowed(app, i.user.id),
    prefix = `roastPrefs:${i.user.id}:`;
  await reply(i, {
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## Roast preferences\n**${allowed ? 'Allowed' : 'Disallowed'}**\n${allowed ? 'Others can roast you, and you can roast others.' : 'Others cannot roast you, and you cannot roast others. You can still roast yourself.'}`,
          ),
        )
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent('Join the roast pool'))
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(prefix + 'allow')
                .setLabel('Allow')
                .setStyle(ButtonStyle.Success)
                .setDisabled(allowed),
            ),
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent('Opt out in both directions'),
            )
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(prefix + 'disallow')
                .setLabel('Disallow')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!allowed),
            ),
        ),
    ],
    allowedMentions: noMentions,
  });
}
export const roast: Module = {
  commands: {
    roast: async (app, i) => {
      const action = i.options.getSubcommand();
      if (action === 'preferences') return preferences(app, i);
      if (action === 'setup') return openRoastSetup(app, i);
      if (action === 'add') return submitRoast(app, i);
      assert(action === 'user' || action === 'me', 'Unknown roast command.');
      const channel = await destination(app, i, i.channelId);
      roastChannelAllowed(app, channel);
      const targetId = action === 'me' ? i.user.id : i.options.getUser('member', true).id;
      const target = await i.guild.members.fetch(targetId);
      assert(
        channel.permissionsFor(target)?.has([P.ViewChannel, P.ReadMessageHistory]),
        'That member cannot view this channel.',
      );
      // Recheck after asynchronous lookups so an opt-out during validation takes effect.
      roastChannelAllowed(app, channel);
      if (targetId !== i.user.id) {
        assert(
          roastAllowed(app, i.user.id),
          'You opted out of roasts. Allow them in /roast preferences before roasting others.',
        );
        assert(roastAllowed(app, targetId), 'That member has opted out of roasts.');
      }
      assert(!app.store.get(i.guildId, 'roastReceipt', i.id), 'This roast was already attempted.');
      const text = chooseRoast(app, channel.id, targetId === app.client.user!.id);
      const mention = `<@${targetId}>`;
      const content = `🔥 ${text.includes('{target}') ? text.replaceAll('{target}', mention) : `${mention}, ${text}`}`;
      app.store.put(i.guildId, 'roastReceipt', i.id, {
        kind: 'roast',
        channel: channel.id,
        state: 'started',
      });
      try {
        const posted = await sendModern(channel, {
          content,
          allowedMentions: noMentions,
          nonce: i.id.slice(-24),
          enforceNonce: true,
        });
        app.store.put(i.guildId, 'roastReceipt', i.id, {
          kind: 'roast',
          channel: channel.id,
          state: 'sent',
          message: posted.id,
        });
      } catch {
        await reply(i, 'Delivery could not be confirmed. Check the channel before trying again.');
        return;
      }
      await reply(i, 'Roast served. 🔥');
    },
  },
  component: async (app, i) => {
    if (i.customId.startsWith('roastPrefs:')) {
      const [, actor, action] = i.customId.split(':');
      assert(
        actor === i.user.id && ['allow', 'disallow'].includes(action!),
        'Use your own /roast preferences panel.',
      );
      app.store.put(i.guildId!, 'roastPreference', i.user.id, { allowed: action === 'allow' });
      await preferences(app, i);
      return true;
    }
    if (i.customId.startsWith('roastSetup:')) {
      await roastSetupControl(app, i);
      return true;
    }
    if (i.customId.startsWith('roastReview:')) {
      await reviewRoast(app, i);
      return true;
    }
    return false;
  },
};
