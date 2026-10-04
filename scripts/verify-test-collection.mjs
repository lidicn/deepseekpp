#!/usr/bin/env node
// Collection-integrity gate (DCD decisions/20261004-DPP审计收口四件-裁定.md 件1).
//
// Vitest can drop a test file without failing the suite: the pool gives up starting a
// worker, the file appears in neither failed nor passed, and the summary still reads
// "N passed". A green run therefore proves nothing until the number of files that
// actually ran equals the number of files the config says should run.
//
// Three-way reconciliation, both sides measured live (no file names, no counts baked in):
//   1. filesystem  — every file matching vitest.config.ts `test.include`
//   2. reporter    — files present in the json reporter artifact of this very run
//   3. stderr      — `[vitest-pool]: Failed to start <pool> worker for test files ...`
// Any asymmetry between 1 and 2, or any hit in 3, is red and printed by name.
//
// Extra arguments after `--` go to `vitest run` only (diagnosis and negative controls,
// e.g. `-- --pool=threads`); they never widen or narrow the filesystem side.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const vitestArgs = separator === -1 ? [] : argv.slice(separator + 1);
const jsonOutIndex = argv.indexOf('--json-out');
const jsonOut = jsonOutIndex === -1
  ? join(tmpdir(), `dpp-collection-report-${process.pid}.json`)
  : resolve(argv[jsonOutIndex + 1]);
const ownedJsonOut = jsonOutIndex === -1;

const VITEST_DEFAULT_EXCLUDES = new Set(['node_modules', 'dist', '.output', '.wxt', '.git', 'coverage']);

const main = async () => {
  const includePatterns = await readIncludePatterns();
  const expected = collectExpectedFiles(includePatterns);
  const runResult = runVitest(jsonOut);
  const ran = readRanFiles(jsonOut);
  const workerFailures = collectWorkerFailures(`${runResult.stdout}\n${runResult.stderr}`);

  const expectedSet = new Set(expected);
  const ranSet = new Set(ran);
  const missing = expected.filter((file) => !ranSet.has(file));
  const unexpected = ran.filter((file) => !expectedSet.has(file));
  const unattributed = workerFailures.filter((file) => !expectedSet.has(file));
  const lingeringWorkers = collectLingeringWorkers();

  console.log('Vitest collection integrity');
  console.log(`  config include patterns : ${includePatterns.join(', ')}`);
  console.log(`  filesystem test files   : ${expected.length}`);
  console.log(`  files present in report : ${ran.length}`);
  console.log(`  vitest exit code        : ${runResult.status}`);
  console.log(`  json artifact           : ${jsonOut}`);
  console.log(`  worker start failures   : ${workerFailures.length}`);
  // Diagnostic only, never a red cause: a dropped worker can leave its fork alive, and the
  // PIDs are what a post-mortem needs. Win32 `tasklist` has no CommandLine, so CIM is queried.
  console.log(`  lingering vitest pids   : ${lingeringWorkers.length}${lingeringWorkers.length ? ` (${lingeringWorkers.join(', ')})` : ''}`);

  const problems = [];
  if (expected.length === 0) problems.push('filesystem side measured zero files; the gate cannot judge anything');
  if (ran.length === 0 && expected.length > 0) problems.push('reporter side is empty; the run produced no file results');
  if (missing.length > 0) {
    problems.push(`${missing.length} test file(s) matched the config but are absent from this run`);
    for (const file of missing) console.error(`    NOT RUN   ${file}`);
  }
  if (unexpected.length > 0) {
    problems.push(`${unexpected.length} file(s) ran without matching the config include`);
    for (const file of unexpected) console.error(`    NOT EXPECTED ${file}`);
  }
  if (workerFailures.length > 0) {
    problems.push(`${workerFailures.length} pool worker start failure(s) reported on stderr`);
    for (const file of workerFailures) console.error(`    WORKER FAILED ${file}`);
  }
  if (unattributed.length > 0) {
    problems.push(`${unattributed.length} worker failure name(s) do not match any config test file`);
  }

  if (problems.length > 0) {
    console.error('Test collection integrity failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    if (ownedJsonOut) console.error(`- reporter artifact kept for diagnosis: ${jsonOut}`);
    process.exit(1);
  }

  if (ownedJsonOut) rmQuiet(jsonOut);
  // Collection completeness is not test success: say so on the pass line, otherwise a red
  // suite reads as "passed" to anyone who only runs this gate.
  const resultNote = runResult.status === 0
    ? ''
    : `; vitest exited ${runResult.status}, so test results are NOT all green`;
  console.log(`Test collection integrity passed (${expected.length} files on disk, ${ran.length} in the report)${resultNote}`);
};

async function readIncludePatterns() {
  const configPath = join(srcRoot, 'vitest.config.ts');
  if (!existsSync(configPath)) throw new Error(`missing ${configPath}`);
  const module = await import(pathToFileURL(configPath).href);
  const include = module.default?.test?.include;
  if (!Array.isArray(include) || include.length === 0) {
    throw new Error('vitest.config.ts must declare a non-empty test.include array');
  }
  return include;
}

function collectExpectedFiles(patterns) {
  const matchers = patterns.map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (VITEST_DEFAULT_EXCLUDES.has(entry)) continue;
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else {
        const projectPath = toPosix(relative(srcRoot, absolute));
        if (matchers.some((matcher) => matcher.regexp.test(projectPath))) files.push(projectPath);
      }
    }
  };
  for (const pattern of patterns) {
    const base = pattern.split('**')[0].split('*')[0].replace(/\/$/, '');
    const directory = resolve(srcRoot, base || '.');
    if (existsSync(directory) && statSync(directory).isDirectory()) walk(directory);
  }
  return [...new Set(files)].sort();
}

function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function runVitest(outputFile) {
  const cli = join(srcRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(cli)) throw new Error(`vitest cli not found at ${cli}`);
  return spawnSync(process.execPath, [cli, 'run', '--reporter=json', `--outputFile=${toPosix(outputFile)}`, ...vitestArgs], {
    cwd: srcRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readRanFiles(outputFile) {
  if (!existsSync(outputFile)) {
    throw new Error(`vitest did not write ${outputFile}; the run cannot be judged (treated as not measured)`);
  }
  const report = JSON.parse(readFileSync(outputFile, 'utf8'));
  if (!Array.isArray(report.testResults)) {
    throw new Error(`${outputFile} has no testResults array; the reporter shape changed`);
  }
  const files = report.testResults.map((entry) => toProjectPath(entry.name));
  return [...new Set(files)].sort();
}

function collectWorkerFailures(output) {
  const files = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/Failed to start (?:forks|threads) worker for test files (.+)$/);
    if (!match) continue;
    for (const token of match[1].split(/[,\s]+/)) {
      const cleaned = toProjectPath(token.replace(/[.\s;]+$/, ''));
      if (cleaned.endsWith('.test.ts') || cleaned.endsWith('.test.tsx')) files.add(cleaned);
    }
  }
  return [...files].sort();
}

function collectLingeringWorkers() {
  const probe = process.platform === 'win32'
    ? spawnSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }',
      ], { encoding: 'utf8', timeout: 20_000 })
    : spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', timeout: 20_000 });
  if (probe.error || probe.status !== 0) return [];
  const pids = [];
  for (const line of String(probe.stdout ?? '').split(/\r?\n/)) {
    if (!line.toLowerCase().includes('vitest')) continue;
    // The gate's own command line can carry the word vitest (json artifact name, cli path).
    if (line.includes('verify-test-collection.mjs')) continue;
    const pid = (process.platform === 'win32' ? line.split('|')[0] : line.trim().split(/\s+/)[0]).trim();
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    pids.push(pid);
  }
  return [...new Set(pids)].sort((a, b) => Number(a) - Number(b));
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function toProjectPath(value) {
  const posix = String(value ?? '').replace(/\\/g, '/');
  const rootPosix = srcRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (posix.startsWith(`${rootPosix}/`)) return posix.slice(rootPosix.length + 1);
  if (posix === rootPosix) return '';
  return posix.replace(/^\.\//, '');
}

function rmQuiet(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort: the artifact lives in the OS temp dir
  }
}

function fail(error) {
  console.error('Test collection integrity failed:');
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

main().catch(fail);
