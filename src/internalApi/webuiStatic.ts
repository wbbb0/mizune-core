import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { basename, join } from "node:path";

function appendVaryHeader(
  response: { getHeader: (name: string) => unknown; setHeader: (name: string, value: string) => void },
  value: string
): void {
  const current = response.getHeader("Vary");
  if (typeof current !== "string" || current.trim().length === 0) {
    response.setHeader("Vary", value);
    return;
  }

  const existingValues = current.split(",").map((part) => part.trim().toLowerCase());
  if (existingValues.includes(value.toLowerCase())) {
    return;
  }
  response.setHeader("Vary", `${current}, ${value}`);
}

function stripCompressionExtension(path: string): string {
  return path.replace(/\.(?:br|gz)$/i, "");
}

function setWebuiCacheHeaders(
  response: { getHeader: (name: string) => unknown; setHeader: (name: string, value: string) => void },
  path: string
): void {
  appendVaryHeader(response, "Accept-Encoding");
  const normalizedPath = stripCompressionExtension(path);
  const filename = basename(normalizedPath).toLowerCase();

  if (filename === "sw.js") {
    response.setHeader("Cache-Control", "no-store");
    return;
  }
  response.setHeader("Cache-Control", "no-cache");
}

function setWebuiAssetCacheHeaders(
  response: { getHeader: (name: string) => unknown; setHeader: (name: string, value: string) => void }
): void {
  appendVaryHeader(response, "Accept-Encoding");
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
}

export async function registerWebuiStaticRoutes(
  app: FastifyInstance,
  distPath: string,
  assetsPath = join(distPath, "assets")
): Promise<void> {
  await app.register(fastifyStatic, {
    root: assetsPath,
    prefix: "/webui/assets/",
    wildcard: false,
    preCompressed: true,
    cacheControl: false,
    globIgnore: ["**/*.gz", "**/*.br"],
    setHeaders(response) {
      setWebuiAssetCacheHeaders(response);
    }
  });

  await app.register(fastifyStatic, {
    root: distPath,
    prefix: "/webui/",
    wildcard: false,
    preCompressed: true,
    decorateReply: false,
    cacheControl: false,
    globIgnore: ["assets/**", "**/*.gz", "**/*.br"],
    setHeaders(response, path) {
      setWebuiCacheHeaders(response, path);
    }
  });

  app.get("/", (_, reply) => {
    void reply.redirect("/webui/", 302);
  });
  app.get("/webui", (_, reply) => {
    void reply.redirect("/webui/", 308);
  });
}
