import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // electron-updater is bundled into main: electron-builder.yml packs no node_modules but three
  main: { plugins: [externalizeDepsPlugin({ exclude: ["electron-updater"] })] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    resolve: { alias: { "@shared": resolve("src/shared"), "@core": resolve("src/renderer/core") } },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          teleprompter: resolve("src/renderer/teleprompter.html"),
          draw: resolve("src/renderer/draw.html"),
        },
      },
    },
  },
});
