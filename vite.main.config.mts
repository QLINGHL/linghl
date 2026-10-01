import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  build: {
    outDir: ".vite/build",
    lib: {
      entry: "src/main/main.ts",
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: [
        "electron",
        "node-pty",
        "better-sqlite3",
        "vscode-jsonrpc/node.js",
        "node:path",
        "node:fs",
        "node:child_process",
        "node:crypto",
        "node:os",
        "node:net",
        "node:url",
        "node:http",
        "node:timers",
        "node:sqlite",
      ],
      output: {
        format: "cjs",
      },
    },
    emptyOutDir: false,
  },
});
