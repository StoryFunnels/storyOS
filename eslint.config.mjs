// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
