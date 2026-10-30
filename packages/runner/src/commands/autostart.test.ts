// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAUNCHD_LABEL, installAutostart, launchdPath, launchdPlist, looksLikeNpxCache, systemdPath, systemdUnit, uninstallAutostart } from './autostart.js';
import type { AutostartSpec } from './autostart.js';
import { runnerHome } from '../store.js';
import { testIo } from '../../test/helpers.js';

let userHome: string;
beforeEach(() => (userHome = mkdtempSync(join(tmpdir(), 'storyos-autostart-'))));
afterEach(() => rmSync(userHome, { recursive: true, force: true }));

const spec = (over: Partial<AutostartSpec> = {}): AutostartSpec => {
  const home = runnerHome({ STORYOS_RUNNER_HOME: join(userHome, '.storyos-runner') });
  return { nodePath: '/usr/local/bin/node', scriptPath: '/usr/local/lib/node_modules/@storyos/runner/dist/index.js', path: '/usr/local/bin:/usr/bin:/Users/me/.local/bin', home, homeIsCustom: false, logFile: home.logFile, ...over };
};

describe('launchd (macOS)', () => {
  it('starts at login, restarts after a crash but not after a clean stop, and carries the PATH the tools are found through', () => {
    const plist = launchdPlist(spec());
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain('/Users/me/.local/bin');
  });

  it('escapes XML and never holds a secret', () => {
    const plist = launchdPlist(spec({ path: '/a&b:/c<d' }));
    expect(plist).toContain('/a&amp;b:/c&lt;d');
    expect(plist).not.toMatch(/mn_run_|token/i);
  });

  it('is a valid property list (checked with plutil where it exists)', () => {
    if (process.platform !== 'darwin') return;
    const file = join(userHome, 'x.plist');
    installAutostart({ home: spec().home, io: testIo(), platform: 'darwin', userHome, noLoad: true, nodePath: '/usr/local/bin/node', scriptPath: '/opt/runner/dist/index.js', path: '/usr/bin' });
    expect(() => execFileSync('plutil', ['-lint', launchdPath(userHome)], { stdio: 'pipe' })).not.toThrow();
    void file;
  });

  it('installs with --no-load, loads through launchctl otherwise, and uninstalls', () => {
    const calls: string[] = [];
    const io = testIo();
    const base = { home: spec().home, io, platform: 'darwin' as const, userHome, uid: 501, scriptPath: '/opt/runner/dist/index.js', run: (c: string, a: string[]) => void calls.push(`${c} ${a.join(' ')}`) };
    expect(installAutostart(base)).toBe(0);
    expect(existsSync(launchdPath(userHome))).toBe(true);
    expect(calls).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`, `launchctl bootstrap gui/501 ${launchdPath(userHome)}`]);
    expect(uninstallAutostart(base)).toBe(0);
    expect(existsSync(launchdPath(userHome))).toBe(false);
    expect(calls.at(-1)).toBe(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
  });

  it('refuses to install from npx\'s temporary cache and says what to do instead', () => {
    const io = testIo();
    const code = installAutostart({ home: spec().home, io, platform: 'darwin', userHome, noLoad: true, scriptPath: '/Users/me/.npm/_npx/abc123/node_modules/@storyos/runner/dist/index.js' });
    expect(code).toBe(1);
    expect(io.errors.join(' ')).toContain('npm install -g @storyos/runner');
    expect(existsSync(launchdPath(userHome))).toBe(false);
    expect(looksLikeNpxCache('/usr/local/lib/node_modules/@storyos/runner/dist/index.js')).toBe(false);
  });
});

describe('systemd (Linux, for the server guide)', () => {
  it('is a user unit that starts the Runner, restarts on failure, and waits for the network', () => {
    const unit = systemdUnit(spec());
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/usr/local/lib/node_modules/@storyos/runner/dist/index.js" start');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/mn_run_|token/i);
  });

  it('--print writes the unit to stdout and touches nothing', () => {
    const io = testIo();
    expect(installAutostart({ home: spec().home, io, platform: 'linux', userHome, print: true, scriptPath: '/opt/runner/dist/index.js' })).toBe(0);
    expect(io.lines.join('\n')).toContain('[Service]');
    expect(existsSync(systemdPath(userHome))).toBe(false);
  });

  it('installs and enables through systemctl --user', () => {
    const calls: string[] = [];
    const io = testIo();
    installAutostart({ home: spec().home, io, platform: 'linux', userHome, scriptPath: '/opt/runner/dist/index.js', run: (c, a) => void calls.push(`${c} ${a.join(' ')}`) });
    expect(readFileSync(systemdPath(userHome), 'utf8')).toContain('[Install]');
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now storyos-runner.service']);
  });
});

describe('other systems', () => {
  it('says so plainly', () => {
    const io = testIo();
    expect(installAutostart({ home: spec().home, io, platform: 'win32', userHome })).toBe(1);
    expect(io.errors.join(' ')).toContain('macOS and Linux');
  });
});
