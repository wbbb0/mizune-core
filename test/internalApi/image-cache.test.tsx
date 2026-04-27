import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

type TestInternalApiDeps = ReturnType<typeof createInternalApiDeps>;

test("image content endpoints expose one-week cache headers and 304 responses", async () => {
  const cases = [
    {
      name: "chat file image",
      url: "/api/chat-files/file_image_1/content"
    },
    {
      name: "local sendable image",
      url: "/api/local-files/send-content?path=photo.png",
      configure(deps: TestInternalApiDeps) {
        deps.localFileService = {
          ...deps.localFileService,
          resolvePath(relativePath: string) {
            if (relativePath !== "photo.png") {
              throw new Error(`Unknown workspace path: ${relativePath}`);
            }
            return {
              relativePath,
              absolutePath: join(deps.__state.workspaceRoot, "workspace", "media", "file_image_1.png")
            };
          }
        } as typeof deps.localFileService;
      }
    },
    {
      name: "local workspace image",
      url: "/api/local-files/content?path=workspace/media/file_image_1.png",
      configure(deps: TestInternalApiDeps) {
        deps.localFileService = {
          ...deps.localFileService,
          async readFileContent(relativePath: string) {
            if (relativePath !== "workspace/media/file_image_1.png") {
              throw new Error(`Unknown workspace path: ${relativePath}`);
            }
            return {
              path: relativePath,
              contentType: "image/png",
              buffer: Buffer.from("fixture-image")
            };
          }
        } as typeof deps.localFileService;
      }
    }
  ];

  for (const item of cases) {
    const deps = createInternalApiDeps();
    item.configure?.(deps);
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "GET",
        url: item.url
      });

      assert.equal(response.statusCode, 200, item.name);
      assert.equal(response.headers["content-type"], "image/png", item.name);
      assert.equal(response.headers["cache-control"], "private, max-age=604800", item.name);
      assert.equal(typeof response.headers.etag, "string", item.name);

      const cached = await app.inject({
        method: "GET",
        url: item.url,
        headers: {
          "if-none-match": String(response.headers.etag)
        }
      });

      assert.equal(cached.statusCode, 304, item.name);
      assert.equal(cached.body, "", item.name);
      assert.equal(cached.headers["cache-control"], "private, max-age=604800", item.name);
    } finally {
      await app.close();
    }
  }
});
