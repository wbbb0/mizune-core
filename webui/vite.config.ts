import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { createGzipPrecompressionPlugin } from "./build/gzipPrecompression";

const configDir = fileURLToPath(new URL(".", import.meta.url));

function loadWebuiDevConfig(): {
  apiPort: number;
  webuiPort: number;
  allowedHosts: string[];
} {
  const repoRoot = resolve(configDir, "..");
  const configInstanceFile = process.env["CONFIG_INSTANCE_FILE"]?.trim();
  const configInstance = process.env["CONFIG_INSTANCE"]?.trim();

  const candidateFiles = [
    resolve(repoRoot, "config/global.yml"),
    ...(configInstanceFile ? [resolve(repoRoot, configInstanceFile)] : []),
    ...(configInstance ? [resolve(repoRoot, `config/instances/${configInstance}.yml`)] : [])
  ];

  let apiPort = 3030;
  let webuiPort = 3031;
  let allowedHosts: string[] = [];

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const parsed = YAML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown> | null;
      const internalApi = parsed?.["internalApi"];
      if (!internalApi || typeof internalApi !== "object") {
        continue;
      }
      const nextApiPort = (internalApi as Record<string, unknown>)["port"];
      if (typeof nextApiPort === "number" && Number.isInteger(nextApiPort) && nextApiPort > 0) {
        apiPort = nextApiPort;
      }
      const webui = (internalApi as Record<string, unknown>)["webui"];
      if (!webui || typeof webui !== "object") {
        continue;
      }
      const nextAllowedHosts = (webui as Record<string, unknown>)["allowedHosts"];
      if (Array.isArray(nextAllowedHosts)) {
        allowedHosts = nextAllowedHosts
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
      const nextWebuiPort = (webui as Record<string, unknown>)["port"];
      if (typeof nextWebuiPort === "number" && Number.isInteger(nextWebuiPort) && nextWebuiPort > 0) {
        webuiPort = nextWebuiPort;
      }
    } catch {
      // Ignore malformed local config and keep the current fallback target.
    }
  }

  return { apiPort, webuiPort, allowedHosts };
}

function getWebuiApiTarget(): string {
  const explicitTarget = process.env["VITE_API_TARGET"]?.trim();
  if (explicitTarget) {
    return explicitTarget;
  }

  const host = process.env["VITE_API_HOST"]?.trim() || "127.0.0.1";
  const { apiPort } = loadWebuiDevConfig();
  return `http://${host}:${apiPort}`;
}

function getWebuiDevPort(): number {
  const rawPort = process.env["VITE_DEV_PORT"]?.trim();
  if (rawPort) {
    const parsedPort = Number(rawPort);
    if (Number.isInteger(parsedPort) && parsedPort > 0) {
      return parsedPort;
    }
  }

  return loadWebuiDevConfig().webuiPort;
}

const apiTarget = getWebuiApiTarget();
const devPort = getWebuiDevPort();
const allowedHosts = loadWebuiDevConfig().allowedHosts;
const sharedProxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true
  }
};

export default defineConfig({
  base: "/webui/",
  plugins: [
    vue(),
    tailwindcss(),
    createGzipPrecompressionPlugin(),
    VitePWA({
      base: "/webui/",
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/apple-touch-icon.png"],
      manifest: {
        name: "llm-bot",
        short_name: "llm-bot",
        description: "llm-bot WebUI 管理界面",
        start_url: "/webui/#/sessions",
        scope: "/webui/",
        display_override: [
          "window-controls-overlay",
          "standalone"
        ],
        orientation: "any",
        background_color: "#0b1220",
        theme_color: "#0b1220",
        icons: [
          {
            src: "/webui/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "/webui/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "/webui/icons/apple-touch-icon.png",
            sizes: "180x180",
            type: "image/png"
          }
        ]
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: "/webui/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webp,json}"],
        // The HEIF converter is only needed on demand during upload, so avoid
        // precaching its large hashed chunk in the PWA manifest.
        globIgnores: ["**/assets/heic-to-*.js"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly"
          }
        ]
      },
      devOptions: {
        enabled: true
      }
    })
  ],
  resolve: {
    alias: {
      "@": resolve(configDir, "src")
    }
  },
  server: {
    host: "0.0.0.0",
    port: devPort,
    strictPort: true,
    allowedHosts,
    proxy: sharedProxy
  },
  preview: {
    host: "0.0.0.0",
    port: devPort,
    strictPort: true,
    proxy: sharedProxy
  },
  build: {
    outDir: "dist",
    sourcemap: false
  }
});
