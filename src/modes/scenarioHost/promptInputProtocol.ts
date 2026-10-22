import { startsWithTag } from "#utils/structuredEnvelope.ts";

export type ScenarioHostUserInputKind =
  | "player_action"
  | "auto_advance"
  | "delegated_player_action"
  | "ooc_instruction"
  | "player_speech";

export interface ScenarioHostParsedUserInput {
  kind: ScenarioHostUserInputKind;
  content: string;
}

const LABEL_BY_KIND: Record<ScenarioHostUserInputKind, string> = {
  player_action: "玩家动作",
  auto_advance: "自动推进",
  delegated_player_action: "代行玩家动作",
  ooc_instruction: "场外指令",
  player_speech: "玩家对白"
};

export function parseScenarioHostUserInput(
  text: string,
  options?: { modeId?: string | undefined }
): ScenarioHostParsedUserInput {
  const normalized = String(text).trimStart();
  if (!normalized) {
    return {
      kind: "player_speech",
      content: ""
    };
  }

  const isStatefulRp = options?.modeId === "stateful_rp";

  if (String(text).trim() === "*") {
    return {
      kind: "auto_advance",
      content: isStatefulRp
        ? "对方没有声明新的具体动作，请结合你当前的身体感受、短期微意图与所处环境自然做出反应或推进互动。"
        : "玩家没有声明新的具体动作，请基于当前局面自然推进下一步。"
    };
  }

  if (String(text).trim() === "**") {
    return {
      kind: "delegated_player_action",
      content: isStatefulRp
        ? "对方请你在合理范围内顺势带出双方互动的下一小步，但不要代替对方扮演或替对方说话。"
        : "玩家请求你代为选择并执行下一步玩家角色行动；请基于当前局面、角色资料和已知风险做出合理的一小步行动。"
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

export function formatScenarioHostParsedUserInput(
  input: ScenarioHostParsedUserInput,
  options?: { modeId?: string | undefined }
): string {
  const label = options?.modeId === "stateful_rp" && input.kind === "delegated_player_action"
    ? "顺势推进互动"
    : LABEL_BY_KIND[input.kind];
  return input.content ? `${label}：${input.content}` : `${label}：`;
}

export function formatScenarioHostStructuredUserContent(
  content: string,
  options?: { modeId?: string | undefined }
): string {
  const lines = String(content).replace(/\r\n/g, "\n").split("\n");
  const rewrittenLines: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || startsWithTag(line)) {
      rewrittenLines.push(line);
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length && lines[index]?.trim() && !startsWithTag(lines[index]!)) {
      index += 1;
    }
    rewrittenLines.push(formatScenarioHostParsedUserInput(
      parseScenarioHostUserInput(lines.slice(start, index).join("\n"), options),
      options
    ));
  }
  return rewrittenLines.join("\n");
}
