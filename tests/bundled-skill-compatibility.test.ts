import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_SKILL_REGISTRATIONS,
  loadBundledSkills,
} from '../core/skill/bundled-loader';
import packagePolicy from '../scripts/bundled-skill-package-policy.json';
import {
  fetchBundledSkillAsset,
  getBundledSkillAssetUrl,
} from './helpers/bundled-skill-assets';

// unstubGlobals:true (vitest.config) revokes module-level/beforeAll stubs before
// each test, so re-stub in beforeEach. The officecli skill module is loaded
// dynamically inside loadBundledSkills and reads chrome.runtime.getURL through
// bundled-assets; fetch is the local asset reader, chrome.runtime.getURL maps to
// the local extension-origin URL builder.
beforeEach(() => {
  vi.stubGlobal('fetch', fetchBundledSkillAsset);
  vi.stubGlobal('chrome', { runtime: { getURL: getBundledSkillAssetUrl } });
});

describe('bundled Skill compatibility', () => {
  it('materializes every official Skill at its pre-lazy-load byte identity', async () => {
    const skills = await loadBundledSkills(
      BUNDLED_SKILL_REGISTRATIONS.map(({ name }) => name),
    );
    const hashes = Object.fromEntries(skills.map((skill) => [
      skill.name,
      createHash('sha256').update(JSON.stringify(skill)).digest('hex'),
    ]));
    const defaultEnabled = Object.fromEntries(skills.map((skill) => [
      skill.name,
      skill.enabled !== false,
    ]));
    const registeredDefaults = Object.fromEntries(BUNDLED_SKILL_REGISTRATIONS.map((skill) => [
      skill.name,
      skill.enabled,
    ]));

    expect(hashes).toEqual(packagePolicy.skillSha256);
    expect(defaultEnabled).toEqual(registeredDefaults);
  });
});
