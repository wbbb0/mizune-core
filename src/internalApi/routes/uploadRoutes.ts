import type { FastifyInstance } from "fastify";
import {
  parseOrReply,
  parseUploadAssetsBody,
  respondBadRequest
} from "../routeSupport.ts";
import type { InternalApiServices } from "../types.ts";
import { createAdminWorkspaceUploadService } from "../application/workspaceUploadAdminService.ts";

const IMAGE_UPLOAD_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export function registerUploadRoutes(app: FastifyInstance, services: InternalApiServices): void {
  const workspaceUploads = createAdminWorkspaceUploadService(services.uploads);

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
      return respondBadRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });
}
