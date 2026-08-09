import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["src/app/whiteboard/WhiteboardClient.tsx"],
    rules: {
      // This high-frequency canvas engine intentionally keeps mutable drawing state in refs.
      // React Compiler is not enabled; standard Rules of Hooks checks remain active.
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "build/**",
    "coverage/**",
    "node_modules/**",
    "next-env.d.ts",
    "out/**",
  ]),
]);
