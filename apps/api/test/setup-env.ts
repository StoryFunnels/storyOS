import { inject } from 'vitest';

/**
 * Runs before each test file's imports. Must set DATABASE_URL here because
 * env() is evaluated (and cached) at module-import time — e.g. inside the
 * @Module decorator of AppModule. Setting it later silently falls back to
 * the dev-database default.
 */
process.env.DATABASE_URL = inject('databaseUrl');
process.env.NODE_ENV = 'test';
