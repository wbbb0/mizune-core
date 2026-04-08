import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { MediaWorkspace } from "../../src/services/workspace/mediaWorkspace.ts";
import { WorkspaceService } from "../../src/services/workspace/workspaceService.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "llm-bot-media-workspace-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type TestRequestHandler = (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void;

async function startServer(handler: TestRequestHandler): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind media workspace test server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function createMediaWorkspace(rootDir: string): MediaWorkspace {
  const config = createTestAppConfig({
    workspace: {
      enabled: true,
      root: rootDir,
      maxUploadBytes: 1024 * 1024,
      maxPatchFileBytes: 128 * 1024
    }
  });
  const workspaceService = new WorkspaceService(config, rootDir);
  return new MediaWorkspace(config, pino({ level: "silent" }), workspaceService);
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
  "base64"
);

async function main() {
  await runCase("importRemoteSource rejects corrupted downloaded images", async () => {
    await withTempDir(async (dir) => {
      const mediaWorkspace = createMediaWorkspace(dir);
      await mediaWorkspace.init();
      const server = await startServer(((req, res) => {
        if (req.url !== "/broken.png") {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end("not a real png");
      }) satisfies TestRequestHandler);

      try {
        await assert.rejects(
          mediaWorkspace.importRemoteSource({
            source: `${server.baseUrl}/broken.png`,
            origin: "browser_download"
          }),
          /Workspace image validation failed: image is invalid or corrupted/
        );
        assert.deepEqual(await mediaWorkspace.listFiles(), []);
      } finally {
        await server.close();
      }
    });
  });

  await runCase("importRemoteSource keeps valid downloaded images", async () => {
    await withTempDir(async (dir) => {
      const mediaWorkspace = createMediaWorkspace(dir);
      await mediaWorkspace.init();
      const server = await startServer(((req, res) => {
        if (req.url !== "/ok.png") {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(TINY_PNG);
      }) satisfies TestRequestHandler);

      try {
        const file = await mediaWorkspace.importRemoteSource({
          source: `${server.baseUrl}/ok.png`,
          origin: "browser_download"
        });
        assert.equal(file.kind, "image");
        assert.equal(file.mimeType, "image/png");
        assert.equal((await mediaWorkspace.listFiles()).length, 1);
      } finally {
        await server.close();
      }
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
