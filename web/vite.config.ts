import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root,
  base: "/",
  resolve: {
    dedupe: ["react", "react-dom"]
  },
  build: {
    emptyOutDir: true,
    outDir: join(root, "../dist/web")
  }
});
