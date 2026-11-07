import type {
  Client,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  MessageContextMenuCommandInteraction,
  AnySelectMenuInteraction,
} from 'discord.js';
import type { Store, Job } from './store.js';
import type { LogKind } from './config.js';
export type Command = ChatInputCommandInteraction<'cached'>;
export type Component =
  | ButtonInteraction<'cached'>
  | AnySelectMenuInteraction<'cached'>
  | ModalSubmitInteraction<'cached'>;
export type Interaction = Command | Component | MessageContextMenuCommandInteraction<'cached'>;
export interface App {
  client: Client;
  store: Store;
  guildId: string;
  backupDir: string;
  audit(
    guild: string,
    kind: LogKind,
    title: string,
    description: string,
    options?: { force?: boolean },
  ): Promise<void>;
  runJob(job: Job): Promise<void>;
}
export interface Module {
  commands?: Record<string, (app: App, interaction: Command) => Promise<void>>;
  component?: (app: App, interaction: Component) => Promise<boolean>;
}
