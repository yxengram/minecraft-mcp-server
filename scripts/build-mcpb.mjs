// Builds the MCPB extension for Claude Desktop (F-058, E-047).
//
//   npm run build
//   npm run build:mcpb                                   # writes build/<name>-<version>.mcpb
//
// It assembles build/mcpb/ from dist/**/*.js, package.json, the lockfile, LICENSE, README.md and mcpb/manifest.json
// (F-057), installs the production dependencies there from the lockfile with npm ci, so the extension gets the tree CI
// tested (E-025), leaves out the Bedrock data of minecraft-data, and packs it with the mcpb of the dev dependencies.
// It writes only under build/ and changes no other file of the repository. The dependencies have no install scripts
// and no native modules, so one package serves Windows, macOS and Linux. Any failed step exits with 1 and names it.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(REPO, 'dist');
const BUILD = path.join(REPO, 'build');
const STAGE = path.join(BUILD, 'mcpb');
const MANIFEST = path.join(REPO, 'mcpb', 'manifest.json');
// Run with node itself rather than node_modules/.bin/mcpb, which is a .cmd file on Windows.
const MCPB_CLI = path.join(REPO, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
// CI and the release run npm shrinkwrap first, which renames package-lock.json (npm 11.19.1, 2026-10-26).
const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'];
// minecraft-data's index.js reads bedrock/common/protocolVersions.json (and versions.json, legacy.json) when it loads;
// the rest of bedrock/ is never read for Java Edition. No pc/ version is removed: the dataPaths of 26.1.2 still point
// into pc/1.20, 1.20.2, 1.20.3, 1.16.1 and latest.
const BEDROCK = path.join(STAGE, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'bedrock');
const BEDROCK_KEEP = 'common';

class StepError extends Error {}

function fail(message) {
  throw new StepError(message);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${path.relative(REPO, file)}: ${error.message}`);
  }
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sizeOf(target) {
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0);
}

// stdio inherited, so npm's and mcpb's own output shows what went wrong.
function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited with ${result.status ?? result.signal}`);
}

function mcpb(args) {
  run(`mcpb ${args[0]}`, process.execPath, [MCPB_CLI, ...args], { cwd: REPO });
}

const steps = [
  ['check dist/main.js and the versions', () => {
    if (!existsSync(path.join(DIST, 'main.js'))) fail('dist/main.js does not exist; run npm run build first');
    const { version: packageVersion } = readJson(path.join(REPO, 'package.json'));
    const { version: manifestVersion } = readJson(MANIFEST);
    if (manifestVersion !== packageVersion) {
      fail(`mcpb/manifest.json has version ${JSON.stringify(manifestVersion)} but package.json has ${JSON.stringify(packageVersion)}`);
    }
    if (!existsSync(MCPB_CLI)) fail(`${path.relative(REPO, MCPB_CLI)} does not exist; run npm ci first`);
  }],

  ['assemble build/mcpb/', () => {
    const lockfile = LOCKFILES.find(name => existsSync(path.join(REPO, name)));
    if (!lockfile) fail(`neither ${LOCKFILES.join(' nor ')} exists`);
    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });

    const built = readdirSync(DIST, { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.js') && statSync(path.join(DIST, name)).isFile());
    for (const name of built) {
      const target = path.join(STAGE, 'dist', name);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(DIST, name), target);
    }
    for (const name of ['package.json', lockfile, 'LICENSE', 'README.md']) {
      copyFileSync(path.join(REPO, name), path.join(STAGE, name));
    }
    copyFileSync(MANIFEST, path.join(STAGE, 'manifest.json'));
    console.log(`build-mcpb: ${built.length} files of dist/, package.json, ${lockfile}, LICENSE, README.md and manifest.json`);
  }],

  // --ignore-scripts: prepare would run tsc, which is not among the production dependencies.
  ['npm ci --omit=dev --ignore-scripts', () => {
    // npm is npm.cmd on Windows, which only a shell can start.
    run('npm ci', 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: STAGE, shell: process.platform === 'win32' });
  }],

  ['leave out the Bedrock data of minecraft-data', () => {
    if (!existsSync(path.join(BEDROCK, BEDROCK_KEEP, 'protocolVersions.json'))) {
      fail(`${path.relative(STAGE, path.join(BEDROCK, BEDROCK_KEEP, 'protocolVersions.json'))} does not exist; the layout of minecraft-data has changed`);
    }
    const removed = readdirSync(BEDROCK).filter(name => name !== BEDROCK_KEEP);
    let bytes = 0;
    for (const name of removed) {
      const target = path.join(BEDROCK, name);
      bytes += sizeOf(target);
      rmSync(target, { recursive: true, force: true });
    }
    console.log(`build-mcpb: removed ${removed.length} entries (${megabytes(bytes)}) from minecraft-data/data/bedrock, kept ${BEDROCK_KEEP}/`);
  }],

  ['mcpb validate and mcpb pack', () => {
    const { name, version } = readJson(path.join(STAGE, 'manifest.json'));
    const output = path.join(BUILD, `${name}-${version}.mcpb`);
    mcpb(['validate', path.join(STAGE, 'manifest.json')]);
    mcpb(['pack', STAGE, output]);
    if (!existsSync(output)) fail(`mcpb pack wrote no ${path.relative(REPO, output)}`);
    console.log(`build-mcpb: ${path.relative(REPO, output)} is ${megabytes(statSync(output).size)} (${statSync(output).size} bytes)`);
  }]
];

for (const [index, [name, action]] of steps.entries()) {
  console.log(`build-mcpb: step ${index + 1} of ${steps.length}: ${name}`);
  try {
    action();
  } catch (error) {
    console.error(`build-mcpb: step ${index + 1} (${name}) failed: ${error instanceof StepError ? error.message : error.stack ?? error}`);
    process.exitCode = 1;
    break;
  }
}
