/**
 * The operating system's own folder dialog. A browser can't reveal a folder's
 * real path, but the factory runs on the user's machine, so the server opens
 * the dialog (Finder on macOS, the folder browser on Windows, zenity or
 * kdialog on Linux) and returns the path. Where none exists (headless, CI,
 * or FACTORY_NATIVE_DIALOGS=0), callers fall back to the in-app picker.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The chosen folder, null when the user cancels, or `unsupported` when there's no dialog here. */
export type FolderChoice = { path: string | null; supported: true } | { path: null; supported: false };
export type ChooseFolder = (start: string, title: string, signal: AbortSignal) => Promise<FolderChoice>;

/** AppleScript string literal. */
const appleString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** PowerShell single-quoted literal. */
const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    try {
      return fs.statSync(path.join(dir, command)).isFile();
    } catch {
      return false;
    }
  });
}

/** The program and arguments that show the dialog on this machine, or null. */
export function dialogCommand(start: string, title: string, platform: NodeJS.Platform = process.platform): [string, string[]] | null {
  if (platform === 'darwin') {
    // `activate` brings osascript's own dialog in front of the browser; it needs no Automation permission, unlike asking System Events.
    const where = start ? ` default location (POSIX file ${appleString(start)})` : '';
    return ['osascript', [
      '-e', 'activate',
      '-e', `set chosen to choose folder with prompt ${appleString(title)}${where}`,
      '-e', 'POSIX path of chosen',
    ]];
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = ${psString(title)}`,
      ...(start ? [`$d.SelectedPath = ${psString(start)}`] : []),
      "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
    ].join('; ');
    return ['powershell', ['-NoProfile', '-STA', '-Command', script]];
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  if (onPath('zenity')) return ['zenity', ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start.replace(/\/?$/, '/')}`] : [])]];
  if (onPath('kdialog')) return ['kdialog', ['--getexistingdirectory', start || os.homedir(), '--title', title]];
  return null;
}

let open: ChildProcess | null = null;

/** Shows the dialog; one at a time. Closing the request (signal) closes the dialog. */
export const chooseFolderNatively: ChooseFolder = (start, title, signal) => {
  const command = process.env.FACTORY_NATIVE_DIALOGS === '0' ? null : dialogCommand(start, title);
  if (!command) return Promise.resolve({ path: null, supported: false });
  if (open) return Promise.reject(new Error('A folder dialog is already open'));
  return new Promise((resolve, reject) => {
    const child = execFile(command[0], command[1], { timeout: 15 * 60_000 }, (err, stdout) => {
      open = null;
      signal.removeEventListener('abort', close);
      const chosen = stdout.trim().replace(/(.)\/$/, '$1');
      // Cancelling exits non-zero (osascript: -128) with nothing printed.
      if (chosen) return resolve({ path: chosen, supported: true });
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ path: null, supported: false });
      if (err && err.killed && !signal.aborted) return reject(new Error('The folder dialog timed out'));
      resolve({ path: null, supported: true });
    });
    const close = () => child.kill();
    signal.addEventListener('abort', close, { once: true });
    open = child;
  });
};
