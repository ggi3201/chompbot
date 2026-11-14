import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const envDir = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  // Proxy to the API on the PORT in the repo's .env, the same one `pnpm dev` starts it on.
  const apiPort = loadEnv(mode, envDir, "").PORT || "3001";
  return {
    envDir,
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        "/api": `http://localhost:${apiPort}`,
        "/ws": {
          target: `ws://localhost:${apiPort}`,
          ws: true,
        },
      },
    },
  };
});
