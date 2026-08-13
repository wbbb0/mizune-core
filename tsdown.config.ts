import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: true,
  sourcemap: true,
  clean: true,
  shims: false
});
