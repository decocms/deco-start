import type { MigrationContext } from "../types.ts";

export function generateViteConfig(ctx: MigrationContext): string {
  const isVtex = ctx.platform === "vtex";

  const vtexProxy = isVtex ? `
    // VTEX API proxy for local development
    proxy: {
      "/api/": {
        target: "https://\${process.env.VTEX_ACCOUNT || "${ctx.siteName}"}.vtexcommercestable.com.br",
        changeOrigin: true,
        secure: true,
      },
      "/checkout/": {
        target: "https://\${process.env.VTEX_ACCOUNT || "${ctx.siteName}"}.vtexcommercestable.com.br",
        changeOrigin: true,
        secure: true,
      },
    },` : "";

  return `import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { decoVitePlugin } from "@decocms/start/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "path";

const srcDir = path.resolve(__dirname, "src");

export default defineConfig({
  server: {
    allowedHosts: [".decocdn.com"],${vtexProxy}
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ server: { entry: "server" } }),
    react({
      babel: {
        plugins: [
          ["babel-plugin-react-compiler", { target: "19" }],
        ],
      },
    }),
    tailwindcss(),
    decoVitePlugin(),
    {
      name: "site-manual-chunks",
      config(_cfg, { command }) {
        if (command !== "build") return;
        return {
          build: {
            rollupOptions: {
              output: {
                manualChunks(id: string) {
                  if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/"))
                    return "vendor-react";
                  if (id.includes("@tanstack/react-router") || id.includes("@tanstack/start"))
                    return "vendor-router";
                  if (id.includes("@tanstack/react-query")) return "vendor-query";
                },
              },
            },
          },
        };
      },
    },
    {
      name: "deco-stub-meta-gen",
      enforce: "pre" as const,
      resolveId(id, importer, options) {
        if (!options?.ssr && importer && id.includes("meta.gen")) {
          return "\\0stub:meta-gen";
        }
      },
      load(id) {
        if (id === "\\0stub:meta-gen") {
          return "export default {};";
        }
      },
    },
  ],
  build: {
    sourcemap: "hidden",
    rollupOptions: {
      onLog(level, log, handler) {
        if (
          log.code === "PLUGIN_WARNING" &&
          log.plugin === "vite:reporter" &&
          log.message?.includes("dynamic import will not move module")
        ) {
          return;
        }
        handler(level, log);
      },
    },
  },
  define: {
    "process.env.DECO_SITE_NAME": JSON.stringify(
      process.env.DECO_SITE_NAME || "${ctx.siteName}"
    ),
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    dedupe: [
      "@tanstack/react-start",
      "@tanstack/react-router",
      "@tanstack/react-start-server",
      "@tanstack/start-server-core",
      "@tanstack/start-client-core",
      "@tanstack/start-plugin-core",
      "@tanstack/start-storage-context",
      "react",
      "react-dom",
    ],
    alias: {
      "~": srcDir,
    },
  },
});
`;
}
