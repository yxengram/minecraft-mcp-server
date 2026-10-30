// Release contract checks (BLUEPRINT F-050). They only read files in the repository: no build, no network.
// Each case names its E row; the expected values come from the contract, so nothing here repeats a version
// number that a dependency update would have to edit by hand.
import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAME, PACKAGE_NAME, PACKAGE_VERSION } from '../src/package-info.js';
import { TOOL_NAMES } from '../src/tool-annotations.js';

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  homepage?: string;
  bugs?: string | { url?: string };
  repository?: string | { type?: string; url?: string };
  license?: string;
  author?: string | { name?: string };
  bin?: string | Record<string, string>;
  files?: string[];
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
}

interface PackageLock {
  name?: string;
  version?: string;
  packages: Record<string, { name?: string; version?: string; bin?: Record<string, string> } | undefined>;
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

// ---------------------------------------------------------------------------------------------------------------
// F-049 (created by E-023): src/package-info.ts is the package's only source of its name and version, which the
// command line (scriptName, --version and the error line) shows. The command name is the name without "@scope/".
// ---------------------------------------------------------------------------------------------------------------

test('F-049: PACKAGE_NAME, PACKAGE_VERSION and COMMAND_NAME follow package.json', (t) => {
  const { name = '', version = '' } = readJson<PackageJson>('package.json');
  t.truthy(name, 'package.json has no name');
  t.truthy(version, 'package.json has no version');
  t.is(PACKAGE_NAME, name);
  t.is(PACKAGE_VERSION, version);
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  t.is(COMMAND_NAME, unscoped);
  t.false(COMMAND_NAME.includes('/'), `COMMAND_NAME "${COMMAND_NAME}" still has a scope`);
});

// ---------------------------------------------------------------------------------------------------------------
// E-024: release identity and package contents. The files list keeps src/, tests/, docs/ and the rest of the
// repository out of the package; npm-shrinkwrap.json is listed for E-025 although only CI and the release create
// it. npm provenance needs repository.url to equal the GitHub repository, and the reply to a failed connection
// links to this repository, not the upstream one.
// ---------------------------------------------------------------------------------------------------------------

const REPOSITORY_URL = 'git+https://github.com/yxengram/minecraft-mcp-server.git';
const UPSTREAM_REPOSITORY = 'yuniko-software/minecraft-mcp-server';

test('E-024: bin has one command, COMMAND_NAME, which runs dist/main.js', (t) => {
  const { bin } = readJson<PackageJson>('package.json');
  t.is(typeof bin, 'object', 'bin must name the command, not only give its file');
  t.deepEqual(bin, { [COMMAND_NAME]: 'dist/main.js' });
});

test('E-024: files is exactly dist, CHANGELOG.md and npm-shrinkwrap.json', (t) => {
  const { files } = readJson<PackageJson>('package.json');
  t.true(Array.isArray(files), 'package.json has no files list, so npm would pack the whole repository');
  t.deepEqual([...(files ?? [])].sort(), ['dist', 'CHANGELOG.md', 'npm-shrinkwrap.json'].sort());
});

test('E-024: license, repository, homepage, bugs, author and engines are filled in', (t) => {
  const pkg = readJson<PackageJson>('package.json');
  t.is(pkg.license, 'Apache-2.0');
  t.is(typeof pkg.repository === 'object' ? pkg.repository.url : undefined, REPOSITORY_URL, 'repository.url');
  t.truthy(pkg.homepage, 'homepage is missing');
  t.truthy(typeof pkg.bugs === 'object' ? pkg.bugs.url : pkg.bugs, 'bugs is missing');
  t.is(typeof pkg.author === 'object' ? pkg.author.name : pkg.author, 'yxengram');
  t.truthy(pkg.description, 'description is missing');
  t.true(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, 'keywords are missing');
  t.is(pkg.engines?.node, '>=22');
});

test('E-024: the build emits no .d.ts files and starts from an empty dist/', (t) => {
  const { compilerOptions } = readJson<{ compilerOptions?: { declaration?: boolean } }>('tsconfig.build.json');
  t.is(compilerOptions?.declaration, false, 'tsconfig.build.json must set declaration to false');
  // node alone, so it also runs on Windows; without it, files of deleted modules (M9's reflexes) stay in the package.
  const { scripts } = readJson<PackageJson>('package.json');
  t.is(scripts?.prebuild, `node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"`);
});

test('E-024: CHANGELOG.md has an Unreleased section or one for the current version', (t) => {
  const { version = '' } = readJson<PackageJson>('package.json');
  t.truthy(version, 'package.json has no version');
  const file = new URL('../CHANGELOG.md', import.meta.url);
  t.true(fs.existsSync(file), 'CHANGELOG.md is missing');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  t.regex(text, new RegExp(`^## \\[(Unreleased|${escaped})\\]`, 'm'));
});

test('E-024: no file in src/ names the upstream repository', (t) => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(name => fs.statSync(path.join(root, name)).isFile());
  t.true(files.length > 0, 'src/ has no files');
  const naming = files.filter(name => fs.readFileSync(path.join(root, name), 'utf8').includes(UPSTREAM_REPOSITORY));
  t.deepEqual(naming, [], `these files still contain ${UPSTREAM_REPOSITORY}`);
});

// ---------------------------------------------------------------------------------------------------------------
// E-044: F-055's TOOL_NAMES is the only source of the tool list, so the number of tools is written in no test: the
// heading of the tool list in both READMEs must say TOOL_NAMES.length, and so must the "23 → N" line that E-040 keeps
// with it. A tool added to the table without the READMEs, or the other way round, fails here.
// ---------------------------------------------------------------------------------------------------------------

const README_COUNTS = [
  { file: 'README.md', heading: /^## Tools \((\d+)\)$/m, growth: /\(23 → (\d+) tools\)$/m },
  { file: 'README.zh-CN.md', heading: /^## 工具（(\d+) 个）$/m, growth: /（23 → (\d+) 个工具）$/m }
];

for (const { file, heading, growth } of README_COUNTS) {
  test(`E-044: the tool list heading and the "23 → N" line of ${file} say TOOL_NAMES.length`, (t) => {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const listed = text.match(heading)?.[1];
    t.truthy(listed, `${file} has no heading ${heading}`);
    t.is(Number(listed), TOOL_NAMES.length, `the heading of the tool list in ${file}`);
    const grown = text.match(growth)?.[1];
    t.truthy(grown, `${file} has no line ${growth}`);
    t.is(Number(grown), TOOL_NAMES.length, `the "23 → N" line in ${file}`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// E-046 (Q16): the npm package is @yxengram/minecraft-mcp-autopilot and its one command minecraft-mcp-autopilot. The
// upstream package and command are both minecraft-mcp-server (the name on npm belongs to upstream), so neither may be
// that, or a global install of one would overwrite the other. A scoped package is private by default, hence
// publishConfig. The READMEs pin the version in every npx example and in the prose about it (Q17), so npx does not
// fetch a new release on each start, and they never show a value shaped like a key.
// ---------------------------------------------------------------------------------------------------------------

const APPROVED_PACKAGE = '@yxengram/minecraft-mcp-autopilot';
const APPROVED_COMMAND = 'minecraft-mcp-autopilot';
const UPSTREAM_NAME = 'minecraft-mcp-server';

test('E-046: the package name has a scope and is the approved one, not upstream\'s', (t) => {
  const { name = '' } = readJson<PackageJson>('package.json');
  t.regex(name, /^@[^/@]+\/[^/@]+$/, `package.json name "${name}" has no scope`);
  t.not(name, UPSTREAM_NAME);
  t.not(COMMAND_NAME, UPSTREAM_NAME, 'the command would overwrite upstream\'s on a global install');
  t.is(name, APPROVED_PACKAGE);
  t.is(COMMAND_NAME, APPROVED_COMMAND);
});

test('E-046: bin has exactly one command, minecraft-mcp-autopilot, which runs dist/main.js', (t) => {
  const { bin } = readJson<PackageJson>('package.json');
  t.is(typeof bin, 'object', 'bin must name the command, not only give its file');
  const entries = Object.entries(typeof bin === 'object' ? bin : {});
  t.is(entries.length, 1, 'npx -y <package> runs the bin only when there is exactly one');
  t.deepEqual(entries, [[APPROVED_COMMAND, 'dist/main.js']]);
});

test('E-046: publishConfig.access is public', (t) => {
  t.is(readJson<PackageJson>('package.json').publishConfig?.access, 'public', 'a scoped package is published private by default');
});

// npm install writes the root of the lockfile from package.json; the rename edits it the same way by hand.
test('E-046: the root of package-lock.json follows the name, version and bin of package.json', (t) => {
  const pkg = readJson<PackageJson>('package.json');
  const lock = readJson<PackageLock>('package-lock.json');
  const root = lock.packages[''];
  t.is(lock.name, pkg.name);
  t.is(lock.version, pkg.version);
  t.is(root?.name, pkg.name);
  t.is(root?.version, pkg.version);
  t.deepEqual(root?.bin, pkg.bin);
});

// Every npx example counts, whatever it names, so a stale name or version cannot pass by not matching: npx in fenced
// blocks and inline code, with or without -y or --yes (prose such as "npx downloads the package" is not code), and the
// args of the client config ("-y", "<spec>"). Each code segment is searched on its own, so a bare `npx` span takes
// nothing from the text after it.
const CODE = /```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g;
const NPX_COMMAND = /\bnpx(?:\s+(?:-y|--yes))?\s+([^\s`"-][^\s`"]*)/g;
const NPX_ARGS = /"-y",\s*"([^"]+)"/g;
// The prose names the pinned version too ("prints `3.0.0`", "`@3.0.0`"); a code span that is only a version must be it.
const VERSION_LITERAL = /`@?(\d+\.\d+\.\d+)`/g;

for (const file of ['README.md', 'README.zh-CN.md']) {
  test(`E-046: every npx example in ${file} names the package and version of package.json`, (t) => {
    const { name = '', version = '' } = readJson<PackageJson>('package.json');
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const spec = `${name}@${version}`;
    const commands = [...text.matchAll(CODE)]
      .map(match => match[1] ?? match[2])
      .flatMap(code => [...code.matchAll(NPX_COMMAND)].map(match => match[1]));
    const args = [...text.matchAll(NPX_ARGS)].map(match => match[1]);
    t.true(commands.length > 0, `${file} has no npx command`);
    t.true(args.length > 0, `${file} has no client config with "-y", "<package>@<version>" in args`);
    t.deepEqual(commands.filter(found => found !== spec), [], `npx commands in ${file} that are not ${spec}`);
    t.deepEqual(args.filter(found => found !== spec), [], `npx args in ${file} that are not ${spec}`);
    const literals = [...text.matchAll(VERSION_LITERAL)].map(match => match[1]);
    t.deepEqual(literals.filter(found => found !== version), [], `version literals in ${file} that are not ${version}`);
    // The first run downloads the package with --version; --check (E-042) then tries the connection.
    t.true(text.includes(`npx -y ${spec} --version`), `${file} has no npx -y ${spec} --version`);
    t.true(text.includes(`npx -y ${spec} --check`), `${file} has no npx -y ${spec} --check`);
    t.regex(text, /"command": "npx"/, `${file} has no client config whose command is npx`);
  });

  test(`E-046: ${file} has no value shaped like an OpenRouter key`, (t) => {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    t.false(text.includes('sk-or-'), `${file} contains "sk-or-"; write <your OpenRouter key> instead`);
  });
}
