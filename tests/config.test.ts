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

// --no-greeting sets false, as empty as '' (as --no-host is for E-023). A repeated --greeting is refused as a repeated
// option, before the greeting rule (E-052).
test('E-034: --no-greeting throws the greeting error; a repeated --greeting is refused', (t) => {
  t.is(configError(t, ['--no-greeting'])?.message, GREETING_ERROR);
  t.is(configError(t, ['--greeting', 'hi', '--greeting', '/op x'])?.message, 'Repeated option --greeting: give each option once');
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

// ---------------------------------------------------------------------------------------------------------------
// E-038: --call-limit-seconds, a whole number from 20 to 3600, 50 by default (Q27). It is checked as E-023 checks
// --port: a bad value throws a ConfigError, which src/main.ts writes as one stderr line before it exits with 1.
// ---------------------------------------------------------------------------------------------------------------

const CALL_LIMIT_ERROR = 'Invalid --call-limit-seconds: expected a whole number from 20 to 3600';

test('E-038: callLimitSeconds is 50 by default', (t) => {
  t.is(parseConfig([]).callLimitSeconds, 50);
  t.is(parseConfig(['--host', '127.0.0.1', '--port', '63320', '--username', 'MCPWorldTest', '--allow-commands']).callLimitSeconds, 50);
});

test('E-038: --call-limit-seconds 20, 120 and 3600 are accepted', (t) => {
  t.is(parseConfig(['--call-limit-seconds', '20']).callLimitSeconds, 20);
  t.is(parseConfig(['--call-limit-seconds', '120']).callLimitSeconds, 120);
  t.is(parseConfig(['--call-limit-seconds', '3600']).callLimitSeconds, 3600);
});

for (const value of ['19', '3601', '0', '-5', '1.5', 'abc', '']) {
  test(`E-038: --call-limit-seconds ${JSON.stringify(value)} throws a ConfigError`, (t) => {
    t.is(configError(t, ['--call-limit-seconds', value])?.message, CALL_LIMIT_ERROR);
  });
}

// --no-call-limit-seconds sets false, which is not a whole number. A repeated option is refused first (E-052).
test('E-038: --no-call-limit-seconds throws the same error; a repeated --call-limit-seconds is refused', (t) => {
  t.is(configError(t, ['--no-call-limit-seconds'])?.message, CALL_LIMIT_ERROR);
  t.is(configError(t, ['--call-limit-seconds', '60', '--call-limit-seconds', '90'])?.message,
    'Repeated option --call-limit-seconds: give each option once');
});

test('E-038: a bad --call-limit-seconds is a ConfigError that prints nothing, does not exit and does not repeat the value', (t) => {
  const sandbox = sinon.createSandbox();
  const exit = sandbox.stub(process, 'exit');
  const consoleError = sandbox.stub(console, 'error');
  const stderrWrite = sandbox.stub(process.stderr, 'write');
  try {
    const message = configError(t, ['--call-limit-seconds', '98765'])?.message ?? '';
    t.false(message.includes('98765'), message);
    t.false(exit.called, 'process.exit was called');
    t.false(consoleError.called, 'console.error was called');
    t.false(stderrWrite.called, 'process.stderr.write was called');
  } finally {
    sandbox.restore();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// E-042: --check, off by default. A wrong option is the same ConfigError as without it, and src/main.ts writes the
// same one stderr line, but exits with 2 when the command line has --check and with 1 otherwise. The exit code is
// carried by the error, so these cases need no real exit.
// ---------------------------------------------------------------------------------------------------------------

test('E-042: check is false by default and true with --check', (t) => {
  t.is(parseConfig([]).check, false);
  t.is(parseConfig(['--check']).check, true);
  t.is(parseConfig(['--no-check']).check, false);
});

test('E-042: --check goes together with --host, --port and --username, which keep their meaning', (t) => {
  const config = parseConfig(['--check', '--host', '127.0.0.1', '--port', '63320', '--username', 'SmokeTest']);
  t.true(config.check);
  t.is(config.host, '127.0.0.1');
  t.is(config.port, 63320);
  t.is(config.username, 'SmokeTest');
  t.is(parseConfig(['--port', '63320', '--check']).check, true);
});

for (const argv of [['--port', '0'], ['--hots', 'x']]) {
  test(`E-042: ${JSON.stringify(['--check', ...argv])} fails with exit code 2, ${JSON.stringify(argv)} with 1`, (t) => {
    const withCheck = configError(t, ['--check', ...argv]);
    const without = configError(t, argv);
    t.is(withCheck?.exitCode, 2);
    t.is(without?.exitCode, 1);
    t.is(withCheck?.message, without?.message, 'the same error text');
  });
}

test('E-042: --check after the wrong option also fails with 2', (t) => {
  t.is(configError(t, ['--port', '0', '--check'])?.exitCode, 2);
  t.is(configError(t, ['--username', 'Bad Name', '--check'])?.exitCode, 2);
});

test('E-042: a ConfigError with --check is thrown without printing anything or exiting', (t) => {
  const sandbox = sinon.createSandbox();
  const exit = sandbox.stub(process, 'exit');
  const consoleError = sandbox.stub(console, 'error');
  const consoleLog = sandbox.stub(console, 'log');
  const stderrWrite = sandbox.stub(process.stderr, 'write');
  try {
    for (const argv of [['--check', '--port', '0'], ['--check', '--hots', 'x']]) {
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

// ---------------------------------------------------------------------------------------------------------------
// E-052: a repeated option, a dotted option name and --no- on an option that takes a value are refused, as E-023's
// errors are (one line, exit 1, or 2 with --check), and no value is written (G6 I4).
// ---------------------------------------------------------------------------------------------------------------

for (const [argv, option] of [
  [['--host', 'a', '--host', 'b'], 'host'],
  [['--port', '1', '--port', '2'], 'port'],
  [['--username', 'A', '--username', 'B'], 'username'],
  [['--check', '--check'], 'check'],
  [['--allow-commands', '--no-allow-commands'], 'allow-commands'],
  [['--waypointFile', 'a.json', '--waypoint-file', 'b.json'], 'waypoint-file'],
  [['--decision-model=a', '--decision-model', 'b'], 'decision-model']
] as const) {
  test(`E-052: ${JSON.stringify(argv)} is a repeated option`, (t) => {
    t.is(configError(t, [...argv])?.message, `Repeated option --${option}: give each option once`);
  });
}

test('E-052: the repeated option is found before the other checks', (t) => {
  t.is(configError(t, ['--port', '0', '--port', '70000'])?.message, 'Repeated option --port: give each option once');
  t.is(configError(t, ['--host', 'a', '--host', 'b', '--hots', 'x'])?.message, 'Repeated option --host: give each option once');
});

for (const [argv, option] of [
  [['--host.a', 'b'], 'host'],
  [['--host.a=b'], 'host'],
  [['--foo.bar'], 'foo'],
  [['--port', '1', '--username.first', 'A'], 'username']
] as const) {
  test(`E-052: ${JSON.stringify(argv)} is a dotted option name`, (t) => {
    t.is(configError(t, [...argv])?.message, `Invalid --${option}: dotted option names are not supported`);
  });
}

test('E-052: the dotted error writes nothing after the first dot, where a pasted key could be', (t) => {
  const message = configError(t, ['--host.sk-or-v1-abc.def', 'x'])?.message ?? '';
  t.is(message, 'Invalid --host: dotted option names are not supported');
  t.false(message.includes('sk-or'));
});

test('E-052: dots in values are values', (t) => {
  t.is(parseConfig(['--host=a.b']).host, 'a.b');
  t.is(parseConfig(['--host', '192.168.1.5']).host, '192.168.1.5');
  t.is(parseConfig(['--waypoint-file', './my.waypoints.json']).waypointFile, './my.waypoints.json');
});

test('E-052: --no-waypoint-file and --no-decision-model are empty', (t) => {
  t.is(configError(t, ['--no-waypoint-file'])?.message, 'Invalid --waypoint-file: empty');
  t.is(configError(t, ['--no-decision-model'])?.message, 'Invalid --decision-model: empty');
});

test('E-052: --no- on a switch is still its off value, and a single use of each option is accepted', (t) => {
  t.is(parseConfig(['--no-allow-commands']).allowCommands, false);
  t.is(parseConfig(['--no-check']).check, false);
  const config = parseConfig(['--host', 'h', '--port', '2', '--username', 'Bot', '--waypoint-file', 'w.json',
    '--decision-model', 'm', '--allow-commands', '--greeting', 'hello', '--call-limit-seconds', '60']);
  t.deepEqual([config.host, config.port, config.username, config.waypointFile, config.decisionModel, config.allowCommands,
    config.greeting, config.callLimitSeconds], ['h', 2, 'Bot', 'w.json', 'm', true, 'hello', 60]);
});

test('E-052: with --check the new errors exit with 2, without it with 1', (t) => {
  for (const argv of [['--host', 'a', '--host', 'b'], ['--host.a', 'b'], ['--no-waypoint-file']]) {
    t.is(configError(t, ['--check', ...argv])?.exitCode, 2, JSON.stringify(argv));
    t.is(configError(t, argv)?.exitCode, 1, JSON.stringify(argv));
  }
  t.is(configError(t, ['--check', '--check'])?.exitCode, 2);
});

test('E-052: arguments after "--" are values, not options', (t) => {
  const message = configError(t, ['--', '--host.a', '--host'])?.message ?? '';
  t.false(message.includes('dotted'), message);
  t.false(message.includes('Repeated'), message);
});

// yargs reads every spelling with the same camelCase key as one option (all capitals, _ for -, a doubled -, camelCase),
// and the program reads that key, so the rules hold for all of them (E-052 review, 2026-11-01).
for (const [argv, message] of [
  [['--waypoint-file', 'a', '--waypoint-File', 'b'], 'Repeated option --waypoint-file: give each option once'],
  [['--waypoint-file', 'a', '--WAYPOINT-FILE', 'b'], 'Repeated option --waypoint-file: give each option once'],
  [['--decision-model', 'a', '--decision_model', 'b'], 'Repeated option --decision-model: give each option once'],
  [['--ALLOW-COMMANDS', '--allow-commands'], 'Repeated option --allow-commands: give each option once'],
  [['--no-allow-commands', '--allow--commands'], 'Repeated option --allow-commands: give each option once'],
  [['--no-waypoint-File'], 'Invalid --waypoint-file: empty'],
  [['--no-decision-Model'], 'Invalid --decision-model: empty'],
  [['--call-limit_seconds', '5'], CALL_LIMIT_ERROR],
  [['--CALL-LIMIT-SECONDS', '99999'], CALL_LIMIT_ERROR],
  [['--call-limit-Seconds', 'abc'], CALL_LIMIT_ERROR],
  [['--no-call-limit_seconds'], CALL_LIMIT_ERROR]
] as const) {
  test(`E-052: ${JSON.stringify(argv)} is refused like the usual spelling`, (t) => {
    t.is(configError(t, [...argv])?.message, message);
  });
}

test('E-052: a camelCase spelling given once still works', (t) => {
  t.is(parseConfig(['--waypointFile', 'w.json']).waypointFile, 'w.json');
  t.is(parseConfig(['--callLimitSeconds', '60']).callLimitSeconds, 60);
});

test('E-052: control characters in the part before the dot are escaped, so the error stays one line', (t) => {
  const message = configError(t, ['--ho\nst.sk-or-v1-abc', 'y'])?.message ?? '';
  t.is(message, 'Invalid --ho\\u000ast: dotted option names are not supported');
  t.false(message.includes('\n'));
});
