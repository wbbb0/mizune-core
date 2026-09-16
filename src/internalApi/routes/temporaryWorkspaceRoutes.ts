import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TemporaryWorkspaceService } from "#services/workspace/temporaryWorkspaceService.ts";
import { handleBadRequest } from "../routeSupport.ts";

const paramsSchema = z.object({ workspaceId: z.string().regex(/^ws_[a-f0-9]{32}$/) });
const querySchema = z.object({ path: z.string().default("."), startLine: z.coerce.number().int().positive().optional(), download: z.enum(["1"]).optional() });
const inlineTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm"
};

/** Uses the same admin authentication as the resource/terminal API. */
export function registerTemporaryWorkspaceRoutes(app: FastifyInstance, workspaces: TemporaryWorkspaceService): void {
  app.get("/api/workspaces", async () => ({ workspaces: workspaces.list() }));
  for (const operation of ["files", "text", "content"] as const) {
    app.get(`/api/workspaces/:workspaceId/${operation}`, async (request, reply) => {
      try {
        const { workspaceId } = paramsSchema.parse(request.params);
        const query = querySchema.parse(request.query);
        return await workspaces.withFiles(workspaceId, null, async (files) => {
          if (operation === "files") {
            const { root: _root, ...result } = await files.listItems(query.path, 500);
            return result;
          }
          if (operation === "text") return files.readFile(query.path, query.startLine ? { startLine: query.startLine } : {});
          const target = files.resolvePath(query.path);
          const info = await stat(target.absolutePath);
          if (!info.isFile()) throw new Error("请选择文件");
          const mime = inlineTypes[extname(query.path).toLowerCase()];
          const attachment = query.download === "1" || !mime;
          reply.header("Cache-Control", "no-store");
          reply.header("X-Content-Type-Options", "nosniff");
          reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
          reply.header("Content-Disposition", `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(query.path))}`);
          reply.header("Accept-Ranges", "bytes");
          const range = request.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            const start = match?.[1] ? Number(match[1]) : Math.max(0, info.size - Number(match?.[2]));
            const end = match?.[1] && match[2] ? Math.min(info.size - 1, Number(match[2])) : info.size - 1;
            if (!match || !match[1] && !match[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
              return reply.code(416).header("Content-Range", `bytes */${info.size}`).send();
            }
            reply.code(206).header("Content-Range", `bytes ${start}-${end}/${info.size}`).header("Content-Length", end - start + 1);
            return reply.type(mime ?? "application/octet-stream").send(createReadStream(target.absolutePath, { start, end }));
          }
          reply.header("Content-Length", info.size);
          return reply.type(mime ?? "application/octet-stream").send(createReadStream(target.absolutePath));
        });
      } catch (error) { return handleBadRequest(reply, error); }
    });
  }
}
