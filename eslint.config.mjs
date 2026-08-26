import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Design mockups. Kept as the record of how docs/design/*.png were
    // produced, not shipped and not imported by anything — so they answer to
    // the eye, not to the app's lint rules.
    "docs/design/**",
  ]),
]);

export default eslintConfig;
