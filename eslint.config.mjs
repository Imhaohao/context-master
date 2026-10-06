import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
export default defineConfig([
  ...nextVitals, ...nextTs,
  { rules: { complexity: ['error', 15], '@typescript-eslint/no-explicit-any': 'error' } },
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  globalIgnores(['.next/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts', 'desktop-bundle/**', 'agent-bundle/**', 'desktop-app/**', 'release/**'])
]);
