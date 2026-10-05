/**
 * Single-router guard for the runtime message surface (dead-code removal).
 *
 * `core/messaging.ts` (a file) once mapped every handler-promise rejection to
 * `sendResponse(null)`, swallowing failures. All real Background↔content
 * traffic goes through the structured `{ok:false, code}` envelope router
 * (`entrypoints/background/runtime-handler.ts` via
 * `defineBackgroundPayloadRuntimeCommandHandler`), and the file had zero
 * importers, so it was deleted. This test guards against reintroducing a
 * second, lossy message router next to the envelope layer:
 *
 *  1. `src/core/messaging.ts` (the FILE — not the `src/core/messaging/`
 *     directory, which is the envelope layer's own home) must not exist.
 *  2. No first-party source may import a module specifier that resolves to
 *     that file (`./messaging`, `../core/messaging`, `.../messaging` with no
 *     trailing segment).
 *  3. The lossy helpers (`sendToBackground`, `sendToContentScript`) must stay
 *     unreferenced outside the envelope directory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..');

function firstPartySourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.output' || entry === 'tests') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...firstPartySourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('runtime message single router', () => {
  it('has no core/messaging.ts file beside the core/messaging/ envelope directory', () => {
    expect(existsSync(join(SRC_ROOT, 'core', 'messaging.ts'))).toBe(false);
    // The envelope directory remains the single home of message routing.
    expect(statSync(join(SRC_ROOT, 'core', 'messaging'))).toBeDefined();
  });

  it('keeps every first-party source free of imports of the deleted messaging file', () => {
    // Matches specifiers that end exactly at `messaging` (the file), never
    // `messaging/...` (the envelope directory modules).
    const messagingFileImport = /['"][^'"]*\/messaging['"]/;
    const importers = firstPartySourceFiles(SRC_ROOT).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return messagingFileImport.test(source);
    });
    expect(importers).toEqual([]);
  });

  it('keeps the lossy sendToBackground/sendToContentScript helpers unreferenced', () => {
    const users = firstPartySourceFiles(SRC_ROOT).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /sendToBackground|sendToContentScript/.test(source);
    });
    expect(users).toEqual([]);
  });
});
