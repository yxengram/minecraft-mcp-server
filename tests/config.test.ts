import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { ConfigError, parseConfig, usernameWarning } from '../src/config.js';

test('parseConfig returns default values', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js'];
  
  const config = parseConfig();
  
  t.is(config.host, 'localhost');
  t.is(config.port, 25565);
  t.is(config.username, 'LLMBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses custom host', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--host', 'example.com'];
  
  const config = parseConfig();
  
  t.is(config.host, 'example.com');
  t.is(config.port, 25565);
  t.is(config.username, 'LLMBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses custom port', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--port', '12345'];
  
  const config = parseConfig();
  
  t.is(config.host, 'localhost');
  t.is(config.port, 12345);
  t.is(config.username, 'LLMBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses custom username', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--username', 'CustomBot'];
  
  const config = parseConfig();
  
  t.is(config.host, 'localhost');
  t.is(config.port, 25565);
  t.is(config.username, 'CustomBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses all custom options', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--host', 'server.net', '--port', '9999', '--username', 'TestBot'];
  
  const config = parseConfig();
  
  t.is(config.host, 'server.net');
  t.is(config.port, 9999);
  t.is(config.username, 'TestBot');
  
  process.argv = originalArgv;
});

test('parseConfig handles numeric port as number type', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--port', '30000'];
  
  const config = parseConfig();
  
  t.is(typeof config.port, 'number');
  t.is(config.port, 30000);
  
  process.argv = originalArgv;
});

test('parseConfig parses --decision-model and leaves it unset by default', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--decision-model', 'vendor/model-2026-09-01'];
  const config = parseConfig();
  process.argv = ['node', 'script.js'];
  const defaults = parseConfig();
  process.argv = originalArgv;

  t.is(config.decisionModel, 'vendor/model-2026-09-01');
  t.is(defaults.decisionModel, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// E-023: argument checks and the lenient username rule. The expected texts come from the E row; --help and
// --version exit the process, so they are left to the command-line checks of F-051.
// ---------------------------------------------------------------------------------------------------------------

const PORT_ERROR = 'Invalid --port: expected a whole number from 1 to 65535';
const usernameError = (name: string) =>
  `Invalid --username "${name}": use at most 16 characters, with no spaces or control characters`;
const usernameWarningText = (name: string) =>
  `--username "${name}" is not 3 to 16 letters, digits or underscores; some servers refuse such names`;

function configError(t: ExecutionContext, argv: string[]): ConfigError | undefined {
  return t.throws(() => parseConfig(argv), { instanceOf: ConfigError });
}

for (const port of ['0', '65536', 'abc', '1.5']) {
  test(`E-023: --port ${port} throws a ConfigError`, (t) => {
    const error = configError(t, ['--port', port]);
    t.true(error?.message.includes('Invalid --port'));
    t.is(error?.message, PORT_ERROR);
  });
}

test('E-023: --port 1 and --port 65535 are accepted', (t) => {
  t.is(parseConfig(['--port', '1']).port, 1);
  t.is(parseConfig(['--port', '65535']).port, 65535);
});

test('E-023: an unknown argument throws a ConfigError naming it', (t) => {
  const error = configError(t, ['--hots', 'x']);
  t.true(error?.message.includes('Unknown argument'), error?.message);
  t.true(error?.message.includes('hots'), error?.message);
});

test('E-023: positional arguments are rejected, also after --', (t) => {
  t.true(configError(t, ['foo'])?.message.includes('Unknown argument'));
  t.true(configError(t, ['--', 'foo'])?.message.includes('Unknown argument'));
});

// G6 I4: a value given without an option may be a key pasted into the client's args; the error line goes to the
// client's log, so it names the unknown options but not such values.
for (const argv of [
  ['sk-or-v1-abc'],
  ['--', 'sk-or-v1-abc'],
  ['--port', '1', 'OPENROUTER_API_KEY=sk-or-v1-abc'],
  ['--hots', 'x', 'sk-or-v1-abc']
]) {
  test(`E-023: ${JSON.stringify(argv)} is rejected without repeating the value`, (t) => {
    const message = configError(t, argv)?.message ?? '';
    t.true(message.includes('Unknown argument'), message);
    t.false(message.includes('sk-or-v1-abc'), message);
    if (argv[0] === '--hots') t.true(message.includes('hots'), message);
  });
}

test('E-023: an empty --host throws "Invalid --host: empty"', (t) => {
  t.is(configError(t, ['--host', ''])?.message, 'Invalid --host: empty');
});

test('E-023: an empty --username throws "Invalid --username: empty"', (t) => {
  t.is(configError(t, ['--username', ''])?.message, 'Invalid --username: empty');
});

// yargs reads --no-<option> as the option set to false, which leaves no host or name either.
test('E-023: --no-host and --no-username are empty too', (t) => {
  t.is(configError(t, ['--no-host'])?.message, 'Invalid --host: empty');
  t.is(configError(t, ['--no-username'])?.message, 'Invalid --username: empty');
});

test('E-023: a username of 17 characters is rejected, 16 are accepted', (t) => {
  const long = 'A'.repeat(17);
  t.is(configError(t, ['--username', long])?.message, usernameError(long));
  t.is(parseConfig(['--username', 'A'.repeat(16)]).username, 'A'.repeat(16));
  t.is(usernameWarning('A'.repeat(16)), null);
});

test('E-023: a username with a space or a control character is rejected', (t) => {
  t.is(configError(t, ['--username', 'Bad Name'])?.message, usernameError('Bad Name'));
  // The contract leaves the form of the escaped control character open; the error has to stay one line on stderr.
  for (const name of ['Bad\tName', 'Bad\nName']) {
    const message = configError(t, ['--username', name])?.message ?? '';
    t.true(message.startsWith('Invalid --username "'), message);
    t.true(message.endsWith('": use at most 16 characters, with no spaces or control characters'), message);
    t.false(message.includes('\n'), message);
  }
});

test('E-023: the name is quoted as given, also when it contains a quote', (t) => {
  t.is(configError(t, ['--username', 'a"b c'])?.message, usernameError('a"b c'));
  t.is(usernameWarning('a"b'), usernameWarningText('a"b'));
});

test('E-023: a ConfigError is thrown without printing anything or exiting', (t) => {
  const sandbox = sinon.createSandbox();
  const exit = sandbox.stub(process, 'exit');
  const consoleError = sandbox.stub(console, 'error');
  const consoleLog = sandbox.stub(console, 'log');
  const stderrWrite = sandbox.stub(process.stderr, 'write');
  try {
    for (const argv of [['--port', '0'], ['--hots', 'x'], ['--username', 'Bad Name']]) {
      t.throws(() => parseConfig(argv), { instanceOf: ConfigError });
    }
    t.false(exit.called, 'process.exit was called');
    t.false(consoleError.called, 'console.error was called');
    t.false(consoleLog.called, 'console.log was called');
    t.false(stderrWrite.called, 'process.stderr.write was called');
  } finally {
    sandbox.restore();
  }
});

for (const name of ['Bot-1', 'ab', '机器人']) {
  test(`E-023: --username ${name} parses and gets a warning`, (t) => {
    t.is(parseConfig(['--username', name]).username, name);
    t.not(usernameWarning(name), null);
    t.is(usernameWarning(name), usernameWarningText(name));
  });
}

// LLMBot is the default, ClaudeBot the README's example; the others are the names the scripts under scripts/ start
// dist/main.js with (test-live, test-live-world, test-scenarios, test-smoke) or the live tests' helper player; abc and
// Bot_1 are the edges of the rule (3 characters, an underscore).
for (const name of ['LLMBot', 'ClaudeBot', 'MCPSmokeTest', 'MCPWorldTest', 'MCPHelper', 'SmokeTest', 'abc', 'Bot_1']) {
  test(`E-023: --username ${name} parses without a warning`, (t) => {
    t.is(parseConfig(['--username', name]).username, name);
    t.is(usernameWarning(name), null);
  });
}

test('E-023: the arguments the live scripts pass still parse under strict', (t) => {
  const config = parseConfig([
    '--host', '127.0.0.1', '--port', '63320', '--username', 'MCPWorldTest', '--waypoint-file', '/tmp/x/waypoints.json'
  ]);
  t.is(config.host, '127.0.0.1');
  t.is(config.port, 63320);
  t.is(config.username, 'MCPWorldTest');
  t.is(config.waypointFile, '/tmp/x/waypoints.json');
});

// ---------------------------------------------------------------------------------------------------------------
// E-033: --allow-commands, off by default. It is only a start option (send-chat reads it at registration), so these
// cases are all there is to parse.
// ---------------------------------------------------------------------------------------------------------------

test('E-033: allowCommands is false by default and true with --allow-commands', (t) => {
  t.is(parseConfig([]).allowCommands, false);
  t.is(parseConfig(['--allow-commands']).allowCommands, true);
  t.is(parseConfig(['--no-allow-commands']).allowCommands, false);
});

// The option takes no value, so a value after it is left without an option and rejected without being repeated (G6 I4).
test('E-033: a value after --allow-commands is rejected without repeating it', (t) => {
  const message = configError(t, ['--allow-commands', 'sk-or-v1-abc'])?.message ?? '';
  t.true(message.includes('Unknown argument'), message);
  t.false(message.includes('sk-or-v1-abc'), message);
});

// scripts/lib/live-arena.mjs starts the server for test-live-world and test-scenarios with --allow-commands.
test('E-033: the arguments live-arena passes, --allow-commands included, parse under strict', (t) => {
  const config = parseConfig([
    '--host', '127.0.0.1', '--port', '63320', '--username', 'MCPWorldTest', '--waypoint-file', '/tmp/x/waypoints.json',
    '--allow-commands'
  ]);
  t.is(config.host, '127.0.0.1');
  t.is(config.port, 63320);
  t.is(config.username, 'MCPWorldTest');
  t.is(config.waypointFile, '/tmp/x/waypoints.json');
  t.true(config.allowCommands);
});

// ---------------------------------------------------------------------------------------------------------------
// E-034: --greeting <text>, unset by default. bot.chat sends a line that starts with / as a command, each line of a
// message separately, and a line of more than 256 characters in pieces, so only one line of plain chat passes.
// ---------------------------------------------------------------------------------------------------------------

const GREETING_ERROR = 'Invalid --greeting: expected one line of plain chat (not a command), at most 256 characters';

test('E-034: greeting is undefined by default', (t) => {
  t.is(parseConfig([]).greeting, undefined);
});

test('E-034: --greeting "hello all" parses as given', (t) => {
  t.is(parseConfig(['--greeting', 'hello all']).greeting, 'hello all');
});

test('E-034: a greeting of 256 characters is accepted', (t) => {
  t.is(parseConfig(['--greeting', 'a'.repeat(256)]).greeting, 'a'.repeat(256));
});

for (const [name, greeting] of [
  ['a command ("/op x")', '/op x'],
  ['a command on the second line ("hi\\n/op x")', 'hi\n/op x'],
  ['257 characters', 'a'.repeat(257)],
  ['an empty string', '']
]) {
  test(`E-034: --greeting with ${name} throws the greeting error`, (t) => {
    t.is(configError(t, ['--greeting', greeting])?.message, GREETING_ERROR);
  });
}

// "One line, no control characters": a carriage return, a tab, DEL and the line separator are refused as well.
for (const [name, greeting] of [
  ['a carriage return', 'hi\r/op x'],
  ['a tab', 'hi\tthere'],
  ['DEL (U+007F)', 'hi\u007f'],
  ['a line separator (U+2028)', 'hi\u2028/op x']
]) {
  test(`E-034: --greeting with ${name} throws the greeting error`, (t) => {
    t.is(configError(t, ['--greeting', greeting])?.message, GREETING_ERROR);
  });
}

// --no-greeting sets false, as empty as '' (as --no-host is for E-023); a repeated --greeting is an array, which is
// not one line either.
test('E-034: --no-greeting and a repeated --greeting throw the greeting error', (t) => {
  t.is(configError(t, ['--no-greeting'])?.message, GREETING_ERROR);
  t.is(configError(t, ['--greeting', 'hi', '--greeting', '/op x'])?.message, GREETING_ERROR);
});

// The error line goes to the client's log; it names the rule, not the text (G6 I4: a pasted key stays out of it).
test('E-034: the greeting error does not repeat the text', (t) => {
  const message = configError(t, ['--greeting', 'sk-or-v1-abc\n'])?.message ?? '';
  t.is(message, GREETING_ERROR);
  t.false(message.includes('sk-or-v1-abc'), message);
});

// The greeting is the user's own start option: it needs no --allow-commands, and the two do not affect each other.
test('E-034: --greeting goes together with the other options', (t) => {
  const config = parseConfig(['--host', '127.0.0.1', '--port', '63320', '--username', 'MCPWorldTest', '--greeting', 'hello all']);
  t.is(config.greeting, 'hello all');
  t.false(config.allowCommands);
  t.is(parseConfig(['--allow-commands', '--greeting', 'hi']).greeting, 'hi');
});
