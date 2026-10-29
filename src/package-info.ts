import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The package's identity has this one source (BLUEPRINT F-049). From dist/package-info.js and from src/package-info.ts
// (tsx, ava) alike, ../package.json is the package root's. It is read with node:fs, not imported: under NodeNext a JSON
// import from the root would move the build's root directory to the repository root, and dist/main.js would not exist.
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

function readPackage(): { name: string; version: string } {
  const fail = (reason: string) => new Error(`Cannot read package.json at ${fileURLToPath(PACKAGE_JSON_URL)}: ${reason}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  const fields = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  for (const field of ['name', 'version']) {
    if (typeof fields[field] !== 'string' || fields[field] === '') throw fail(`no "${field}" string`);
  }
  return { name: fields.name as string, version: fields.version as string };
}

const pkg = readPackage();

export const PACKAGE_NAME = pkg.name;
export const PACKAGE_VERSION = pkg.version;
/** The package name without its "@scope/", which is also the command (bin) name. */
export const COMMAND_NAME = PACKAGE_NAME.replace(/^@[^/]+\//, '');
