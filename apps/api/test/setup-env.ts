import { inject } from 'vitest';

/**
 * Runs before each test file's imports. Must set DATABASE_URL here because
 * env() is evaluated (and cached) at module-import time — e.g. inside the
 * @Module decorator of AppModule. Setting it later silently falls back to
 * the dev-database default.
 */
process.env.DATABASE_URL = inject('databaseUrl');
process.env.NODE_ENV = 'test';

process.env.ATTACHMENT_MAX_BYTES = String(1024 * 1024); // 1MB cap in tests
process.env.ATTACHMENTS_DIR = `/tmp/storyos-attachments-test-${process.pid}`;
