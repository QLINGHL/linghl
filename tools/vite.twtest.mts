import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "tools",
  plugins: [tailwindcss()],
  build: {
    outDir: "tw-out",
    cssCodeSplit: false,
    rollupOptions: {
      input: "tools/tw-test.html",
    },
  },
});
