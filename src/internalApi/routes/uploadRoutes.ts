import type { FastifyInstance } from "fastify";
import {
  parseOrReply,
  parseUploadAssetsBody,
  respondBadRequest
} from "../routeSupport.ts";
import type { InternalApiServices } from "../types.ts";
import { createAdminWorkspaceUploadService } from "../application/workspaceUploadAdminService.ts";

const IMAGE_UPLOAD_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export function registerUploadRoutes(app: FastifyInstance, services: InternalApiServices["uploadRoutes"]): void {
  const workspaceUploads = createAdminWorkspaceUploadService(services);

  app.post("/api/uploads/files", {
    bodyLimit: IMAGE_UPLOAD_BODY_LIMIT_BYTES
  }, async (request, reply) => {
    const body = parseUploadAssetsBody(request.body);
    if (!parseOrReply(reply, body)) {
      return reply;
    }

    try {
      return await workspaceUploads.uploadFiles({
        files: body.files.map((file) => ({
          mimeType: file.mimeType,
          contentBase64: file.contentBase64,
          ...(file.sourceName ? { sourceName: file.sourceName } : {}),
          ...(file.kind ? { kind: file.kind } : {})
        }))
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      services.logger.warn({
        path: request.url,
        fileCount: body.files.length,
        fileNames: body.files.map((file) => file.sourceName ?? null),
        mimeTypes: body.files.map((file) => file.mimeType),
        error: message
      }, "internal_api_upload_failed");
      return respondBadRequest(reply, message);
    }
  });
}
