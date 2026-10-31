import yargs from 'yargs';
import { Parser, hideBin } from 'yargs/helpers';
import { COMMAND_NAME, PACKAGE_VERSION } from './package-info.js';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  waypointFile?: string;
  /**
   * Decision model id for the instinct, chat triage and chat commands (BLUEPRINT E-006, E-036); the API key comes only
   * from OPENROUTER_API_KEY.
   */
  decisionModel?: string;
  /**
   * send-chat may run server commands besides /msg, /tell, /w, /me, /teammsg and /tm (BLUEPRINT E-033). Only this
   * option turns it on: it is not part of the policy, so neither set-policy nor chat can change it.
   */
  allowCommands: boolean;
  /**
   * What the bot says in chat each time it joins the world (BLUEPRINT E-034); unset, it says nothing. parseConfig lets
   * through only one line of plain chat of at most 100 characters, so bot.chat sends it as one message, never a command.
   */
  greeting?: string;
  /**
   * How long a command that drives the bot, collect-block or lead-animal may take before it replies, in seconds
   * (BLUEPRINT E-038): the body commands' budget, and what the long tools leave for the reply. 50 suits MCP clients
   * that give up on a request after 60 s. wait-for-event keeps its own cap of 55 s.
   */
  callLimitSeconds: number;
  /**
   * --check (BLUEPRINT E-042): join the world once, check the key, print a report on stdout and exit, instead of
   * serving MCP. src/self-check.ts runs it.
   */
  check: boolean;
}

/**
 * An unknown argument or an invalid value (BLUEPRINT E-023). parseConfig throws it instead of printing or exiting.
 * exitCode is what src/main.ts exits with: 2 when the command line has --check (E-042), otherwise 1.
 */
export class ConfigError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'ConfigError';
  }
}

const MAX_USERNAME_LENGTH = 16;
// Microsoft account names: 3 to 16 letters, digits or underscores. Other names only get a warning (usernameWarning).
const ACCOUNT_NAME = /^[A-Za-z0-9_]{3,16}$/;

// A value given without an option may be a pasted key (G6 I4), so an unknown-argument error names options only.
const BARE_VALUE = 'a value without an option';

// The name is quoted as given. Control characters (tab, line breaks, DEL, C1) and the line and paragraph separators
// are written as \uXXXX, so the error stays one line.
const UNPRINTABLE = /[\p{Cc}\u2028\u2029]/gu;

// bot.chat sends each line of a message separately, and a line that starts with / as a command; it also cuts a line
// longer than the server's chat limit (counted as String.length, as the server does) into pieces, and a later piece
// may start with / too (E-034). The limit is 256 characters, but 100 on 1.8 to 1.10.2 servers, so at most 100 keeps
// the greeting one piece on every server (E-054). Line separators count as line breaks, so it stays one line.
const MAX_GREETING_LENGTH = 100;
const LINE_BREAK_OR_CONTROL = /[\p{Cc}\u2028\u2029]/u;
const GREETING_ERROR = `Invalid --greeting: expected one line of plain chat (not a command), at most ${MAX_GREETING_LENGTH} characters`;

// --call-limit-seconds (E-038, Q27): the default suits clients that give up on a request after 60 s.
const MIN_CALL_LIMIT_SECONDS = 20;
const MAX_CALL_LIMIT_SECONDS = 3600;
const DEFAULT_CALL_LIMIT_SECONDS = 50;

// E-042: a wrong option exits with 2 when the command line has --check, so a script can tell it from a failed join (1).
const CHECK_FLAG = '--check';
const CHECK_EXIT_CODE = 2;

// The options parseConfig declares, by yargs's camelCase key (what the program reads) and their dashed names (E-052).
const OPTION_KEYS = new Map(
  ['host', 'port', 'username', 'waypoint-file', 'decision-model', 'allow-commands', 'greeting', 'call-limit-seconds', 'check']
    .map((name) => [Parser.camelCase(name), name])
);
const HELP_OR_VERSION = new Set(['--help', '-h', '--version']);

/**
 * E-052: what yargs would otherwise take without a word. A dotted name (--host.a b) makes the option an object, and a
 * repeated option becomes an array or its last value (switches, and --no-x after --x). yargs reads every spelling
 * with the same camelCase key as one option (--waypointFile, --WAYPOINT-FILE, --waypoint_file), so names are compared
 * by that key, made by yargs's own function. Only the part of a dotted name before its first dot is written, with
 * control characters escaped: the rest may be a key pasted in the wrong place (G6 I4). After "--" all are values.
 * --help and --version are left to yargs, which prints them whatever else is on the command line.
 */
function checkOptionNames(argv: string[]): void {
  const end = argv.indexOf('--');
  const options = end >= 0 ? argv.slice(0, end) : argv;
  if (options.some((arg) => HELP_OR_VERSION.has(arg))) return;
  const seen = new Set<string>();
  for (const arg of options) {
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2).split('=')[0];
    const dot = name.indexOf('.');
    if (dot >= 0) throw new Error(`Invalid --${printable(name.slice(0, dot))}: dotted option names are not supported`);
    // yargs reads --no-<name> as <name> set to false.
    const key = Parser.camelCase(name.startsWith('no-') ? name.slice(3) : name);
    const option = OPTION_KEYS.get(key);
    if (option === undefined) continue;
    if (seen.has(key)) throw new Error(`Repeated option --${option}: give each option once`);
    seen.add(key);
  }
}

function printable(text: string): string {
  return text.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function quoted(value: unknown): string {
  return `"${printable(String(value))}"`;
}

function checkArguments(argv: {
  _: (string | number)[]; host: unknown; port: number; username: unknown; waypointFile?: unknown; decisionModel?: unknown;
  greeting?: unknown; callLimitSeconds?: unknown;
}): true {
  // .strict() lets positional arguments after "--" through; they are rejected with yargs's wording, without the values.
  if (argv._.length > 0) {
    throw new Error(`Unknown argument${argv._.length > 1 ? 's' : ''}: ${argv._.map(() => BARE_VALUE).join(', ')}`);
  }
  if (!Number.isInteger(argv.port) || argv.port < 1 || argv.port > 65535) {
    throw new Error('Invalid --port: expected a whole number from 1 to 65535');
  }
  // --no-host and --no-username set the option to false, which is as empty as ''.
  if (argv.host === '' || argv.host === false) {
    throw new Error('Invalid --host: empty');
  }
  if (argv.username === '' || argv.username === false) {
    throw new Error('Invalid --username: empty');
  }
  // --no-waypoint-file and --no-decision-model set false too (E-052); an empty string keeps its old meaning. The
  // camelCase keys are checked because they are what the program reads, under every spelling yargs accepts.
  if (argv.waypointFile === false) throw new Error('Invalid --waypoint-file: empty');
  if (argv.decisionModel === false) throw new Error('Invalid --decision-model: empty');
  // The length in UTF-16 units, which is how the server counts the 16 characters of a name.
  const name = argv.username;
  if (typeof name === 'string' && (name.length > MAX_USERNAME_LENGTH || /[\s\p{Cc}]/u.test(name))) {
    throw new Error(
      `Invalid --username ${quoted(name)}: use at most ${MAX_USERNAME_LENGTH} characters, with no spaces or control characters`
    );
  }
  // The error does not repeat the text. --no-greeting (false) is as empty as ''. (A repeated --greeting, an array that
  // bot.chat would throw on, is refused before this, E-052.)
  const greeting = argv.greeting;
  if (
    greeting !== undefined &&
    (typeof greeting !== 'string' || greeting === '' || greeting.length > MAX_GREETING_LENGTH ||
      LINE_BREAK_OR_CONTROL.test(greeting) || greeting.startsWith('/'))
  ) {
    throw new Error(GREETING_ERROR);
  }
  // --no-call-limit-seconds is false, not a whole number. The error does not repeat the value.
  const limit = argv.callLimitSeconds;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < MIN_CALL_LIMIT_SECONDS || limit > MAX_CALL_LIMIT_SECONDS) {
    throw new Error(`Invalid --call-limit-seconds: expected a whole number from ${MIN_CALL_LIMIT_SECONDS} to ${MAX_CALL_LIMIT_SECONDS}`);
  }
  return true;
}

/**
 * Parses the command line. --help and --version print to stdout and exit with 0 (yargs does that, so call this before
 * setupStdioFiltering); anything else that is wrong throws a ConfigError.
 */
export function parseConfig(argv: string[] = hideBin(process.argv)): ServerConfig {
  try {
    checkOptionNames(argv);
  } catch (error) {
    throw new ConfigError((error as Error).message, argv.includes(CHECK_FLAG) ? CHECK_EXIT_CODE : 1);
  }
  return yargs(argv)
    .scriptName(COMMAND_NAME)
    .usage('Usage: $0 [options]')
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('waypoint-file', {
      type: 'string',
      description: 'JSON file used to store waypoints (default: ~/.minecraft-mcp-server/waypoints.json)'
    })
    .option('decision-model', {
      type: 'string',
      description: 'OpenRouter decision model id for the instinct (how the bot reacts to dangers by itself) and for sorting chat (needs OPENROUTER_API_KEY in the environment)'
    })
    .option('allow-commands', {
      type: 'boolean',
      description: 'Let send-chat run server commands such as /give, /fill and /tp (without it: chat and /msg, /tell, /w, /me, /teammsg, /tm only)',
      default: false
    })
    .option('greeting', {
      type: 'string',
      description: 'Say this in chat each time the bot joins the world (without it: say nothing); one line of plain chat, at most 100 characters, not starting with /'
    })
    .option('call-limit-seconds', {
      type: 'number',
      description: `How long a command that drives the bot, collect-block or lead-animal may take before it replies, in seconds (${MIN_CALL_LIMIT_SECONDS} to ${MAX_CALL_LIMIT_SECONDS}); raise it only for an MCP client that waits longer than 60 s for a reply`,
      default: DEFAULT_CALL_LIMIT_SECONDS
    })
    .option('check', {
      type: 'boolean',
      description: 'Join the world once, check the OpenRouter key, print a report and exit (0: joined, 1: could not join, 2: wrong options) instead of serving MCP',
      default: false
    })
    .strict()
    .check(checkArguments)
    .fail((message, error) => {
      const text = error?.message ?? message;
      // .strict() lists the values given without an option among the unknown arguments; those are replaced (G6 I4).
      const bare = new Set(argv.filter((arg) => !arg.startsWith('-')));
      throw new ConfigError(
        text.replace(/^(Unknown arguments?: )(.*)$/s, (_, head: string, list: string) =>
          head + list.split(', ').map((item) => (bare.has(item) ? BARE_VALUE : item)).join(', ')),
        argv.includes(CHECK_FLAG) ? CHECK_EXIT_CODE : 1
      );
    })
    .example('$0 --port 25565 --username ClaudeBot', 'Join the world opened to LAN on port 25565 as ClaudeBot')
    .epilogue('The OpenRouter API key is read only from the OPENROUTER_API_KEY environment variable; no option takes it.')
    .version(PACKAGE_VERSION)
    .help()
    .alias('help', 'h')
    .parseSync();
}

/**
 * The lenient part of the username rule: a name that passed parseConfig but is not a Microsoft account name may still
 * be refused by some servers. Returns the warning to log, or null.
 */
export function usernameWarning(name: string): string | null {
  if (ACCOUNT_NAME.test(name)) return null;
  return `--username ${quoted(name)} is not 3 to 16 letters, digits or underscores; some servers refuse such names`;
}
