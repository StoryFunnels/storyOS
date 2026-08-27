// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.d.ts', '**/.turbo/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // NestJS DI relies on emitDecoratorMetadata: classes referenced only as
    // constructor-param types MUST stay value imports, or tsc elides them and
    // injection resolves to Object at runtime. Keep type-imports manual in the API.
    files: ['apps/api/src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    /**
     * Rules of Hooks, as an ERROR (#414 follow-up).
     *
     * The web app is a React app that had no hooks lint at all. #412 added a
     * `useDragPresentation` call BELOW `RecordDetail`'s two early returns, so the
     * component ran 110 hooks while the record loaded and 111 once it arrived:
     * "Rendered more hooks than during the previous render". Every record page on
     * main was a blank error boundary. Lint passed, typecheck passed, every unit
     * test passed, and it merged.
     *
     * Only `rules-of-hooks` is on. `exhaustive-deps` is a different argument —
     * it has real false positives, it would light up a codebase this size, and
     * bundling the two would mean turning both off the first time someone
     * disagreed with a dependency warning. This rule has no false positives worth
     * the name: it catches a crash.
     */
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
  {
    // API-first is structural (CONTRIBUTING.md): the web app talks to the
    // backend ONLY through @storyos/sdk. No API internals, no DB clients.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@storyos/api', '@storyos/api/*', '**/apps/api/**'], message: 'The web app must use @storyos/sdk, never API internals.' },
            { group: ['drizzle-orm', 'drizzle-orm/*', 'pg'], message: 'No database access from the web app — use @storyos/sdk.' },
          ],
        },
      ],
    },
  },
);
