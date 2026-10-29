import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { COMMAND_NAME, PACKAGE_VERSION } from './package-info.js';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  waypointFile?: string;
  /** Decision model id for chat triage and chat commands (BLUEPRINT E-006); the API key comes only from OPENROUTER_API_KEY. */
  decisionModel?: string;
}

/** An unknown argument or an invalid value (BLUEPRINT E-023). parseConfig throws it instead of printing or exiting. */
export class ConfigError extends Error {
  constructor(message: string) {
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
// are written as \uXXXX, so the error stays one line. A repeated --username reaches here as an array, hence String().
const UNPRINTABLE = /[\p{Cc}\u2028\u2029]/gu;

function quoted(value: unknown): string {
  return `"${String(value).replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

function checkArguments(argv: { _: (string | number)[]; host: unknown; port: number; username: unknown }): true {
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
  // The length in UTF-16 units, which is how the server counts the 16 characters of a name. Only a string is checked:
  // a repeated --username is an array, which is passed on as yargs gives it.
  const name = argv.username;
  if (typeof name === 'string' && (name.length > MAX_USERNAME_LENGTH || /[\s\p{Cc}]/u.test(name))) {
    throw new Error(
      `Invalid --username ${quoted(name)}: use at most ${MAX_USERNAME_LENGTH} characters, with no spaces or control characters`
    );
  }
  return true;
}

/**
 * Parses the command line. --help and --version print to stdout and exit with 0 (yargs does that, so call this before
 * setupStdioFiltering); anything else that is wrong throws a ConfigError.
 */
export function parseConfig(argv: string[] = hideBin(process.argv)): ServerConfig {
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
      description: 'OpenRouter decision model id used to sort chat (needs OPENROUTER_API_KEY in the environment)'
    })
    .strict()
    .check(checkArguments)
    .fail((message, error) => {
      const text = error?.message ?? message;
      // .strict() lists the values given without an option among the unknown arguments; those are replaced (G6 I4).
      const bare = new Set(argv.filter((arg) => !arg.startsWith('-')));
      throw new ConfigError(
        text.replace(/^(Unknown arguments?: )(.*)$/s, (_, head: string, list: string) =>
          head + list.split(', ').map((item) => (bare.has(item) ? BARE_VALUE : item)).join(', '))
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
