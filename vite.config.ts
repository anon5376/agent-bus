import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2019",
    cssTarget: "safari14",
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
