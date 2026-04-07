import type { FastifyReply } from "fastify";
import { z } from "zod";

const sessionParamsSchema = z.object({
  sessionId: z.string().trim().min(1, "sessionId is required")
});

const webTurnStreamQuerySchema = z.object({
  turnId: z.string().trim().min(1, "turnId is required")
});

const webSessionStreamQuerySchema = z.object({
  mutationEpoch: z.coerce.number().int().nonnegative().optional(),
  transcriptCount: z.coerce.number().int().nonnegative().optional().default(0)
});

const shellRunBodySchema = z.object({
  command: z.string().trim().min(1, "command is required"),
  cwd: z.string().trim().min(1).optional(),
  timeoutMs: z.number().finite().positive().optional(),
  tty: z.boolean().optional()
});

const shellInteractBodySchema = z.object({
  input: z.string().min(1, "input is required")
});

const shellSignalBodySchema = z.object({
  signal: z.string().trim().min(1, "signal is required")
});

const sendTextBodySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).optional(),
  text: z.string().min(1, "userId/groupId and text are required")
}).refine((value) => Boolean(value.userId || value.groupId), {
  message: "userId/groupId and text are required"
});

const webTurnBodySchema = z.object({
  userId: z.string().trim().min(1, "userId is required"),
  senderName: z.string().trim().min(1).optional(),
  text: z.string().trim().optional(),
  imageIds: z.array(z.string().trim().min(1)).optional().default([]),
  attachmentIds: z.array(z.string().trim().min(1)).optional().default([])
}).transform((value) => ({
  ...value,
  text: value.text?.trim() ?? "",
  imageIds: value.imageIds ?? [],
  attachmentIds: value.attachmentIds ?? []
})).refine((value) => value.text.length > 0 || value.imageIds.length > 0 || value.attachmentIds.length > 0, {
  message: "text, imageIds, or attachmentIds is required"
});

const createSessionBodySchema = z.object({
  participantUserId: z.string().trim().min(1, "participantUserId is required"),
  participantLabel: z.string().trim().min(1).optional()
});

const uploadAssetFileSchema = z.object({
  filename: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1, "mimeType is required"),
  contentBase64: z.string().trim().min(1, "contentBase64 is required"),
  kind: z.enum(["image", "animated_image", "video", "audio", "file"]).optional()
});

const uploadAssetsBodySchema = z.object({
  files: z.array(uploadAssetFileSchema).min(1, "files must contain at least one asset")
});

const configValidateBodySchema = z.object({
  value: z.unknown()
});

const configSaveBodySchema = z.object({
  value: z.unknown()
});

const editorResourceParamsSchema = z.object({
  resource: z.string().trim().min(1, "resource is required")
});

const resourceItemParamsSchema = z.object({
  resource: z.string().trim().min(1, "resource is required"),
  item: z.string().trim().min(1, "item is required")
});

const editorOptionsParamsSchema = z.object({
  key: z.string().trim().min(1, "key is required")
});

const browserProfileParamsSchema = z.object({
  profileId: z.string().trim().min(1, "profileId is required")
});

const workspacePathQuerySchema = z.object({
  path: z.string().trim().optional().default(".")
});

const workspaceFileQuerySchema = z.object({
  path: z.string().trim().min(1, "path is required"),
  startLine: z.coerce.number().int().positive().optional(),
  endLine: z.coerce.number().int().positive().optional()
});

const workspaceAssetParamsSchema = z.object({
  assetId: z.string().trim().min(1, "assetId is required")
});

export type ParsedSessionParams = z.infer<typeof sessionParamsSchema>;
export type ParsedWebTurnStreamQuery = z.infer<typeof webTurnStreamQuerySchema>;
export type ParsedWebSessionStreamQuery = z.infer<typeof webSessionStreamQuerySchema>;
export type ParsedShellRunBody = z.infer<typeof shellRunBodySchema>;
export type ParsedShellInteractBody = z.infer<typeof shellInteractBodySchema>;
export type ParsedShellSignalBody = z.infer<typeof shellSignalBodySchema>;
export type ParsedSendTextBody = z.infer<typeof sendTextBodySchema>;
export type ParsedWebTurnBody = z.infer<typeof webTurnBodySchema>;
export type ParsedCreateSessionBody = z.infer<typeof createSessionBodySchema>;
export type ParsedUploadAssetsBody = z.infer<typeof uploadAssetsBodySchema>;
export type ParsedConfigValidateBody = z.infer<typeof configValidateBodySchema>;
export type ParsedConfigSaveBody = z.infer<typeof configSaveBodySchema>;
export type ParsedEditorResourceParams = z.infer<typeof editorResourceParamsSchema>;
export type ParsedResourceItemParams = z.infer<typeof resourceItemParamsSchema>;
export type ParsedEditorOptionsParams = z.infer<typeof editorOptionsParamsSchema>;
export type ParsedBrowserProfileParams = z.infer<typeof browserProfileParamsSchema>;
export type ParsedWorkspacePathQuery = z.infer<typeof workspacePathQuerySchema>;
export type ParsedWorkspaceFileQuery = z.infer<typeof workspaceFileQuerySchema>;
export type ParsedWorkspaceAssetParams = z.infer<typeof workspaceAssetParamsSchema>;

export function respondBadRequest(reply: FastifyReply, error: string) {
  reply.code(400);
  return { error };
}

export function respondNotFound(reply: FastifyReply, error: string) {
  reply.code(404);
  return { error };
}

export function handleBadRequest(reply: FastifyReply, error: unknown) {
  return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
}

export function parseOrReply<TParsed>(
  reply: FastifyReply,
  parsed: TParsed | { error: string }
): parsed is TParsed {
  if (typeof parsed === "object" && parsed != null && "error" in parsed) {
    respondBadRequest(reply, parsed.error);
    return false;
  }
  return true;
}

function formatSchemaError(result: z.ZodError): string {
  return result.issues[0]?.message ?? "Invalid request";
}

function parseWithSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown
): z.infer<TSchema> | { error: string } {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? parsed.data
    : { error: formatSchemaError(parsed.error) };
}

export function parseSessionParams(params: unknown): ParsedSessionParams | { error: string } {
  return parseWithSchema(sessionParamsSchema, params);
}

export function parseWebTurnStreamQuery(query: unknown): ParsedWebTurnStreamQuery | { error: string } {
  return parseWithSchema(webTurnStreamQuerySchema, query);
}

export function parseWebSessionStreamQuery(query: unknown): ParsedWebSessionStreamQuery | { error: string } {
  return parseWithSchema(webSessionStreamQuerySchema, query);
}

export function parseShellRunBody(body: unknown): ParsedShellRunBody | { error: string } {
  return parseWithSchema(shellRunBodySchema, body);
}

export function parseShellInteractBody(body: unknown): ParsedShellInteractBody | { error: string } {
  return parseWithSchema(shellInteractBodySchema, body);
}

export function parseShellSignalBody(body: unknown): ParsedShellSignalBody | { error: string } {
  return parseWithSchema(shellSignalBodySchema, body);
}

export function parseSendTextBody(body: unknown): ParsedSendTextBody | { error: string } {
  return parseWithSchema(sendTextBodySchema, body);
}

export function parseWebTurnBody(body: unknown): ParsedWebTurnBody | { error: string } {
  return parseWithSchema(webTurnBodySchema, body);
}

export function parseCreateSessionBody(body: unknown): ParsedCreateSessionBody | { error: string } {
  return parseWithSchema(createSessionBodySchema, body);
}

export function parseUploadAssetsBody(body: unknown): ParsedUploadAssetsBody | { error: string } {
  return parseWithSchema(uploadAssetsBodySchema, body);
}

export function parseConfigValidateBody(body: unknown): ParsedConfigValidateBody | { error: string } {
  return parseWithSchema(configValidateBodySchema, body);
}

export function parseConfigSaveBody(body: unknown): ParsedConfigSaveBody | { error: string } {
  return parseWithSchema(configSaveBodySchema, body);
}

export function parseEditorResourceParams(params: unknown): ParsedEditorResourceParams | { error: string } {
  return parseWithSchema(editorResourceParamsSchema, params);
}

export function parseEditorOptionsParams(params: unknown): ParsedEditorOptionsParams | { error: string } {
  return parseWithSchema(editorOptionsParamsSchema, params);
}

export function parseResourceItemParams(params: unknown): ParsedResourceItemParams | { error: string } {
  return parseWithSchema(resourceItemParamsSchema, params);
}

export function parseBrowserProfileParams(params: unknown): ParsedBrowserProfileParams | { error: string } {
  return parseWithSchema(browserProfileParamsSchema, params);
}

export function parseWorkspacePathQuery(query: unknown): ParsedWorkspacePathQuery | { error: string } {
  return parseWithSchema(workspacePathQuerySchema, query);
}

export function parseWorkspaceFileQuery(query: unknown): ParsedWorkspaceFileQuery | { error: string } {
  return parseWithSchema(workspaceFileQuerySchema, query);
}

export function parseWorkspaceAssetParams(params: unknown): ParsedWorkspaceAssetParams | { error: string } {
  return parseWithSchema(workspaceAssetParamsSchema, params);
}
