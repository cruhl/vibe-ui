import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { devPlugin } from "./dev/plugin.ts";

const root = import.meta.dirname;
const gitCommit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  plugins: [react(), devPlugin(root)],
  define: { "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(gitCommit) },
  server: {
    port: 5317,
    strictPort: true,
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        ".dev.vars*",
        "**/.agent/**",
        "**/.claude/**",
        "**/.wrangler/**",
      ],
    },
    hmr: process.env.VIBE_UI_NO_RELOAD !== "1",
    watch: process.env.VIBE_UI_NO_RELOAD === "1" ? null : {},
    proxy: {
      "/jev": {
        target: "https://api.typesafe.ai",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jev/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => {
            request.removeHeader("origin");
            request.removeHeader("referer");
          });
        },
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/].*(react|react-dom|scheduler)[\\/]/ },
            { name: "openai", test: /node_modules[\\/].*openai[\\/]/ },
            { name: "zod", test: /node_modules[\\/].*zod[\\/]/ },
            { name: "reactor", test: /node_modules[\\/].*@reactor-team[\\/]/ },
            { name: "presets", test: /src[\\/]presets[\\/]/ },
          ],
        },
      },
    },
  },
});
