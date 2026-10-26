// Release contract checks (BLUEPRINT F-050). They only read files in the repository: no build, no network.
// Each case names its E row; the expected values come from the contract, so nothing here repeats a version
// number that a dependency update would have to edit by hand.
import test from 'ava';
import fs from 'node:fs';

interface PackageJson {
  dependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, { version?: string } | undefined>;
}

/** Read with node:fs (tsconfig does not enable JSON imports), so each test sees the file as it is on disk. */
function readJson<T>(relative: string): T {
  return JSON.parse(fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')) as T;
}

// ---------------------------------------------------------------------------------------------------------------
// E-025: the mineflayer stack is pinned. The code uses bot._client packets, mineflayer-pathfinder internals and
// fixes to minecraft-data's tables, so a range in package.json would let a fresh install pick a release that was
// never tested in game. Comparing with the lockfile (not a literal) keeps the test valid after a mineflayer-stack
// update, and fails if that update turns a pin back into a range.
// ---------------------------------------------------------------------------------------------------------------

const PINNED = ['mineflayer', 'minecraft-data', 'mineflayer-pathfinder'] as const;

for (const name of PINNED) {
  test(`E-025: ${name} is an exact version equal to package-lock.json`, (t) => {
    const declared = readJson<PackageJson>('package.json').dependencies?.[name];
    const locked = readJson<PackageLock>('package-lock.json').packages[`node_modules/${name}`]?.version;
    t.truthy(declared, `${name} is missing from dependencies in package.json`);
    t.false(/[\^~]/.test(declared ?? ''), `${name} is "${declared}" in package.json; it must not contain ^ or ~`);
    t.truthy(locked, `node_modules/${name} is missing from package-lock.json`);
    t.is(declared, locked, `${name} in package.json differs from node_modules/${name} in package-lock.json`);
  });
}
