import assert from "node:assert/strict";
import test from "node:test";
import {
  isPrecacheResponseAllowed,
  precacheResponseValidationPlugin
} from "../../../webui/src/pwa/precacheResponsePolicy.ts";

function response(contentType: string, options: { status?: number; redirected?: boolean } = {}) {
  return {
    status: options.status ?? 200,
    redirected: options.redirected ?? false,
    headers: new Headers({ "content-type": contentType })
  };
}

test("precache policy accepts matching content types", () => {
  assert.equal(isPrecacheResponseAllowed(
    { url: "https://example.test/webui/assets/index-abc.js" },
    response("application/javascript; charset=utf-8")
  ), true);
  assert.equal(isPrecacheResponseAllowed(
    { url: "https://example.test/webui/manifest.webmanifest" },
    response("application/manifest+json")
  ), true);
});

test("precache policy rejects redirects, errors, and HTML returned for scripts", () => {
  assert.equal(isPrecacheResponseAllowed(
    { url: "https://example.test/webui/assets/index-abc.js" },
    response("text/html")
  ), false);
  assert.equal(isPrecacheResponseAllowed(
    { url: "https://example.test/webui/index.html" },
    response("text/html", { redirected: true })
  ), false);
  assert.equal(isPrecacheResponseAllowed(
    { url: "https://example.test/webui/index.html" },
    response("text/html", { status: 404 })
  ), false);
  assert.equal(isPrecacheResponseAllowed(
    { url: "https://example.test/webui/index.html" },
    response("text/html", { status: 302 })
  ), false);
});

test("precache plugin rejects the original redirected response before cache insertion", async () => {
  const request = { url: "https://example.test/webui/index.html" };
  const redirected = response("text/html", { redirected: true });

  await assert.rejects(
    precacheResponseValidationPlugin.fetchDidSucceed!({
      request,
      response: redirected
    } as never),
    /拒绝预缓存不安全响应/
  );
  assert.equal(
    await precacheResponseValidationPlugin.cacheWillUpdate!({
      request,
      response: redirected
    } as never),
    null
  );
});
