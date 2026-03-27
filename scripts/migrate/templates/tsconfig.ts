export function generateTsconfig(): string {
  const config = {
    compilerOptions: {
      jsx: "react-jsx",
      moduleResolution: "bundler",
      module: "ESNext",
      target: "ES2022",
      skipLibCheck: true,
      strictNullChecks: true,
      forceConsistentCasingInFileNames: true,
      types: ["vite/client"],
      baseUrl: ".",
      paths: {
        "~/*": ["./src/*"],
      },
    },
    include: ["src/**/*", "vite.config.ts"],
  };

  return JSON.stringify(config, null, 2) + "\n";
}
