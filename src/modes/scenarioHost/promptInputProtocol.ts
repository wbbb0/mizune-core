export type ScenarioHostUserInputKind = "player_action" | "ooc_instruction" | "player_speech";

export interface ScenarioHostParsedUserInput {
  kind: ScenarioHostUserInputKind;
  content: string;
}

const LABEL_BY_KIND: Record<ScenarioHostUserInputKind, string> = {
  player_action: "玩家动作",
  ooc_instruction: "场外指令",
  player_speech: "玩家对白"
};

export function parseScenarioHostUserInput(text: string): ScenarioHostParsedUserInput {
  const normalized = String(text).trimStart();
  if (!normalized) {
    return {
      kind: "player_speech",
      content: ""
    };
  }

  if (normalized.startsWith("*")) {
    return {
      kind: "player_action",
      content: normalized.slice(1).trimStart()
    };
  }

  if (normalized.startsWith("#")) {
    return {
      kind: "ooc_instruction",
      content: normalized.slice(1).trimStart()
    };
  }

  return {
    kind: "player_speech",
    content: normalized
  };
}

export function formatScenarioHostParsedUserInput(input: ScenarioHostParsedUserInput): string {
  const label = LABEL_BY_KIND[input.kind];
  return input.content ? `${label}：${input.content}` : `${label}：`;
}

export function formatScenarioHostStructuredUserContent(content: string): string {
  const lines = String(content).replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() && !line.startsWith("⟦"));
  if (start < 0) {
    return content;
  }

  let end = start + 1;
  while (end < lines.length && lines[end] && !lines[end]!.startsWith("⟦")) {
    end += 1;
  }

  const rewritten = formatScenarioHostParsedUserInput(
    parseScenarioHostUserInput(lines.slice(start, end).join("\n"))
  );
  return [
    ...lines.slice(0, start),
    rewritten,
    ...lines.slice(end)
  ].join("\n");
}
