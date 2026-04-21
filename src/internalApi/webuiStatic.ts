import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

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

export async function registerWebuiStaticRoutes(app: FastifyInstance, distPath: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: "/webui/",
    wildcard: false,
    preCompressed: true,
    globIgnore: ["**/*.gz", "**/*.br"],
    setHeaders(response) {
      appendVaryHeader(response, "Accept-Encoding");
    }
  });

  // SPA fallback: all /webui/* routes that don't match a static file serve index.html.
  app.get("/webui/*", (_, reply) => {
    void reply.sendFile("index.html");
  });
}
