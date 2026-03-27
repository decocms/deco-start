export function generateKnipConfig(): string {
  return `import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "src/routes/**/*.{ts,tsx}",
    "src/setup.ts",
    "src/runtime.ts",
    "src/sections/**/*.{ts,tsx}",
    "vite.config.ts",
  ],
  project: ["src/**/*.{ts,tsx}"],
  ignore: [
    "src/server/invoke.gen.ts",
    "src/server/cms/blocks.gen.ts",
    "src/routeTree.gen.ts",
  ],
  ignoreDependencies: [
    "babel-plugin-react-compiler",
    "@vitejs/plugin-react",
    "wrangler",
  ],
};

export default config;
`;
}
