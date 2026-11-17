import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { findTopic, manualText, indexText, splitPages, topics, type Audience } from '../manual.js';
import { guideMarkdown } from '../guides.js';
import { assert } from '../util.js';
import { reply } from '../ui.js';

async function show(i: Interaction, path: string, group: Audience | 'all', page: number) {
  const topic = path ? findTopic(path) : undefined;
  assert(
    !path || topic,
    'Unknown manual topic. Try /help or include the exact command and subcommand, e.g. voice setup.',
  );
  const pages = splitPages(topic ? manualText(topic) : indexText(group));
  assert(page >= 1 && page <= pages.length, `This topic has ${pages.length} page(s).`);
  const token = topic ? topic.path.replaceAll(' ', '.') : '-';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`help:${i.user.id}:${group}:${page - 1}:${token}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(`help:${i.user.id}:${group}:${page + 1}:${token}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === pages.length),
  );
  await reply(i, {
    content: `## ${topic ? `Command manual · /${topic.path}` : 'Explore the bot'}\n${pages[page - 1]}\n\n-# Page ${page}/${pages.length} · ${topic ? `/man command:${topic.path}` : `/help audience:${group}`}`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`help:${i.user.id}:audience`)
          .setPlaceholder('Choose a guide')
          .addOptions(
            ['members', 'moderators', 'owners', 'all'].map((value) => ({
              label:
                value === 'all'
                  ? 'All features'
                  : `${value[0]!.toUpperCase()}${value.slice(1)} guide`,
              value,
              default: group === value,
            })),
          ),
      ),
      ...featureMenus(i.user.id, group),
      row,
    ],
  });
}
function featureMenus(actor: string, group: Audience | 'all') {
  const roots = topics.filter((topic) => !topic.path.includes(' '));
  const menus: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let offset = 0; offset < roots.length; offset += 25)
    menus.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`help:${actor}:topic:${group}${offset ? ':' + offset : ''}`)
          .setPlaceholder(
            `Explore a feature · ${Math.floor(offset / 25) + 1}/${Math.ceil(roots.length / 25)}`,
          )
          .addOptions(
            roots.slice(offset, offset + 25).map((topic) => ({
              label: '/' + topic.path,
              value: topic.path,
              description: topic.description.slice(0, 100),
            })),
          ),
      ),
    );
  return menus;
}

async function command(_app: App, i: Parameters<NonNullable<Module['commands']>[string]>[1]) {
  const guide = i.commandName === 'help' ? i.options.getString('guide') : null;
  if (guide) {
    assert(guide === 'members' || guide === 'moderators' || guide === 'owners', 'Unknown guide.');
    await reply(i, {
      content:
        'Copy each numbered block into a separate Discord message. Moderator and owner guides belong in staff channels.',
      files: [
        new AttachmentBuilder(Buffer.from(guideMarkdown(guide)), {
          name: `DISCORD-${guide.toUpperCase()}.md`,
        }),
      ],
    });
    return;
  }
  const group = (i.commandName === 'help' ? i.options.getString('audience') : null) ?? 'members';
  assert(['members', 'moderators', 'owners', 'all'].includes(group), 'Unknown audience.');
  await show(
    i,
    i.options.getString('command') ?? '',
    group as Audience | 'all',
    i.options.getInteger('page') ?? 1,
  );
}
export const help: Module = {
  commands: { help: command, man: command },
  component: async (_app, i) => {
    if (i.isStringSelectMenu?.() && i.customId.startsWith('help:')) {
      const [, actor, action, audience] = i.customId.split(':');
      assert(
        actor === i.user.id,
        'These help controls belong to another member. Run /help yourself.',
      );
      const group = action === 'audience' ? i.values[0] : audience;
      assert(
        group && ['members', 'moderators', 'owners', 'all'].includes(group),
        'Invalid help audience.',
      );
      assert(action === 'audience' || action === 'topic', 'Unknown help control.');
      await show(i, action === 'topic' ? i.values[0]! : '', group as Audience | 'all', 1);
      return true;
    }
    if (!i.isButton() || !i.customId.startsWith('help:')) return false;
    const [, actor, group, page, topic] = i.customId.split(':');
    assert(
      actor === i.user.id,
      'These help controls belong to another member. Run /help yourself.',
    );
    assert(
      group && ['members', 'moderators', 'owners', 'all'].includes(group),
      'Invalid help audience.',
    );
    await show(
      i,
      topic === '-' ? '' : topic!.replaceAll('.', ' '),
      group as Audience | 'all',
      Number(page),
    );
    return true;
  },
};
