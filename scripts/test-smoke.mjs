// Smoke test without a game (F-051): checks that the built or packed server starts, answers MCP and exits.
//
//   npm run build
//   npm run test:smoke                                   # dist/main.js of this checkout
//   npm run test:smoke -- <dir>/node_modules/<package>/dist/main.js   # an installed package or an unpacked .mcpb
//   node scripts/test-smoke.mjs --pack-report <file with the output of npm pack --json>
//   node scripts/test-smoke.mjs --compare-lock <install dir> [lockfile]
//
// The server under test only ever sees 127.0.0.1 and a port this script has just closed, so no game server answers.
// Every child gets only the SDK's default environment, so an OPENROUTER_API_KEY set for the developer or in CI is not
// passed on. One PASS or FAIL line per check; after any FAIL, the last 40 stderr lines of each child and exit code 1.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const STDERR_TAIL = 40;
const CLIENT_INFO = { name: 'minecraft-smoke-test', version: '1.0.0' };
const CONNECT_ERROR_PREFIX = 'Cannot connect to Minecraft server at 127.0.0.1:';
// The packages whose versions the code depends on (E-025): bot._client packets, pathfinder internals, fixed data tables.
const PROTOCOL_STACK = /^(mineflayer|mineflayer-pathfinder|minecraft-data|minecraft-protocol|prismarine-.+)$/;

let failed = false;
const outputs = [];

function report(ok, name, detail) {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed = true;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}

function onLines(stream, onLine) {
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    const parts = (partial + chunk).split(/\r?\n/);
    partial = parts.pop();
    for (const line of parts) onLine(line);
  });
  return () => partial;
}

// Keeps the last lines a child wrote to stderr, to show why a check failed.
function captureStderr(label, stream) {
  const capture = { label, lines: [], partial: () => '' };
  outputs.push(capture);
  capture.partial = onLines(stream, line => {
    capture.lines.push(line);
    if (capture.lines.length > STDERR_TAIL) capture.lines.shift();
  });
}

function printStderrTails() {
  for (const { label, lines, partial } of outputs) {
    const tail = (partial() ? [...lines, partial()] : lines).slice(-STDERR_TAIL);
    console.error(`--- last ${STDERR_TAIL} stderr lines of ${label} ---`);
    console.error(tail.length > 0 ? tail.join('\n') : '(nothing)');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function responseText(result) {
  return (result.content ?? [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

function firstLine(text) {
  return text.split('\n')[0];
}

// A port nothing listens on: the bot's connection is refused at once instead of waiting for a timeout.
async function closedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// TODO(E-023): the command-line checks of F-051 (a) come with E-023. Until then --help and --version print nothing
// (setupStdioFiltering drops yargs's output) and invalid or unknown arguments start the server anyway. Each runs with
// node:child_process and env: getDefaultEnvironment():
// - --help exits with 0, and stdout contains "--port" and "OPENROUTER_API_KEY";
// - --version prints the version of package.json;
// - --port 0 exits with 1, and stderr contains "Invalid --port";
// - with a port listening on 127.0.0.1, `--host 127.0.0.1 --port <it> --hots x` exits with 1 within 2 s, stderr
//   contains "Unknown argument", and the listening port receives no connection.

async function checkMcp(entry, args, pkg) {
  const client = new Client(CLIENT_INFO);
  // No env: the transport then passes only getDefaultEnvironment(), without OPENROUTER_API_KEY.
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, ...args], stderr: 'pipe' });
  captureStderr('the MCP session', transport.stderr);
  // A stdout line that is not JSON-RPC reaches onerror: JSON.parse or the message schema throws on it.
  const transportErrors = [];
  client.onerror = error => transportErrors.push(error);

  try {
    try {
      await client.connect(transport, { timeout: 15000 });
      report(true, 'initialize within 15 s');
    } catch (error) {
      report(false, 'initialize within 15 s', error.message);
      return;
    }

    // F-051 compares serverInfo with the package.json beside the entry. main.ts still names the server and its version
    // itself (E-024 takes them from package.json), and both agree with package.json today, so a version bump that
    // misses main.ts already fails here.
    const serverInfo = client.getServerVersion();
    const expectedName = pkg.name.replace(/^@[^/]+\//, '');
    report(
      serverInfo?.name === expectedName && serverInfo?.version === pkg.version,
      'serverInfo matches package.json',
      `got ${serverInfo?.name} ${serverInfo?.version}, package.json has ${expectedName} ${pkg.version}`
    );

    try {
      const { tools } = await client.listTools(undefined, { timeout: 10000 });
      report(tools.length > 0, 'tools/list is not empty', `${tools.length} tools`);
      const names = tools.map(tool => tool.name);
      const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
      report(duplicates.length === 0, 'tool names are unique', duplicates.length > 0 ? duplicates.join(', ') : undefined);
      const incomplete = tools
        .filter(tool => !(typeof tool.description === 'string' && tool.description.trim()) || tool.inputSchema?.type !== 'object')
        .map(tool => tool.name);
      report(
        incomplete.length === 0,
        'every tool has a description and an input schema',
        incomplete.length > 0 ? incomplete.join(', ') : undefined
      );
      // TODO(E-044): F-055 makes dist/tool-annotations.js the source of the tool list. Then import TOOL_NAMES from
      // path.join(path.dirname(entry), 'tool-annotations.js') and require that the listed names equal it exactly and
      // that every tool has a title and annotations. The number of tools stays unwritten here.
    } catch (error) {
      report(false, 'tools/list', error.message);
    }

    await checkConnectionError(client);
  } finally {
    // Only the lines that failed to parse, taken before close: pipe errors from a dying child say nothing about what
    // was on stdout.
    const errors = transportErrors.filter(error => error instanceof SyntaxError || error?.name === 'ZodError');
    report(
      errors.length === 0,
      'stdout carries only JSON-RPC',
      errors.length > 0
        ? errors.slice(0, 3).map(error => (error.name === 'ZodError' ? 'a JSON line that is not JSON-RPC' : error.message)).join(' | ')
        : undefined
    );
    await client.close();
  }
}

// With nothing listening, a tool call must come back as the fixed connection error that E-028 and users rely on.
async function checkConnectionError(client) {
  const name = 'get-position reports the connection error within 20 s';
  const deadline = Date.now() + 20000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      report(false, name, 'only "Bot is connecting" until the deadline');
      return;
    }
    let result;
    try {
      // A call made while the bot is disconnected waits for one reconnect attempt (about 7 s) before it answers.
      result = await client.callTool({ name: 'get-position', arguments: {} }, undefined, { timeout: remaining });
    } catch (error) {
      report(false, name, error.message);
      return;
    }
    const text = responseText(result);
    if (result.isError && text.startsWith(CONNECT_ERROR_PREFIX)) {
      report(true, name, firstLine(text));
      return;
    }
    // The first attempt may still be under way; the contract counts this answer as normal.
    if (result.isError && text.startsWith('Bot is connecting')) {
      await sleep(500);
      continue;
    }
    report(false, name, `${result.isError ? 'error' : 'success'}: ${firstLine(text)}`);
    return;
  }
}

// node:child_process rather than the SDK: Client.close() gives no exit code and sends SIGTERM after 2 s.
async function checkShutdown(entry, args) {
  const name = 'exits with 0 within 5 s after stdin closes';
  const child = spawn(process.execPath, [entry, ...args], {
    env: getDefaultEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  captureStderr('the shutdown run', child.stderr);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  // TODO(E-024): wait for the startup line "<command> v<version>, tested with Minecraft ..." on stderr instead. Until
  // E-024 adds it, the answer to initialize shows the server is running with stdio connected.
  const answered = new Promise(resolve => {
    onLines(child.stdout, line => {
      if (line.includes('"id":1')) resolve();
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }
  }) + '\n');

  try {
    const first = await withTimeout(Promise.race([answered.then(() => null), exited]), 15000, 'an answer to initialize');
    if (first) {
      report(false, name, `exited before answering initialize (code ${first.code}, signal ${first.signal})`);
      return;
    }
    child.stdin.end();
    const { code, signal } = await withTimeout(exited, 5000, 'exit');
    report(code === 0, name, code === 0 ? undefined : `code ${code}, signal ${signal}`);
  } catch (error) {
    report(false, name, error.message);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function smoke(entryArg) {
  const entry = entryArg ? path.resolve(entryArg) : path.join(REPO, 'dist', 'main.js');
  if (!report(existsSync(entry), 'entry exists', entry)) return;
  // The expected name and version come from the package the entry belongs to, never from this script.
  const pkgFile = path.resolve(entry, '..', '..', 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    report(false, 'package.json beside the entry', `${pkgFile}: ${error.message}`);
    return;
  }

  const port = await closedPort();
  const args = ['--host', '127.0.0.1', '--port', String(port), '--username', 'SmokeTest'];
  await checkMcp(entry, args, pkg);
  await checkShutdown(entry, args);
}

// Rules of F-051: what may and must be in the npm package (the files list comes from E-024, the shrinkwrap from E-025).
const PACK_TOP_LEVEL = new Set(['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'npm-shrinkwrap.json']);
const PACK_REQUIRED = ['dist/main.js', 'package.json', 'CHANGELOG.md', 'npm-shrinkwrap.json'];
const PACK_FORBIDDEN = [
  ['src/', file => file.startsWith('src/')],
  ['tests/', file => file.startsWith('tests/')],
  ['scripts/', file => file.startsWith('scripts/')],
  ['docs/', file => file.startsWith('docs/')],
  ['.github/', file => file.startsWith('.github/')],
  ['*.d.ts', file => file.endsWith('.d.ts')],
  ['dist/autopilot/reflex*.js', file => /^dist\/autopilot\/reflex[^/]*\.js$/.test(file)]
];

function listSome(files) {
  return files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ');
}

function checkPackReport(reportFile) {
  let files;
  try {
    const parsed = JSON.parse(readFileSync(reportFile, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    if (entries.length !== 1 || !Array.isArray(entries[0]?.files)) throw new Error('expected the report of one package');
    files = entries[0].files.map(file => file.path.replace(/\\/g, '/'));
  } catch (error) {
    report(false, 'pack report', `${reportFile}: ${error.message}`);
    return;
  }

  const unexpected = files.filter(file => !(file.startsWith('dist/') && file.endsWith('.js')) && !PACK_TOP_LEVEL.has(file));
  report(
    unexpected.length === 0,
    'pack has only dist/**/*.js, package.json, the READMEs, LICENSE, CHANGELOG.md and npm-shrinkwrap.json',
    unexpected.length > 0 ? listSome(unexpected) : `${files.length} files`
  );
  for (const required of PACK_REQUIRED) {
    report(files.includes(required), `pack contains ${required}`);
  }
  for (const [label, matches] of PACK_FORBIDDEN) {
    const found = files.filter(matches);
    report(found.length === 0, `pack has no ${label}`, found.length > 0 ? listSome(found) : undefined);
  }
}

function checkLock(installArg, lockArg) {
  if (!installArg) {
    report(false, 'compare-lock', 'pass the directory the package was installed in');
    return;
  }
  const installDir = path.resolve(installArg);
  const lockFile = lockArg
    ? path.resolve(lockArg)
    : ['npm-shrinkwrap.json', 'package-lock.json'].map(name => path.join(REPO, name)).find(file => existsSync(file));
  if (!lockFile) {
    report(false, 'compare-lock', `no npm-shrinkwrap.json or package-lock.json in ${REPO}`);
    return;
  }

  // Every version the lockfile has for a name, at any depth: names appear once today, but may appear more than once.
  const locked = new Map();
  try {
    const { packages } = JSON.parse(readFileSync(lockFile, 'utf8'));
    for (const [key, entry] of Object.entries(packages ?? {})) {
      const name = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
      if (!name || !entry.version) continue;
      if (!locked.has(name)) locked.set(name, new Set());
      locked.get(name).add(entry.version);
    }
  } catch (error) {
    report(false, 'compare-lock', `${lockFile}: ${error.message}`);
    return;
  }

  // npm ls exits with 1 when the tree has problems but still prints the tree; npm is npm.cmd on Windows.
  const ls = spawnSync('npm', ['ls', '--all', '--json'], {
    cwd: installDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32'
  });
  outputs.push({ label: 'npm ls', lines: (ls.stderr ?? '').split(/\r?\n/).slice(-STDERR_TAIL), partial: () => '' });
  let tree;
  try {
    tree = JSON.parse(ls.stdout);
  } catch (error) {
    report(false, 'npm ls --all --json', ls.error?.message ?? error.message);
    return;
  }

  const installed = new Map();
  const missing = new Set();
  (function walk(node) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (PROTOCOL_STACK.test(name)) {
        if (child.missing || !child.version) missing.add(name);
        else {
          if (!installed.has(name)) installed.set(name, new Set());
          installed.get(name).add(child.version);
        }
      }
      walk(child);
    }
  })(tree);

  for (const name of ['mineflayer', 'mineflayer-pathfinder', 'minecraft-data', 'minecraft-protocol']) {
    if (!installed.has(name)) missing.add(name);
  }
  for (const name of missing) report(false, `${name} is installed`, installDir);

  const lockLabel = path.basename(lockFile);
  for (const [name, versions] of [...installed].sort(([a], [b]) => a.localeCompare(b))) {
    const lockedVersions = locked.get(name) ?? new Set();
    const strays = [...versions].filter(version => !lockedVersions.has(version));
    report(
      strays.length === 0,
      `${name} ${[...versions].join(', ')} is in ${lockLabel}`,
      strays.length > 0 ? `${lockLabel} has ${[...lockedVersions].join(', ') || 'no entry'}` : undefined
    );
  }
}

// A hung child or pipe must not stall CI; unref so it never keeps a finished run alive.
setTimeout(() => {
  report(false, 'smoke test finished within 120 s');
  printStderrTails();
  process.exit(1);
}, 120000).unref();

const argv = process.argv.slice(2);
if (argv[0] === '--pack-report') {
  if (argv[1]) checkPackReport(argv[1]);
  else report(false, 'pack-report', 'pass the file with the output of npm pack --json');
} else if (argv[0] === '--compare-lock') {
  checkLock(argv[1], argv[2]);
} else if (argv[0]?.startsWith('--')) {
  report(false, 'arguments', `unknown option ${argv[0]}; use [entry], --pack-report <file> or --compare-lock <dir> [lockfile]`);
} else {
  await smoke(argv[0]);
}

if (failed) printStderrTails();
// exitCode rather than exit(): on macOS stdout to a pipe is asynchronous, and exit() could cut the report short.
process.exitCode = failed ? 1 : 0;
