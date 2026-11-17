import { auditChange } from './change-receipts.js';
import { randomUUID } from 'node:crypto';
import {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits as P,
} from 'discord.js';
import type { App, Interaction, Component } from './types.js';
import type { RoastConfig, RoastSubmission } from './roasts.js';
import { publicRoastBoard, roastSubmissions } from './roasts.js';
import { renderRoastSubmission } from './roast-reviews.js';
import { owner, requirePermission, botPermission } from './permissions.js';
import { textChannel } from './discord.js';
import { assert } from './util.js';
import { reply, noMentions } from './ui.js';

interface Panel {
  actor: string;
  expires: number;
  base: RoastConfig;
  draft: RoastConfig;
  scope: 'server' | 'channels';
  page: number;
  selected?: string;
  selectedStatus?: string;
}
const same = (a: RoastConfig, b: RoastConfig) => JSON.stringify(a) === JSON.stringify(b);
async function access(app: App, i: Interaction) {
  owner(i);
  await requirePermission(app, i, P.ManageGuild);
}
export async function validateRoastConfig(app: App, cfg: RoastConfig) {
  for (const id of cfg.channels) {
    const channel = await textChannel(app, app.guildId, id);
    assert(
      !channel.isThread() &&
        [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice].includes(
          channel.type,
        ),
      'Choose a text, announcement or voice channel; its threads are included.',
    );
    await botPermission(channel.guild, [P.SendMessages, P.ReadMessageHistory], channel);
  }
  if (cfg.reviewChannel) await publicRoastBoard(app, cfg.reviewChannel);
}
function persist(app: App, key: string, panel: Panel) {
  app.store.put(app.guildId, 'roastPanel', key, panel);
}
async function settings(_app: App, i: Interaction, key: string, panel: Panel, saved = false) {
  const prefix = `roastSetup:${panel.actor}:${key}:`;
  const card = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Roast setup${saved ? ' · Saved' : ''}\nEveryone is allowed by default. Preferences always apply.\n**Scope:** ${panel.scope === 'server' ? 'Server-wide' : 'Selected channels'}\n**Submission board:** ${panel.draft.reviewChannel ? `<#${panel.draft.reviewChannel}>` : 'Not selected; built-in roasts still work.'}`,
    ),
  );
  card.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `Roasts are **${panel.draft.enabled ? 'enabled' : 'disabled'}**${same(panel.base, panel.draft) ? '.' : ' in this draft.'}`,
        ),
      )
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(prefix + 'toggle')
          .setLabel(panel.draft.enabled ? 'Disable' : 'Enable')
          .setStyle(ButtonStyle.Secondary),
      ),
  );
  card.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(prefix + 'scope')
        .setPlaceholder('Where roasts can be used')
        .addOptions(
          { label: 'Server-wide', value: 'server', default: panel.scope === 'server' },
          {
            label: 'Selected channels and their threads',
            value: 'channels',
            default: panel.scope === 'channels',
          },
        ),
    ),
  );
  if (panel.scope === 'channels') {
    const picker = new ChannelSelectMenuBuilder()
      .setCustomId(prefix + 'channels')
      .setPlaceholder('Choose roast channels')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice)
      .setMinValues(1)
      .setMaxValues(25);
    if (panel.draft.channels.length) picker.setDefaultChannels(...panel.draft.channels);
    card.addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(picker),
    );
  }
  const board = new ChannelSelectMenuBuilder()
    .setCustomId(prefix + 'board')
    .setPlaceholder('Public submission board · #suggestions is fine')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  if (panel.draft.reviewChannel) board.setDefaultChannels(panel.draft.reviewChannel);
  card.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(board),
  );
  card.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(prefix + 'save')
        .setLabel('Save changes')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(prefix + 'reload')
        .setLabel('Reload saved')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(prefix + 'library')
        .setLabel('Custom roasts')
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  await reply(i, { components: [card], allowedMentions: noMentions });
}
async function library(app: App, i: Interaction, key: string, panel: Panel) {
  const entries = roastSubmissions(app).filter((entry) =>
    ['approved', 'disabled'].includes(entry.data.status),
  );
  const pages = Math.max(1, Math.ceil(entries.length / 10));
  panel.page = Math.min(Math.max(0, panel.page), pages - 1);
  const current = entries.find((entry) => entry.key === panel.selected);
  const prefix = `roastSetup:${panel.actor}:${key}:`;
  const card = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Custom roasts\n${entries.length} reviewed entries · Page ${panel.page + 1}/${pages}\n${current ? `**${current.data.status} · ${current.key}**\n${current.data.text}` : 'Choose a roast to enable or disable. Built-in lines stay available.'}`,
    ),
  );
  const page = entries.slice(panel.page * 10, panel.page * 10 + 10);
  if (page.length)
    card.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(prefix + 'select')
          .setPlaceholder('Choose an approved custom roast')
          .addOptions(
            page.map((entry) => ({
              label: `${entry.data.status} · ${entry.data.text}`.slice(0, 100),
              description: `${entry.key} · ${entry.data.authorName}`.slice(0, 100),
              value: entry.key,
              default: entry.key === panel.selected,
            })),
          ),
      ),
    );
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(prefix + 'previous')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(panel.page === 0),
    new ButtonBuilder()
      .setCustomId(prefix + 'next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(panel.page === pages - 1),
    new ButtonBuilder()
      .setCustomId(prefix + 'settings')
      .setLabel('Back to setup')
      .setStyle(ButtonStyle.Secondary),
  );
  if (current)
    controls.addComponents(
      new ButtonBuilder()
        .setCustomId(prefix + 'availability')
        .setLabel(current.data.status === 'approved' ? 'Disable selected' : 'Enable selected')
        .setStyle(ButtonStyle.Primary),
    );
  card.addActionRowComponents(controls);
  persist(app, key, panel);
  await reply(i, { components: [card], allowedMentions: noMentions });
}
export async function openRoastSetup(app: App, i: Interaction) {
  await access(app, i);
  const cfg = app.store.config(i.guildId!).roast,
    key = randomUUID().slice(0, 8);
  const panel: Panel = {
    actor: i.user.id,
    expires: Date.now() + 900000,
    base: structuredClone(cfg),
    draft: structuredClone(cfg),
    scope: cfg.channels.length ? 'channels' : 'server',
    page: 0,
  };
  persist(app, key, panel);
  await settings(app, i, key, panel);
}
export async function roastSetupControl(app: App, i: Component) {
  const [, actor, key, action] = i.customId.split(':');
  await access(app, i);
  assert(actor === i.user.id && key, 'Open your own roast setup panel.');
  const panel = app.store.get<Panel>(i.guildId!, 'roastPanel', key);
  assert(
    panel && panel.actor === i.user.id && panel.expires > Date.now(),
    'This setup panel expired. Run /roast setup again.',
  );
  if (action === 'save') {
    assert(
      panel.scope === 'server' || panel.draft.channels.length,
      'Choose at least one channel before saving.',
    );
    await validateRoastConfig(app, panel.draft);
    await access(app, i);
    const cfg = app.store.config(i.guildId!);
    assert(
      same(cfg.roast, panel.base),
      'Roast settings changed after this panel opened. Reload saved settings.',
    );
    cfg.roast = structuredClone(panel.draft);
    app.store.setConfig(i.guildId!, cfg, i.user.id);
    panel.base = structuredClone(cfg.roast);
    persist(app, key, panel);
    await auditChange(
      app,
      i,
      'Roast settings updated',
      `${cfg.roast.enabled ? 'Enabled' : 'Disabled'} · ${cfg.roast.channels.length ? cfg.roast.channels.map((id) => `<#${id}>`).join(', ') : 'Server-wide'}\nSubmission board: ${cfg.roast.reviewChannel ? `<#${cfg.roast.reviewChannel}>` : 'Not configured'}`,
      { force: true },
    );
    await settings(app, i, key, panel, true);
    return;
  }
  if (action === 'reload') {
    panel.base = app.store.config(i.guildId!).roast;
    panel.draft = structuredClone(panel.base);
    panel.scope = panel.base.channels.length ? 'channels' : 'server';
  } else if (action === 'toggle') panel.draft.enabled = !panel.draft.enabled;
  else if (action === 'scope' && i.isStringSelectMenu()) {
    assert(['server', 'channels'].includes(i.values[0]!), 'Choose a scope.');
    panel.scope = i.values[0] as Panel['scope'];
    if (panel.scope === 'server') panel.draft.channels = [];
  } else if (action === 'channels' && i.isChannelSelectMenu()) {
    assert(i.values.length > 0 && i.values.length <= 25, 'Choose 1–25 channels.');
    panel.draft.channels = [...new Set(i.values)];
    panel.scope = 'channels';
  } else if (action === 'board' && i.isChannelSelectMenu()) {
    assert(i.values.length === 1, 'Choose a submission channel.');
    await publicRoastBoard(app, i.values[0]!);
    panel.draft.reviewChannel = i.values[0];
  } else if (['library', 'previous', 'next', 'select', 'availability'].includes(action!)) {
    if (action === 'previous') panel.page--;
    if (action === 'next') panel.page++;
    if (action === 'select' && i.isStringSelectMenu()) {
      const item = app.store.get<RoastSubmission>(i.guildId!, 'roastSubmission', i.values[0]!);
      assert(
        item && ['approved', 'disabled'].includes(item.status),
        'Choose a reviewed custom roast.',
      );
      panel.selected = i.values[0];
      panel.selectedStatus = item.status;
    }
    if (action === 'availability') {
      assert(panel.selected, 'Select a custom roast.');
      const item = app.store.get<RoastSubmission>(i.guildId!, 'roastSubmission', panel.selected);
      assert(
        item &&
          ['approved', 'disabled'].includes(item.status) &&
          item.status === panel.selectedStatus,
        'This roast changed. Select it again.',
      );
      item.status = item.status === 'approved' ? 'disabled' : 'approved';
      item.reviewedAt = Date.now();
      item.reviewedBy = i.user.id;
      item.needsRender = true;
      app.store.put(i.guildId!, 'roastSubmission', panel.selected, item);
      panel.selectedStatus = item.status;
      await renderRoastSubmission(app, panel.selected);
      await auditChange(app, i, 'Custom roast availability changed', `Status: ${item.status}`, {
        footer: `Roast ${panel.selected}`,
      });
    }
    await library(app, i, key, panel);
    return;
  } else assert(action === 'settings', 'Unknown roast setup control.');
  persist(app, key, panel);
  await settings(app, i, key, panel);
}
