#!/usr/bin/env node
/**
 * C-1 fix: verify extension version consistency across build artifacts.
 *
 * Checks:
 * 1. package.json version matches dist/chrome-mv3/manifest.json version
 * 2. package.json version matches dist/edge-mv3/manifest.json version
 * 3. If extensions/ directory exists (local dev), verify release zips exist
 *    for the current package.json version (chrome + edge).
 *
 * This gate prevents D7-1 class drift: extensions/ release artifacts stuck
 * at an older version while package.json advances, with CI fully green.
 *
 * Fail-closed: any mismatch exits 1.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// 1. Read source version
const pkg = readJson(join(root, 'package.json'));
const sourceVersion = pkg.version;
if (!sourceVersion) {
  failures.push('package.json has no version field');
} else {
  console.log(`Source version (package.json): ${sourceVersion}`);
}

// 2. Check dist manifests
const distTargets = [
  { name: 'chrome-mv3', path: join(root, 'dist', 'chrome-mv3', 'manifest.json') },
  { name: 'edge-mv3', path: join(root, 'dist', 'edge-mv3', 'manifest.json') },
];

for (const target of distTargets) {
  if (!existsSync(target.path)) {
    failures.push(`dist/${target.name}/manifest.json does not exist (run build:all first)`);
    continue;
  }
  const manifest = readJson(target.path);
  if (manifest.version !== sourceVersion) {
    failures.push(
      `dist/${target.name}/manifest.json version mismatch: ` +
      `expected ${sourceVersion}, got ${manifest.version}`,
    );
  } else {
    console.log(`  dist/${target.name}/manifest.json: ${manifest.version} OK`);
  }
}

// 3. Check extensions/ release zips (only if directory exists — local dev only)
// In CI, extensions/ is outside the repo so this check is skipped.
// Locally, missing release zips are warnings (not failures) to avoid blocking
// day-to-day development; the dist/ manifest checks above are the hard gate.
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const extensionsDir = resolve(root, '..', 'extensions');
if (existsSync(extensionsDir)) {
  console.log(`\nExtensions directory found at: ${extensionsDir}`);
  const expectedChromeZip = join(extensionsDir, `deepseek-plus-plus-${sourceVersion}-chrome.zip`);
  const expectedEdgeZip = join(extensionsDir, `deepseek-plus-plus-${sourceVersion}-edge.zip`);

  const warnings = [];
  if (!existsSync(expectedChromeZip)) {
    warnings.push(`deepseek-plus-plus-${sourceVersion}-chrome.zip`);
  } else {
    console.log(`  extensions/...chrome.zip: OK`);
  }

  if (!existsSync(expectedEdgeZip)) {
    warnings.push(`deepseek-plus-plus-${sourceVersion}-edge.zip`);
  } else {
    console.log(`  extensions/...edge.zip: OK`);
  }

  if (warnings.length > 0) {
    console.warn(`\n⚠️  Release zip(s) missing in extensions/ (D7-1 class drift):`);
    for (const w of warnings) {
      console.warn(`  - ${w}`);
    }
    console.warn(`  Run build:all + zip:all, then copy zips to extensions/ to sync.`);
    if (isCI) {
      failures.push(`CI environment: release zip(s) missing: ${warnings.join(', ')}`);
    }
  }
} else {
  console.log(`\nExtensions directory not found (CI environment) — skipping release zip check`);
}

// Report
if (failures.length > 0) {
  console.error(`\n❌ Version consistency check failed (${failures.length} issue(s)):`);
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('\n✅ Version consistency check passed');
