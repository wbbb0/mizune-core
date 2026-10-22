/** 指令补全协议；只提供语法，不承载执行权限。 */
export interface CommandParameter {
  name: string;
  values?: string[];
  source?: "stickerIds" | "skillIds";
  rest?: boolean;
  separator?: string;
  when?: { index: number; value: string };
}
export interface CommandCompletionDefinition {
  name: string;
  parameters: CommandParameter[];
}
