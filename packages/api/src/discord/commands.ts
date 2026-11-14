import { SlashCommandBuilder } from "discord.js";
import { getDiscordCommandSpecs } from "../channels/command-catalog.js";

/** Command metadata — used for registration and help text */
export interface CommandDef {
  builder: SlashCommandBuilder;
  /** Internal name used to route to the handler (matches Telegram command names where possible) */
  handler: string;
}

// Helper to reduce boilerplate
function cmd(name: string, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder().setName(name).setDescription(description);
}

function cmdWithString(
  name: string,
  description: string,
  optionName: string,
  optionDesc: string,
  required = false,
): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption((o) => o.setName(optionName).setDescription(optionDesc).setRequired(required)) as SlashCommandBuilder;
}

export const DISCORD_COMMANDS: CommandDef[] = [
  ...getDiscordCommandSpecs().map((spec) => ({
    builder: spec.option
      ? cmdWithString(spec.name, spec.description, spec.option.name, spec.option.description, spec.option.required)
      : cmd(spec.name, spec.description),
    handler: spec.handler,
  })),
];

/** Get JSON payloads for REST API registration */
export function getCommandsJSON() {
  return DISCORD_COMMANDS.map((c) => c.builder.toJSON());
}

/** Look up a command def by its slash command name */
export function findCommand(name: string): CommandDef | undefined {
  return DISCORD_COMMANDS.find((c) => c.builder.name === name);
}
