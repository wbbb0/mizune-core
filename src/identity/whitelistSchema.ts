import { s, type Infer } from "#data/schema/index.ts";

export const whitelistEntrySchema = s.object({
  version: s.literal(2).title("版本"),
  users: s.array(s.string().trim().nonempty().title("用户 ID")).title("用户白名单").default([]),
  groups: s.array(s.string().trim().nonempty().title("群 ID")).title("群白名单").default([])
}).title("当前白名单")
  .describe("定义当前格式下允许访问的用户和群。")
  .strict();

export const legacyVersionedWhitelistEntrySchema = s.object({
  version: s.literal(1).title("版本"),
  users: s.array(s.string().trim().nonempty().title("用户 ID")).title("用户白名单").default([]),
  groups: s.array(s.string().trim().nonempty().title("群 ID")).title("群白名单").default([])
}).title("白名单（v1）")
  .describe("兼容旧版 version=1 的白名单格式。")
  .strict();

export const legacyWhitelistEntrySchema = s.object({
  users: s.array(s.string().trim().nonempty().title("用户 ID")).title("用户白名单").default([]),
  groups: s.array(s.string().trim().nonempty().title("群 ID")).title("群白名单").default([])
}).title("旧版白名单")
  .describe("兼容未带版本号字段的历史白名单格式。")
  .strict();

export const whitelistFileSchema = s.union([
  whitelistEntrySchema,
  legacyVersionedWhitelistEntrySchema,
  legacyWhitelistEntrySchema
]).title("白名单")
  .describe("控制允许访问机器人的用户和群列表。");

export type WhitelistFile = Infer<typeof whitelistFileSchema>;
