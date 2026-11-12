import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits as P,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Interaction, Component } from './types.js';
import type { GuildConfig } from './config.js';
import { owner, requirePermission, enabled } from './permissions.js';
import { assert, safe } from './util.js';
import { reply, embed, auditPages, confirm, readOnlyResponse } from './ui.js';
import { warningHistory, revokeWarning } from './warnings.js';

export interface WarningPolicy {
  threshold: number;
  action: GuildConfig['warningAction'];
  minutes: number;
}
export interface WarningPanel {
  actor: string;
  target: string;
  channel: string;
  expires: number;
  page?: number;
  view?: 'history' | 'detail' | 'policy';
  selected?: number;
  detailPage?: number;
  policy?: WarningPolicy & { base: WarningPolicy };
}
interface WarningForm {
  actor: string;
  channel: string;
  expires: number;
  panel: string;
  kind: 'revoke' | 'duration';
  target: string;
  caseId?: number;
}
export function currentWarningPolicy(cfg: GuildConfig): WarningPolicy {
  return {
    threshold: cfg.warningThreshold,
    action: cfg.warningAction,
    minutes: cfg.warningTimeoutMinutes,
  };
}
export function sameWarningPolicy(a: WarningPolicy, b: WarningPolicy) {
  return a.threshold === b.threshold && a.action === b.action && a.minutes === b.minutes;
}
async function isStaff(app: App, i: Interaction) {
  const member = await i.guild!.members.fetch(i.user.id),
    roles = app.store.config(i.guildId!).staffRoles;
  return (
    member.id === i.guild!.ownerId ||
    (member.permissions.has(P.ModerateMembers) &&
      (!roles.length || roles.some((id) => member.roles.cache.has(id))))
  );
}
function save(app: App, guild: string, key: string, panel: WarningPanel) {
  app.store.put(guild, 'warningPanel', key, panel);
}
function button(key: string, action: string, label: string, disabled = false, danger = false) {
  return new ButtonBuilder()
    .setCustomId(`warnings:${action}:${key}`)
    .setLabel(label)
    .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(disabled);
}
function load(app: App, i: Interaction, key: string) {
  const panel = app.store.get<WarningPanel>(i.guildId!, 'warningPanel', key);
  assert(
    panel &&
      panel.actor === i.user.id &&
      panel.channel === i.channelId &&
      panel.expires > Date.now(),
    'This warning panel expired or belongs to someone else. Open /warnings panel again.',
  );
  enabled(app, i.guildId!, 'moderation');
  return panel;
}

export async function showWarningPanel(
  app: App,
  i: Interaction,
  panel: WarningPanel,
  key: string,
  notice?: string,
) {
  enabled(app, i.guildId!, 'moderation');
  if (panel.target !== i.user.id) await requirePermission(app, i, P.ModerateMembers);
  const staff = await isStaff(app, i),
    cfg = app.store.config(i.guildId!),
    isOwner = i.user.id === i.guild!.ownerId;
  const history = warningHistory(app, i.guildId!, panel.target),
    pages = Math.max(1, Math.ceil(history.total / 6));
  panel.page = Math.max(0, Math.min(panel.page ?? 0, pages - 1));
  if (panel.view === 'policy') {
    owner(i);
    await requirePermission(app, i, P.ManageGuild);
    const me = await i.guild!.members.fetchMe();
    const current = currentWarningPolicy(cfg);
    panel.policy ??= { ...current, base: current };
    save(app, i.guildId!, key, panel);
    const draft = panel.policy;
    await reply(i, {
      content: notice ?? '',
      embeds: [
        embed(
          'Warning policy · owner controls',
          `**Saved policy:** ${current.threshold > 0 && current.action !== 'none' ? `${current.action} at ${current.threshold} active warnings` : 'Automatic escalation off'}\n**Saved timeout:** ${current.minutes} minutes\n**Second-staff kick approval:** ${cfg.secondApproval ? 'Required' : 'Off'}\n**Bot checks:** Moderate Members ${me.permissions.has(P.ModerateMembers) ? '✓' : 'missing'} · Kick Members ${me.permissions.has(P.KickMembers) ? '✓' : 'missing'}\n**Approval log:** ${cfg.logs.moderation ? `<#${cfg.logs.moderation}>` : 'Not configured; required for second-staff approval'}\n\n**Draft — not saved:** ${draft.action} · threshold ${draft.threshold} · timeout ${draft.minutes} minutes\nChoose an action and threshold below. Timeout duration opens a private form. **Review changes** opens a separate confirmation; Cancel keeps the saved policy.\n\nOnly active warnings count. Changes apply to future warnings, not retroactively. Per-member hierarchy is rechecked during enforcement. Revocation does not automatically undo prior enforcement.`,
          'moderation',
        ),
      ],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`warnings:action:${key}`)
            .setPlaceholder('Automatic action')
            .addOptions(
              ['none', 'timeout', 'kick'].map((value) => ({
                label:
                  value === 'none'
                    ? 'No automatic action'
                    : value === 'timeout'
                      ? 'Automatic timeout'
                      : 'Automatic kick',
                value,
                default: draft.action === value,
              })),
            ),
        ),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`warnings:threshold:${key}`)
            .setPlaceholder('Active warning threshold')
            .addOptions(
              Array.from({ length: 21 }, (_, value) => ({
                label:
                  value === 0
                    ? '0 · Disable escalation'
                    : `${value} active warning${value === 1 ? '' : 's'}`,
                value: String(value),
                default: draft.threshold === value,
              })),
            ),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(key, 'duration', 'Timeout duration'),
          button(key, 'apply', 'Review changes'),
          button(key, 'policy', 'Reload saved policy'),
          button(key, 'history', 'Warning history'),
        ),
      ],
    });
    return;
  }
  const page = panel.page,
    visible = history.rows.slice(page * 6, page * 6 + 6);
  const selected = history.rows.find((row) => row.id === panel.selected);
  if (panel.view === 'detail' && !selected) panel.view = 'history';
  const summary = `Member: <@${panel.target}>\n**Active: ${history.active.length} · Total retained: ${history.total} · Expired: ${history.expired} · Revoked: ${history.revoked}**\nOnly active warnings count toward escalation.`;
  const rows = visible.map(
    (row) =>
      `**#${row.id} · ${row.status}** · <t:${Math.floor(row.created / 1000)}:d>\n${safe(row.reason, 180)}${row.expires ? `\nExpires: <t:${Math.floor(row.expires / 1000)}:R>` : ''}`,
  );
  const description =
    panel.view === 'detail' && selected
      ? `${summary}\n\n**Warning #${selected.id} · ${selected.status}**\nIssued: <t:${Math.floor(selected.created / 1000)}:F>${selected.expires ? `\nExpires: <t:${Math.floor(selected.expires / 1000)}:F>` : '\nNo scheduled expiry.'}\n\n**Reason**\n${safe(selected.reason, Infinity)}${selected.revoked ? `\n\n**Revoked:** <t:${Math.floor(selected.revoked.created / 1000)}:F>\n${safe(selected.revoked.reason, Infinity)}` : ''}\n\n${staff ? 'Revoke opens a private reason form. The original case is preserved; previous enforcement is not automatically reversed.' : 'Use /appeal with this case number if you want staff to review it.'}`
      : `${summary}\nPage ${page + 1}/${pages}. Select a warning for its full reason${staff ? ' and revocation controls' : ''}.\n\n${rows.join('\n\n') || 'No retained warnings.'}`;
  const controls: (
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<UserSelectMenuBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(key, `page-${Math.max(0, page - 1)}`, 'Previous', page === 0),
      button(key, 'refresh', 'Refresh'),
      button(key, `page-${page + 1}`, 'Next', page + 1 >= pages),
      ...(isOwner ? [button(key, 'policy', 'Warning policy')] : []),
      ...(panel.view === 'detail' ? [button(key, 'history', 'Back to history')] : []),
    ),
  ];
  if (staff)
    controls.push(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`warnings:member:${key}`)
          .setPlaceholder('Choose a member to inspect')
          .setDefaultUsers(panel.target)
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
  if (visible.length)
    controls.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`warnings:select:${key}`)
          .setPlaceholder('Select a warning for details')
          .addOptions(
            visible.map((row) => ({
              label: `Warning #${row.id} · ${row.status}`,
              value: String(row.id),
              description: row.reason.replace(/\s+/g, ' ').slice(0, 100) || 'No reason recorded',
              default: row.id === selected?.id,
            })),
          ),
      ),
    );
  if (staff && panel.view === 'detail' && selected)
    controls.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          key,
          'revoke',
          selected.revoked ? 'Already revoked' : `Revoke warning #${selected.id}`,
          !!selected.revoked,
          true,
        ),
      ),
    );
  const detailPages = auditPages(
    'moderation',
    panel.view === 'detail' ? `Warning #${selected!.id}` : 'Warning history',
    description,
  );
  panel.detailPage = Math.max(0, Math.min(panel.detailPage ?? 0, detailPages.length - 1));
  if (panel.view === 'detail' && detailPages.length > 1)
    controls.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          key,
          `detail-${Math.max(0, panel.detailPage - 1)}`,
          'Previous detail',
          panel.detailPage === 0,
        ),
        button(
          key,
          `detail-${panel.detailPage + 1}`,
          'Next detail',
          panel.detailPage + 1 >= detailPages.length,
        ),
      ),
    );
  save(app, i.guildId!, key, panel);
  await reply(i, {
    content: notice ?? '',
    embeds: [detailPages[panel.detailPage]!],
    components: controls,
  });
}

export async function openWarningPanel(app: App, i: Interaction, target = i.user.id) {
  if (target !== i.user.id) await requirePermission(app, i, P.ModerateMembers);
  const key = randomUUID(),
    panel: WarningPanel = {
      actor: i.user.id,
      target,
      channel: i.channelId!,
      expires: Date.now() + 600000,
      view: 'history',
      page: 0,
    };
  await showWarningPanel(app, i, panel, key);
}

export async function previewWarningPolicy(
  app: App,
  i: Interaction,
  draft: WarningPolicy,
  base: WarningPolicy,
  panelKey?: string,
) {
  owner(i);
  await requirePermission(app, i, P.ManageGuild);
  assert(
    sameWarningPolicy(currentWarningPolicy(app.store.config(i.guildId!)), base),
    'The saved warning policy changed. Reload it and review your choices again.',
  );
  await confirm(
    app,
    i,
    `Apply ${draft.action} at ${draft.threshold} active warnings? Timeout duration: ${draft.minutes} minutes. Applies to future warnings only. Revoked/expired warnings are excluded. Kicks require bot Kick Members and hierarchy; second-staff approval still applies.`,
    'warningPolicy',
    { ...draft, base, ...(panelKey ? { panelKey } : {}) },
  );
}

export async function warningPanelControl(app: App, i: Component): Promise<boolean> {
  if (!i.customId.startsWith('warnings:')) return false;
  const [, action, key] = i.customId.split(':');
  if (i.isModalSubmit()) {
    assert(action === 'form-revoke' || action === 'form-duration', 'Unknown warning form.');
    const form = app.store.get<WarningForm>(i.guildId, 'warningForm', key!);
    assert(
      form && form.actor === i.user.id && form.channel === i.channelId && form.expires > Date.now(),
      'This warning form expired or belongs to someone else.',
    );
    const panel = load(app, i, form.panel);
    assert(panel.target === form.target, 'The selected member changed. Open a fresh form.');
    if (action === 'form-revoke') {
      assert(
        form.kind === 'revoke' && panel.selected === form.caseId,
        'The selected warning changed. Open a fresh form.',
      );
      await requirePermission(app, i, P.ModerateMembers);
      assert(
        app.store.case(i.guildId, form.caseId!)?.target === panel.target,
        'This warning does not belong to the selected member.',
      );
      app.store.delete(i.guildId, 'warningForm', key!);
      const result = await revokeWarning(
        app,
        i,
        form.caseId!,
        i.fields.getTextInputValue('reason'),
      );
      panel.view = 'detail';
      panel.detailPage = 0;
      await showWarningPanel(
        app,
        i,
        panel,
        form.panel,
        `Warning #${form.caseId} revoked. Active warnings: ${result.active}. DM: ${result.dm}.`,
      );
      return true;
    }
    owner(i);
    await requirePermission(app, i, P.ManageGuild);
    assert(form.kind === 'duration' && panel.policy, 'Open the warning policy panel again.');
    const value = i.fields.getTextInputValue('minutes').trim();
    assert(
      /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 1440,
      'Use a whole number of minutes from 1 to 1,440.',
    );
    app.store.delete(i.guildId, 'warningForm', key!);
    panel.policy.minutes = Number(value);
    panel.view = 'policy';
    readOnlyResponse(i);
    await showWarningPanel(app, i, panel, form.panel);
    return true;
  }
  // Older history panels remain usable until their normal expiry.
  const legacy = /^\d+$/.test(key ?? '') && !['threshold'].includes(action!);
  const panelKey = legacy ? action! : key!,
    panel = load(app, i, panelKey);
  if (legacy) {
    assert(i.isButton(), 'Unknown warning control.');
    panel.page = Number(key);
    panel.view = 'history';
  } else if (action === 'member') {
    assert(i.isUserSelectMenu(), 'Choose a member.');
    await requirePermission(app, i, P.ModerateMembers);
    assert(
      i.values.length === 1 && /^\d{17,22}$/.test(i.values[0]!),
      'Choose one valid server member.',
    );
    panel.target = i.values[0]!;
    panel.page = 0;
    panel.view = 'history';
    delete panel.selected;
  } else if (action === 'select') {
    assert(i.isStringSelectMenu(), 'Choose a warning.');
    if (panel.target !== i.user.id) await requirePermission(app, i, P.ModerateMembers);
    const selected = Number(i.values[0]);
    assert(
      Number.isSafeInteger(selected) &&
        warningHistory(app, i.guildId, panel.target).rows.some((row) => row.id === selected),
      'This warning is no longer retained for the selected member.',
    );
    panel.selected = selected;
    panel.view = 'detail';
    panel.detailPage = 0;
  } else if (action === 'policy') {
    owner(i);
    await requirePermission(app, i, P.ManageGuild);
    const current = currentWarningPolicy(app.store.config(i.guildId));
    panel.policy = { ...current, base: current };
    panel.view = 'policy';
  } else if (action === 'action' || action === 'threshold') {
    owner(i);
    await requirePermission(app, i, P.ManageGuild);
    assert(
      i.isStringSelectMenu() && panel.policy && panel.view === 'policy',
      'Open the warning policy controls first.',
    );
    const value = i.values[0]!;
    if (action === 'action') {
      assert(['none', 'timeout', 'kick'].includes(value), 'Choose none, timeout or kick.');
      panel.policy.action = value as WarningPolicy['action'];
    } else {
      assert(/^\d{1,2}$/.test(value) && Number(value) <= 20, 'Choose a threshold from 0 to 20.');
      panel.policy.threshold = Number(value);
    }
  } else if (action === 'revoke' || action === 'duration') {
    assert(i.isButton(), 'Use the warning panel buttons.');
    if (action === 'revoke') {
      await requirePermission(app, i, P.ModerateMembers);
      assert(panel.selected, 'Select a warning for this member first.');
      const record = app.store.case(i.guildId, panel.selected!);
      assert(
        record?.action === 'warn' && record.target === panel.target,
        'Select a warning for this member first.',
      );
      assert(
        !app.store.get(i.guildId, 'warningRevocation', String(record.id)),
        'This warning has already been revoked.',
      );
    } else {
      owner(i);
      await requirePermission(app, i, P.ManageGuild);
      assert(panel.policy && panel.view === 'policy', 'Open the warning policy controls first.');
    }
    const formKey = randomUUID();
    app.store.put(i.guildId, 'warningForm', formKey, {
      actor: i.user.id,
      channel: i.channelId,
      expires: Date.now() + 300000,
      panel: panelKey,
      kind: action,
      target: panel.target,
      ...(action === 'revoke' ? { caseId: panel.selected } : {}),
    } satisfies WarningForm);
    const field = new TextInputBuilder()
      .setCustomId(action === 'revoke' ? 'reason' : 'minutes')
      .setLabel(
        action === 'revoke'
          ? 'Why should this warning be revoked?'
          : 'Timeout duration in minutes (1–1440)',
      )
      .setStyle(action === 'revoke' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(action === 'revoke' ? 1900 : 4);
    if (action === 'duration') field.setValue(String(panel.policy!.minutes));
    await i.showModal(
      new ModalBuilder()
        .setCustomId(`warnings:form-${action}:${formKey}`)
        .setTitle(
          action === 'revoke' ? `Revoke warning #${panel.selected}` : 'Warning timeout duration',
        )
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field)),
    );
    return true;
  } else if (action === 'apply') {
    owner(i);
    await requirePermission(app, i, P.ManageGuild);
    assert(panel.policy && panel.view === 'policy', 'Open the warning policy controls first.');
    await previewWarningPolicy(app, i, panel.policy, panel.policy.base, panelKey);
    return true;
  } else if (action === 'history') {
    panel.view = 'history';
  } else if (action?.startsWith('page-')) {
    assert(/^page-\d+$/.test(action), 'Unknown warning page.');
    panel.page = Number(action.slice(5));
    panel.view = 'history';
  } else if (action?.startsWith('detail-')) {
    assert(/^detail-\d+$/.test(action) && panel.selected, 'Select a warning first.');
    panel.detailPage = Number(action.slice(7));
    panel.view = 'detail';
  } else assert(action === 'refresh', 'Unknown warning control.');
  readOnlyResponse(i);
  await showWarningPanel(app, i, panel, panelKey);
  return true;
}
