import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  shims: false,
  splitting: true,
  banner: { js: "#!/usr/bin/env node" },
  loader: { ".md": "text" },
});
