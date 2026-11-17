import {
  ComponentType,
  MessageFlags,
  MessageFlagsBitField,
  LabelBuilder,
  type APIEmbed,
  type APIMessageTopLevelComponent,
  type MessageCreateOptions,
  type Message,
  type ModalBuilder,
  type TextInputBuilder,
  type MessageFlagsResolvable,
} from 'discord.js';
import { basename } from 'node:path';
import { assert } from './util.js';

type Node = Record<string, any>;
type Payload = Omit<Partial<MessageCreateOptions>, 'content' | 'flags'> & {
  content?: string | null;
  flags?: unknown;
};
export const componentFlag = MessageFlags.IsComponentsV2;
const json = (value: any): Node => (typeof value?.toJSON === 'function' ? value.toJSON() : value);

export function displayText(value: unknown): string {
  const node = json(value);
  if (!node || typeof node !== 'object') return '';
  return [
    typeof node.content === 'string' ? node.content : '',
    ...(node.components ?? []).map(displayText),
  ]
    .filter(Boolean)
    .join('\n');
}

// Read the generated footer block, rather than a matching line inside user-supplied text.
export function hasMessageFooter(
  message: Pick<Message, 'embeds' | 'components'>,
  marker: string,
): boolean {
  if (message.embeds.some((embed) => embed.footer?.text === marker)) return true;
  const prefix = `-# ${marker}`;
  return message.components.some((component) => {
    const node = json(component);
    if (node.type !== ComponentType.Container) return false;
    const footer = node.components
      .filter((child: Node) => child.type === ComponentType.TextDisplay)
      .at(-1)?.content;
    return (
      footer === prefix ||
      (typeof footer === 'string' &&
        footer.startsWith(prefix + ' · ') &&
        /^<t:\d+:f>$/.test(footer.slice(prefix.length + 3)))
    );
  });
}

function text(content: string): Node {
  return { type: ComponentType.TextDisplay, content };
}
function card(embed: APIEmbed): Node {
  const blocks: Node[] = [];
  if (embed.author?.name) blocks.push(text(`**${embed.author.name}**`));
  if (embed.title)
    blocks.push(text(`## ${embed.url ? `[${embed.title}](${embed.url})` : embed.title}`));
  if (embed.description) blocks.push(text(embed.description));
  for (const field of embed.fields ?? []) blocks.push(text(`**${field.name}**\n${field.value}`));
  const thumbnail = embed.thumbnail?.url ?? embed.author?.icon_url;
  if (thumbnail && blocks.length) {
    const first = blocks.splice(0, Math.min(3, blocks.length));
    blocks.unshift({
      type: ComponentType.Section,
      components: first,
      accessory: { type: ComponentType.Thumbnail, media: { url: thumbnail } },
    });
  }
  if (embed.image?.url)
    blocks.push({
      type: ComponentType.MediaGallery,
      items: [{ media: { url: embed.image.url } }],
    });
  const footer = [
    embed.footer?.text,
    embed.timestamp ? `<t:${Math.floor(Date.parse(embed.timestamp) / 1000)}:f>` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (footer) blocks.push(text(`-# ${footer}`));
  return {
    type: ComponentType.Container,
    ...(embed.color !== undefined ? { accent_color: embed.color } : {}),
    components: blocks.length ? blocks : [text('Completed.')],
  };
}

function fileName(file: any): string | undefined {
  if (typeof file?.name === 'string') return file.name;
  if (typeof file?.attachment === 'string') return basename(file.attachment);
  if (typeof file === 'string') return basename(file);
  return undefined;
}
function referenced(nodes: Node[], url: string): boolean {
  return nodes.some((node) => JSON.stringify(node).includes(url));
}
function count(nodes: Node[]): number {
  return nodes.reduce(
    (sum, node) =>
      sum + 1 + count(node.components ?? []) + (node.accessory ? count([node.accessory]) : 0),
    0,
  );
}
function addControls(nodes: Node[], controls: Node[]) {
  if (!controls.length) return;
  const last = nodes.at(-1);
  if (last?.type === ComponentType.Container) {
    last.components.push({ type: ComponentType.Separator, divider: true, spacing: 1 }, ...controls);
  } else
    nodes.push({
      type: ComponentType.Container,
      components: [
        ...(nodes.length ? [{ type: ComponentType.Separator, divider: false, spacing: 1 }] : []),
        ...controls,
      ],
    });
}

// Embed builders here are content templates rendered as V2. Event logs explicitly
// bypass this renderer to preserve Discord's round, inline embed-author avatar.
function render<T extends Payload>(options: T) {
  const { content, embeds, components, flags, ...rest } = options;
  const nodes: Node[] = [];
  if (content) nodes.push(text(content));
  for (const embed of embeds ?? []) nodes.push(card(json(embed) as APIEmbed));
  const controls: Node[] = [];
  for (const component of components ?? []) {
    const node = structuredClone(json(component));
    if (node.type === ComponentType.ActionRow) controls.push(node);
    else nodes.push(node);
  }
  if (
    controls.length &&
    !embeds?.length &&
    nodes.length === 1 &&
    nodes[0]?.type === ComponentType.TextDisplay
  ) {
    nodes[0] = { type: ComponentType.Container, components: [nodes[0]] };
  }
  addControls(nodes, controls);
  for (const file of options.files ?? []) {
    const name = fileName(file);
    assert(name, 'Files need a filename to be displayed in a message.');
    const url = `attachment://${name}`;
    if (!referenced(nodes, url))
      nodes.push(
        /\.(?:png|jpe?g|gif|webp|mp4|webm)$/i.test(name)
          ? {
              type: ComponentType.MediaGallery,
              items: [
                {
                  media: { url },
                  ...(file && typeof file === 'object' && 'description' in file && file.description
                    ? { description: file.description }
                    : {}),
                  ...(name.startsWith('SPOILER_') ? { spoiler: true } : {}),
                },
              ],
            }
          : {
              type: ComponentType.File,
              file: { url },
              ...(name.startsWith('SPOILER_') ? { spoiler: true } : {}),
            },
      );
  }
  if (!nodes.length) nodes.push(text('Completed.'));
  return {
    ...rest,
    flags: (MessageFlagsBitField.resolve((flags ?? 0) as MessageFlagsResolvable) |
      componentFlag) as MessageFlags.IsComponentsV2,
    components: nodes as APIMessageTopLevelComponent[],
  };
}

export function modernMessage<T extends Payload>(options: T) {
  const result = render(options);
  assert(count(result.components) <= 40, 'This view has too many controls. Open a shorter page.');
  assert(
    displayText(result).length <= 4000,
    'This view is too long. Use a shorter page or split the message.',
  );
  return result;
}

export function splitDisplayText(value: string): string[] {
  const parts: string[] = [];
  while (value.length > 3500) {
    let end = value.lastIndexOf('\n', 3500) + 1;
    if (end < 1750) end = 3500;
    if (/[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    const open = value.lastIndexOf('<', end - 1);
    if (open > end - 40 && value.indexOf('>', open) >= end) end = open;
    parts.push(value.slice(0, end));
    value = value.slice(end);
  }
  if (value) parts.push(value);
  return parts;
}

export function modernPages<T extends Payload>(options: T) {
  const result = render(options);
  const pages: Node[][] = [[]];
  let group: Node | undefined;
  let container: Node | undefined;
  function append(node: Node, parent?: Node) {
    if (node.type === ComponentType.Section && displayText(node).length > 3500) {
      const [first, ...rest] = node.components;
      // Keep the thumbnail next to the heading, then flow the body over pages.
      const chunks = splitDisplayText(first.content);
      append({ ...node, components: [text(chunks.shift()!)] }, parent);
      for (const chunk of chunks) append(text(chunk), parent);
      for (const child of rest) append(child, parent);
      return;
    }
    if (node.type === ComponentType.TextDisplay && node.content.length > 3500) {
      for (const part of splitDisplayText(node.content)) append(text(part), parent);
      return;
    }
    let page = pages.at(-1)!;
    const extra = parent && group !== parent ? 1 : 0;
    if (
      page.length &&
      (displayText({ components: page }).length + displayText(node).length + 4 > 3900 ||
        count(page) + count([node]) + extra > 38)
    ) {
      pages.push([]);
      page = pages.at(-1)!;
      group = undefined;
      container = undefined;
    }
    if (parent) {
      if (group !== parent) {
        container = { ...parent, components: [] };
        page.push(container!);
        group = parent;
      }
      container!.components.push(node);
    } else {
      page.push(node);
      group = undefined;
    }
  }
  for (const component of result.components as Node[]) {
    if (component.type === ComponentType.Container) {
      for (const child of component.components) append(child, component);
    } else append(component);
  }
  return pages.map((components, index) => ({
    ...result,
    components: components as APIMessageTopLevelComponent[],
    ...(result.files
      ? {
          files: result.files.filter((file) =>
            referenced(components, `attachment://${fileName(file)}`),
          ),
        }
      : {}),
    ...('nonce' in result && result.nonce && index
      ? { nonce: `${String(result.nonce).slice(0, 18)}-${index}` }
      : {}),
  }));
}

export async function sendModern(
  target: { send(options: MessageCreateOptions): Promise<Message> },
  options: MessageCreateOptions,
) {
  let first: Message | undefined;
  for (const page of modernPages(options)) {
    const message = await target.send(page);
    first ??= message;
  }
  return first!;
}

export function modernEdit<T extends Payload>(options: T) {
  return { ...modernMessage(options), content: null, embeds: [] };
}

// Control-only updates must preserve the text/media now stored in components.
export function updatedControls(
  message: Pick<Message, 'content' | 'embeds' | 'components'>,
  controls: NonNullable<Payload['components']>,
) {
  function strip(node: Node): Node | undefined {
    if (node.type === ComponentType.ActionRow || node.type === ComponentType.Button)
      return undefined;
    const result = structuredClone(node);
    if (result.components) result.components = result.components.map(strip).filter(Boolean);
    if (result.components) {
      while (result.components.at(-1)?.type === ComponentType.Separator) result.components.pop();
      if (!result.components.length) return undefined;
    }
    return result;
  }
  const current = (message.components ?? []).map((c) => strip(json(c))).filter(Boolean);
  return modernEdit({
    content: message.content,
    embeds: message.embeds,
    components: [...current, ...controls] as Payload['components'],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

// Labels are the current Discord modal layout; preserve field IDs and validation.
export function modernModal(modal: ModalBuilder): ModalBuilder {
  const fields = modal.components.map((component) => {
    const data = component.toJSON() as Node;
    if (data.type !== ComponentType.ActionRow) return component;
    const input = data.components[0];
    assert(
      data.components.length === 1 && input.type === ComponentType.TextInput,
      'Invalid form field.',
    );
    const { label, ...field } = input;
    return new LabelBuilder()
      .setLabel(label)
      .setTextInputComponent(field as unknown as TextInputBuilder);
  });
  return modal.setComponents(...fields);
}
