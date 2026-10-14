import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform, release as osRelease } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_SHELL, WINDOWS_POWERSHELL_UTF8_PREAMBLE } from './contracts.mjs';

const execFileAsync = promisify(execFile);

export const PATH_SEPARATOR = platform() === 'win32' ? ';' : ':';
export const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');

const SHELL_ENV_BASE_KEYS = platform() === 'win32'
  ? ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
     'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA',
     'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PUBLIC', 'USERNAME', 'USERDOMAIN',
     'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
  : ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
     'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'];

const BLOCKED_CHILD_ENV_KEYS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
]);

export function initializeHostEnvironment(packageRoot, logLine) {
  const nodeBinDir = dirname(process.execPath);
  const localBinDirs = [
    resolve(packageRoot, 'node_modules', '.bin'),
    resolve(packageRoot, '..', '..', 'node_modules', '.bin'),
  ].filter(existsSync);
  const currentPath = getEnvironmentPath(process.env) || (platform() === 'win32' ? '' : '/usr/bin:/bin');
  const userBinDirs = platform() === 'win32'
    ? [resolve(localAppData, 'OfficeCLI')]
    : [
        resolve(homedir(), '.local', 'bin'),
        resolve(homedir(), '.pyenv', 'shims'),
        resolve(homedir(), 'miniconda3', 'bin'),
        resolve(homedir(), 'anaconda3', 'bin'),
        resolve(homedir(), 'miniforge3', 'bin'),
        resolve(homedir(), 'mambaforge', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ];
  const managedPathDirs = new Set([nodeBinDir, ...localBinDirs, ...userBinDirs]);
  const existingPathDirs = splitPath(currentPath).filter(directory => !managedPathDirs.has(directory));
  const buildHostPath = (windowsPathDirs) => dedupePathDirs([
    nodeBinDir,
    ...userBinDirs,
    ...windowsPathDirs,
    ...existingPathDirs,
    ...localBinDirs,
  ]).join(PATH_SEPARATOR);
  const initialPath = buildHostPath([]);
  setEnvironmentPath(process.env, initialPath);
  if (platform() !== 'win32') return initialPath;

  return readWindowsUserMachinePathDirs(logLine).then((windowsPathDirs) => {
    const hostPath = buildHostPath(windowsPathDirs);
    setEnvironmentPath(process.env, hostPath);
    return hostPath;
  });
}

export function createChildEnv(extraEnv) {
  const explicitPath = getExplicitPathOverride(extraEnv);
  const env = {};
  for (const key of SHELL_ENV_BASE_KEYS) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value !== 'string') continue;
      if (BLOCKED_CHILD_ENV_KEYS.has(key.toUpperCase())) continue;
      env[key] = value;
    }
  }
  const pathValue = explicitPath !== null ? explicitPath : (getEnvironmentPath(env) || getEnvironmentPath(process.env));
  setEnvironmentPath(env, pathValue);
  if (platform() === 'win32') {
    env.PYTHONUTF8 ??= '1';
    env.PYTHONIOENCODING ??= 'utf-8';
  }
  return env;
}

export function createPythonChildEnv() {
  const env = {};
  const keys = platform() === 'win32'
    ? ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']
    : ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE'];

  for (const key of keys) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }

  setEnvironmentPath(env, getEnvironmentPath(process.env));
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONNOUSERSITE = '1';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  return env;
}

// S2-4/S2-5 fix: detect shell kind from binary name, not platform
export function detectShellKind(shell) {
  if (!shell) return platform() === 'win32' ? 'powershell' : 'posix';
  const lower = shell.toLowerCase();
  if (lower.includes('powershell') || lower.includes('pwsh')) return 'powershell';
  if (lower.includes('wsl')) return 'wsl';
  if (lower.includes('cmd.exe') || lower === 'cmd') return 'cmd';
  return 'posix';
}

export function createShellInvocation(command, shell) {
  const shellKind = detectShellKind(shell);
  const shellBin = shell || DEFAULT_SHELL;

  if (shellKind === 'powershell') {
    // 模型经常把命令中的换行双重转义为字面 \n（反斜杠+n），导致
    // PowerShell here-string（@'...'@）等多行写法失败。
    // 在此将字面 \n 还原为真实换行。
    const fixedCommand = command.replace(/\\n/g, '\n');
    // 命令末尾用 $LASTEXITCODE 作为退出码，避免 PowerShell 7 的 NativeCommandError
    // （原生命令写 stderr + 管道时）导致进程 exit code 误报为 1。
    // 对纯 PowerShell cmdlet（$LASTEXITCODE 为 null），exit $null 等价于 exit 0。
    // 改用 -EncodedCommand 传递，避免 PowerShell 重新解析命令串中的嵌套引号/管道字符。
    const fullCommand = `${WINDOWS_POWERSHELL_UTF8_PREAMBLE}; ${fixedCommand}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
    const encodedCommand = Buffer.from(fullCommand, 'utf16le').toString('base64');
    return {
      shellBin,
      shellArgs: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodedCommand,
      ],
    };
  }
  if (shellKind === 'wsl') {
    // WSL: launch bash inside WSL to run the command
    return { shellBin, shellArgs: ['-e', 'bash', '-c', command] };
  }
  if (shellKind === 'cmd') {
    return { shellBin, shellArgs: ['/c', command] };
  }
  // POSIX shell (bash, zsh, sh, etc.)
  return { shellBin, shellArgs: ['-c', command] };
}

export function splitPath(value) {
  return (value || '').split(PATH_SEPARATOR).map(entry => entry.trim()).filter(Boolean);
}

export function getEnvironmentPath(env) {
  const canonicalKey = platform() === 'win32' ? 'Path' : 'PATH';
  if (typeof env[canonicalKey] === 'string') return env[canonicalKey];
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path');
  return key ? env[key] || '' : '';
}

export function setEnvironmentPath(env, value) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env[platform() === 'win32' ? 'Path' : 'PATH'] = value;
}

export function getWindowsVersionLabel() {
  if (platform() !== 'win32') return null;
  const release = osRelease();
  const parts = release.split('.').map(part => Number.parseInt(part, 10));
  const build = parts[2] || 0;
  if (parts[0] === 10 && build >= 22000) return `Windows 11 (${release})`;
  if (parts[0] === 10) return `Windows 10 (${release})`;
  return `Windows (${release})`;
}

function getExplicitPathOverride(env) {
  if (!env || typeof env !== 'object') return null;
  let value = null;
  for (const [key, candidate] of Object.entries(env)) {
    if (key.toLowerCase() === 'path' && typeof candidate === 'string') value = candidate;
  }
  return value;
}

function dedupePathDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = platform() === 'win32' ? dir.replace(/[\\/]+$/, '').toLowerCase() : dir.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dir);
  }
  return result;
}

async function readWindowsUserMachinePathDirs(logLine) {
  if (platform() !== 'win32') return [];
  const command = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))",
    "$paths | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }",
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return splitPath(stdout.replace(/\r?\n/g, PATH_SEPARATOR));
  } catch (error) {
    logLine(`Could not read Windows User/Machine PATH: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
