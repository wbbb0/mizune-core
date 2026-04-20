import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

test("chat file image content exposes one-week cache headers and 304 responses", async () => {
  const app = await createInternalApiApp(createInternalApiDeps());
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/chat-files/file_image_1/content"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["cache-control"], "private, max-age=604800");
    assert.equal(typeof response.headers.etag, "string");

    const cached = await app.inject({
      method: "GET",
      url: "/api/chat-files/file_image_1/content",
      headers: {
        "if-none-match": String(response.headers.etag)
      }
    });

    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, "");
    assert.equal(cached.headers["cache-control"], "private, max-age=604800");
  } finally {
    await app.close();
  }
});

test("local sendable image content exposes one-week cache headers and 304 responses", async () => {
  const deps = createInternalApiDeps();
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

  const app = await createInternalApiApp(deps);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/local-files/send-content?path=photo.png"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["cache-control"], "private, max-age=604800");
    assert.equal(typeof response.headers.etag, "string");

    const cached = await app.inject({
      method: "GET",
      url: "/api/local-files/send-content?path=photo.png",
      headers: {
        "if-none-match": String(response.headers.etag)
      }
    });

    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, "");
    assert.equal(cached.headers["cache-control"], "private, max-age=604800");
  } finally {
    await app.close();
  }
});

test("local workspace image content exposes one-week cache headers and 304 responses", async () => {
  const deps = createInternalApiDeps();
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
  const app = await createInternalApiApp(deps);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/local-files/content?path=workspace/media/file_image_1.png"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["cache-control"], "private, max-age=604800");
    assert.equal(typeof response.headers.etag, "string");

    const cached = await app.inject({
      method: "GET",
      url: "/api/local-files/content?path=workspace/media/file_image_1.png",
      headers: {
        "if-none-match": String(response.headers.etag)
      }
    });

    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, "");
    assert.equal(cached.headers["cache-control"], "private, max-age=604800");
  } finally {
    await app.close();
  }
});
