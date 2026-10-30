// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Io } from '../io.js';
import type { RunnerHome } from '../store.js';

export const LAUNCHD_LABEL = 'dev.storyos.runner';
export const SYSTEMD_UNIT = 'storyos-runner.service';

export interface AutostartSpec {
  /** The node binary and the Runner's entry script. */
  nodePath: string;
  scriptPath: string;
  /** What the login shell would see: the tools (`claude`, `cursor-agent`) are found through PATH, and launchd's own PATH is nearly empty. */
  path: string;
  home: RunnerHome;
  /** Only written when the Runner home is not the default. */
  homeIsCustom: boolean;
  logFile: string;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The macOS launch agent. It runs `start` at login and again after a crash, but NOT after a clean exit, so `stop` stays stopped until
 * the next login. It carries no secret: the runner token stays in `config.json` (0600), never in this file.
 */
export function launchdPlist(spec: AutostartSpec): string {
  const env: Array<[string, string]> = [['PATH', spec.path]];
  if (spec.homeIsCustom) env.push(['STORYOS_RUNNER_HOME', spec.home.dir]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.nodePath)}</string>
    <string>${xml(spec.scriptPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

/** The Linux systemd USER unit, for the server guide: `systemctl --user enable --now storyos-runner`, plus `loginctl enable-linger` to survive logout. */
export function systemdUnit(spec: AutostartSpec): string {
  const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=StoryOS Runner: runs your hired agents on this computer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quote(spec.nodePath)} ${quote(spec.scriptPath)} start
Restart=on-failure
RestartSec=30
Environment=${quote(`PATH=${spec.path}`)}
${spec.homeIsCustom ? `Environment=${quote(`STORYOS_RUNNER_HOME=${spec.home.dir}`)}\n` : ''}
[Install]
WantedBy=default.target
`;
}

export function launchdPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}
export function systemdPath(home = homedir()): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

export interface AutostartOptions {
  home: RunnerHome;
  io: Io;
  platform?: NodeJS.Platform;
  userHome?: string;
  nodePath?: string;
  scriptPath?: string;
  path?: string;
  /** Print the file instead of installing it (for the server guide). */
  print?: boolean;
  /** Write the file but do not load it. */
  noLoad?: boolean;
  uid?: number;
  run?: (cmd: string, args: string[]) => void;
  env?: NodeJS.ProcessEnv;
}

function specFrom(o: AutostartOptions): AutostartSpec {
  const defaultDir = join(o.userHome ?? homedir(), '.storyos-runner');
  return {
    nodePath: o.nodePath ?? process.execPath,
    scriptPath: o.scriptPath ?? process.argv[1] ?? '',
    path: o.path ?? o.env?.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    home: o.home,
    homeIsCustom: o.home.dir !== defaultDir,
    logFile: o.home.logFile,
  };
}

const run = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { stdio: 'pipe' });
};

/** A script path inside npx's cache disappears with the cache; autostart from there would break silently at the next login. */
export function looksLikeNpxCache(scriptPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(scriptPath);
}

export function installAutostart(o: AutostartOptions): number {
  const platform = o.platform ?? process.platform;
  const spec = specFrom(o);
  if (platform !== 'darwin' && platform !== 'linux') {
    o.io.err('Autostart is available on macOS and Linux. On this system, start the Runner yourself with npx @storyos/runner.');
    return 1;
  }
  const content = platform === 'darwin' ? launchdPlist(spec) : systemdUnit(spec);
  if (o.print) {
    o.io.out(content.trimEnd());
    return 0;
  }
  if (looksLikeNpxCache(spec.scriptPath)) {
    o.io.err('This copy of the Runner is running from npx\'s temporary cache, which is cleaned up, so it would disappear at the next login.');
    o.io.err('Install it once with `npm install -g @storyos/runner`, then run `storyos-runner install-autostart` from that install.');
    return 1;
  }
  const target = platform === 'darwin' ? launchdPath(o.userHome) : systemdPath(o.userHome);
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(spec.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { mode: 0o644 });
  o.io.out(`Wrote ${target}`);
  if (o.noLoad) {
    o.io.out('Not loaded (--no-load). It starts at your next login.');
    return 0;
  }
  const exec = o.run ?? run;
  try {
    if (platform === 'darwin') {
      const domain = `gui/${o.uid ?? process.getuid?.() ?? 501}`;
      try {
        exec('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
      } catch {
        // not loaded yet: fine
      }
      exec('launchctl', ['bootstrap', domain, target]);
      o.io.out('Loaded. The Runner starts at every login and again after a crash.');
    } else {
      exec('systemctl', ['--user', 'daemon-reload']);
      exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
      o.io.out('Enabled. To keep it running after you log out, an admin can run: loginctl enable-linger $USER');
    }
  } catch {
    o.io.err('The file is written but could not be loaded here. It starts at your next login' + (platform === 'darwin' ? ', or run: launchctl bootstrap gui/$(id -u) ' + target : `, or run: systemctl --user enable --now ${SYSTEMD_UNIT}`));
    return 1;
  }
  return 0;
}

export function uninstallAutostart(o: AutostartOptions): number {
  const platform = o.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    o.io.err('Autostart is available on macOS and Linux.');
    return 1;
  }
  const target = platform === 'darwin' ? launchdPath(o.userHome) : systemdPath(o.userHome);
  const exec = o.run ?? run;
  if (!o.noLoad) {
    try {
      if (platform === 'darwin') exec('launchctl', ['bootout', `gui/${o.uid ?? process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
      else exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
    } catch {
      // it was not loaded: still remove the file
    }
  }
  if (existsSync(target)) {
    rmSync(target, { force: true });
    o.io.out(`Removed ${target}`);
  } else {
    o.io.out('Autostart was not installed.');
  }
  return 0;
}
