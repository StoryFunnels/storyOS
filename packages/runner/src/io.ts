// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline/promises';
import { redact } from './redact.js';

/** What a command talks to the person through. Injected so tests can read what was said and answer what was asked. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Ask a question; resolves with the typed answer. Rejects if there is no terminal to ask on. */
  prompt(question: string): Promise<string>;
}

/** The real terminal. Everything printed passes through `redact`: a secret that slipped into a message still never reaches the screen. */
export function terminalIo(): Io {
  return {
    out: (line) => process.stdout.write(`${redact(line)}\n`),
    err: (line) => process.stderr.write(`${redact(line)}\n`),
    async prompt(question) {
      if (!process.stdin.isTTY) throw new Error('No terminal to ask on. Pass the code as an argument.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
  };
}
