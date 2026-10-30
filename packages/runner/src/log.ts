// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './redact.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export interface FileLoggerOptions {
  file: string;
  /** Rotate when the file reaches this size. */
  maxBytes?: number;
  /** How many rotated files to keep (`runner.log.1` ... `runner.log.N`). */
  keep?: number;
  /** Also print lines at or above `info` to this writer (the terminal, in the foreground). */
  echo?: (line: string) => void;
  now?: () => Date;
}

export const LOG_MAX_BYTES = 1_000_000;
export const LOG_KEEP = 5;

/**
 * A rotating file log. EVERY line passes through `redact` before it is written or echoed, so a secret that reached a message by
 * accident (an error that quotes a header, a URL, a response body) still never reaches the disk. The file is 0600: a log can name
 * agents, records and machine paths, and is no one else's business.
 */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const { file, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP, echo, now = () => new Date() } = options;
  const write = (level: string, message: string): void => {
    const line = redact(`${now().toISOString()} ${level} ${message}`);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      rotateIfNeeded(file, maxBytes, keep);
      const fresh = !existsSync(file);
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
      if (fresh) chmodSync(file, 0o600);
    } catch {
      // A full disk or a read-only home must not take the Runner down; the terminal echo below still tells the person.
    }
    if (echo && level !== 'DEBUG') echo(line);
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    debug: (m) => write('DEBUG', m),
  };
}

function rotateIfNeeded(file: string, maxBytes: number, keep: number): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  renameSync(file, `${file}.1`);
}
