import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  AnySelectMenuInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export type ModuleName = "ads" | "sticky" | "moderation" | "roles" | "antiraid" | "logging" | "general";

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  module: ModuleName;
  /** Shown in /help */
  summary: string;
  execute(interaction: ChatInputCommandInteraction): Promise<unknown>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
}

export type ComponentInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

/**
 * Handles buttons, select menus and modals whose customId starts with `${prefix}:`.
 * The rest of the customId is split on ":" and passed as args.
 */
export interface ComponentHandler {
  prefix: string;
  handle(interaction: ComponentInteraction, args: string[]): Promise<unknown>;
}
