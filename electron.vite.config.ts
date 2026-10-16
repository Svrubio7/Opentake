import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    resolve: { alias: { "@shared": resolve("src/shared"), "@core": resolve("src/renderer/core") } },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          teleprompter: resolve("src/renderer/teleprompter.html"),
        },
      },
    },
  },
});
