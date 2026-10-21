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
    // 命令末尾推导退出码。
    //
    // 2026-10-21 修复（真机验收发现）：原实现只看 $LASTEXITCODE ——
    //   `... ; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
    // 但对「纯 PowerShell cmdlet 的非终止错误」（如 Get-ChildItem 路径不存在），
    // $LASTEXITCODE 不会被设置；更糟的是 preamble 里的 chcp.com 是原生命令，
    // 它早已把 $LASTEXITCODE 置为 0，于是 `$null -ne $LASTEXITCODE` 成立 → exit 0。
    // 结果：任何失败的纯 cmdlet 都报 exitCode=0 / ok=true，agent 对这类失败完全失明。
    //
    // 新逻辑（先取 $?，再按「非零 $LASTEXITCODE 优先」判定）：
    //   1. $dppOk = $?        —— 紧跟用户命令取，反映它整体是否成功
    //   2. 非零 $LASTEXITCODE  —— 原生命令失败时保留具体退出码（如 exit 3 → 3）
    //   3. 否则 -not $dppOk   —— 纯 cmdlet 失败统一退 1
    // 关键：判断的是 `-ne 0` 而不是原来的 `$null -ne`。preamble 里的 chcp.com 会把
    // $LASTEXITCODE 置为 0，旧代码因此被 0 短路掉，永远看不到真实失败。
    // preamble 已把 PSNativeCommandUseErrorActionPreference 设为 $false，
    // 因此「原生命令写 stderr 但退出 0」不会被误判为失败，保留原修复意图。
    const fullCommand = `${WINDOWS_POWERSHELL_UTF8_PREAMBLE}; ${fixedCommand}; $dppOk = $?; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } elseif (-not $dppOk) { exit 1 }`;
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
