import type { CommandCompletionDefinition, CommandParameter } from "../../../../src/types/commandCompletion.ts";

export type { CommandCompletionDefinition };
export interface CommandCompletion {
  values: string[];
  hint?: string;
  source?: CommandParameter["source"];
  start: number;
  end: number;
  appendSpace: boolean;
}

/** Only complete the command at the beginning of a draft, at the actual caret. */
export function resolveCommandCompletion(
  text: string, caret: number, commands: CommandCompletionDefinition[], stickerIds: string[] = [], skillIds: string[] = []
): CommandCompletion | null {
  const prefix = text.match(/^\s*[。.]\s*/);
  if (!prefix || /[\r\n]/.test(text) || caret < prefix[0].length) return null;
  let start = prefix[0].length;
  const commandToken = text.slice(start).match(/^\S*/)?.[0] ?? "";
  let end = start + commandToken.length;
  const command = commands.find((item) => item.name.toLowerCase() === commandToken.toLowerCase());
  if (caret <= end) {
    const query = text.slice(start, caret).toLowerCase();
    return {
      values: commands.filter((item) => item.name.startsWith(query) && item.name !== commandToken.toLowerCase()).map((item) => item.name),
      start, end, appendSpace: false
    };
  }
  if (!command) return null;
  const previous: string[] = [];
  for (const parameter of command.parameters) {
    if (parameter.when && previous[parameter.when.index]?.toLowerCase() !== parameter.when.value) continue;
    start = end + (text.slice(end).match(/^\s*/)?.[0].length ?? 0);
    if (parameter.rest) {
      const separator = parameter.separator ? text.indexOf(parameter.separator, start) : -1;
      if (separator >= 0 && caret > separator + parameter.separator!.length) {
        previous.push(text.slice(start, separator));
        end = separator + parameter.separator!.length;
        continue;
      }
      return { values: [], hint: parameter.separator ? `<${parameter.name}> ${parameter.separator} <${command.parameters[command.parameters.indexOf(parameter) + 1]?.name ?? "内容"}>` : `<${parameter.name}>`, start, end: text.length, appendSpace: false };
    }
    end = start + (text.slice(start).match(/^\S*/)?.[0].length ?? 0);
    const token = text.slice(start, end);
    if (caret <= end) {
      const query = text.slice(start, caret).toLowerCase();
      const values = parameter.values ?? (parameter.source === "stickerIds" ? stickerIds : parameter.source === "skillIds" ? skillIds : []);
      return {
        values: values.some((value) => value.toLowerCase() === token.toLowerCase()) && caret === end
          ? [] : values.filter((value) => value.toLowerCase().startsWith(query)),
        hint: `<${parameter.name}>`, source: parameter.source,
        start, end, appendSpace: true
      };
    }
    if (parameter.values && !parameter.values.includes(token.toLowerCase())) return null;
    previous.push(token);
  }
  return null;
}

export function applyCommandCompletion(text: string, completion: CommandCompletion, value: string, commands: CommandCompletionDefinition[]) {
  const hasParameters = commands.find((command) => command.name === value)?.parameters.length;
  const suffix = text.slice(completion.end);
  const space = (completion.appendSpace || hasParameters) && !/^\s/.test(suffix) ? " " : "";
  const inserted = value + space;
  return { text: text.slice(0, completion.start) + inserted + suffix, caret: completion.start + inserted.length };
}
