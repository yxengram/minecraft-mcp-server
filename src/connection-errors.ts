// Plain-language reasons for a failed connection or a kick (BLUEPRINT F-053, E-028). Pure: no events, no logs, and
// no decision about reconnecting, which stays in bot-connection.ts.
import minecraftData from 'minecraft-data';
import { componentToText, simplifyNbt } from './text-component.js';
import type { ConnectionFailure } from './bot-connection.js';

// The same value as SUPPORTED_MINECRAFT_VERSION in bot-connection.ts. Not imported from there: bot-connection imports
// this module, so a value import would be a cycle.
const VERIFIED_VERSION = '26.1.2';
const KEY_PREFIX = 'multiplayer.disconnect.';

type Json = ReturnType<typeof simplifyNbt>;
type JsonObject = { [key: string]: Json };

export interface ConnectionTarget {
  host: string;
  port: number;
  username: string;
}

/** The row of the F-053 table that explained a failure; bot-connection.ts uses it to pick which kicks to explain. */
export type FailureKind =
  | 'refused' | 'host_not_found' | 'no_answer' | 'closed'
  | 'online_mode' | 'same_name' | 'version'
  | 'banned' | 'ip_banned' | 'not_whitelisted' | 'server_full' | 'kicked';

export interface FailureExplanation {
  explanation: string;
  /** What goes in the reply's parentheses: the error code, the translation key or the raw message; absent when there is none. */
  code?: string;
  /** Absent when no row matched and the explanation is the raw text. */
  kind?: FailureKind;
}

type Explain = (target: ConnectionTarget, args: string[]) => string;

const at = ({ host, port }: ConnectionTarget) => `${host}:${port}`;

const EXPLAIN: Record<FailureKind, Explain> = {
  refused: target => `Nothing is listening on ${at(target)}. Open the world to LAN (Esc → Open to LAN) and use the port it prints in chat as --port`,
  host_not_found: ({ host }) => `The host name '${host}' was not found. Check --host (localhost for a world on this computer)`,
  no_answer: target => `No answer from ${at(target)}. Check the address, the network and the firewall`,
  closed: target => `${at(target)} closed the connection during login. Check that it is a Minecraft Java server and that the port is right`,
  online_mode: () => 'The server checks Microsoft accounts (online mode); this bot joins with an offline account. See Accounts in the README',
  same_name: ({ username }) => `Another player or bot named ${username} joined (maybe you, if the bot has your name). Give the bot its own --username`,
  // args[0] is the server's version: the translation's %s, or what the version error names.
  version: (_target, [version]) => version
    ? `The server runs Minecraft ${version}; this bot is verified with ${VERIFIED_VERSION}`
    : `The server runs another version of Minecraft; this bot is verified with ${VERIFIED_VERSION}`,
  banned: ({ username }, [reason]) => `${username} is banned from this server${reason ? ` (reason: ${reason})` : ''}: run /pardon ${username} on the server`,
  ip_banned: () => 'The IP address of this computer is banned from this server: run /pardon-ip <address> on the server',
  not_whitelisted: ({ username }) => `${username} is not on the whitelist: run /whitelist add ${username} on the server`,
  server_full: () => 'The server is full: wait for a player to leave. A world opened to LAN takes at most 8 players, the host included; on a dedicated server, raise max-players in server.properties and restart the server',
  kicked: () => 'An operator kicked the bot',
};

const CODE_KINDS: Record<string, FailureKind> = {
  ECONNREFUSED: 'refused',
  ENOTFOUND: 'host_not_found',
  EAI_AGAIN: 'host_not_found',
  ETIMEDOUT: 'no_answer',
  EHOSTUNREACH: 'no_answer',
  ENETUNREACH: 'no_answer',
  // The E-021 watchdog.
  SPAWN_TIMEOUT: 'no_answer',
  ECONNRESET: 'closed',
  EPIPE: 'closed',
};

// Only keys checked to exist in the 26.1.2 language.json; the prefix multiplayer.disconnect. is left out.
const KEY_KINDS: Record<string, FailureKind> = {
  unverified_username: 'online_mode',
  duplicate_login: 'same_name',
  name_taken: 'same_name',
  outdated_client: 'version',
  outdated_server: 'version',
  incompatible: 'version',
  banned: 'banned',
  'banned.reason': 'banned',
  ip_banned: 'ip_banned',
  not_whitelisted: 'not_whitelisted',
  server_full: 'server_full',
  kicked: 'kicked',
};

// The version errors E-021 ends an attempt on. They have no code, so the text is all there is; the capture is the
// server's Minecraft version. "Unsupported protocol version" names a protocol number instead, so it captures nothing.
const VERSION_ERRORS = [
  /This server is version ([^\s,]+)/,
  /Server version '([^']+)' is not supported/,
  /No data available for version (\S+)/,
  /Unsupported protocol version/,
];

let language: Record<string, string> | undefined;

/** The English text of a translation key, read from minecraft-data on first use. */
function english(key: string): string | undefined {
  language ??= minecraftData(VERIFIED_VERSION)?.language ?? {};
  return language[key];
}

/** Fills %s and %1$s as Minecraft does; a placeholder without an argument stays as it is. */
function fill(template: string, args: string[]): string {
  let next = 0;
  return template.replace(/%(?:(\d+)\$)?([sd%])/g, (placeholder, index: string | undefined, type: string) => {
    if (type === '%') return '%';
    const position = index ? Number(index) - 1 : next++;
    return position < args.length ? args[position] : placeholder;
  });
}

// Ban texts span several lines ("You are banned from this server.\nReason: …"); events and logs are one line each.
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTranslate(value: Json): boolean {
  if (Array.isArray(value)) return value.some(hasTranslate);
  if (!isObject(value)) return false;
  if (typeof value.translate === 'string') return true;
  return Array.isArray(value.extra) && value.extra.some(hasTranslate);
}

/** Like componentToText, but a translation key becomes its English text instead of "key (args)". */
function render(value: Json): string {
  // Strings inside a parsed component are literal text, not JSON to parse again.
  if (typeof value === 'string') return value;
  if (!hasTranslate(value)) return componentToText(value);
  if (Array.isArray(value)) return value.map(render).join('');
  const node = value as JsonObject;
  let text: string;
  if (typeof node.translate === 'string') {
    const args = Array.isArray(node.with) ? node.with.map(render) : [];
    const template = english(node.translate);
    text = template === undefined ? node.translate : fill(template, args);
  } else {
    text = typeof node.text === 'string' ? node.text : typeof node[''] === 'string' ? node[''] : '';
  }
  if (Array.isArray(node.extra)) text += node.extra.map(render).join('');
  return text;
}

/** A JSON string, network NBT or an object as a component; undefined when the reason is neither. */
function parseReason(reason: unknown): Json | undefined {
  if (typeof reason === 'string') {
    const trimmed = reason.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"'))) return undefined;
    try {
      return JSON.parse(trimmed) as Json;
    } catch {
      return undefined;
    }
  }
  if (typeof reason === 'object' && reason !== null) return simplifyNbt(reason);
  return undefined;
}

interface Kick {
  key?: string;
  text: string;
  args: string[];
}

function readKick(reason: unknown): Kick {
  const component = parseReason(reason);
  if (component === undefined) return { text: String(reason), args: [] };
  // In an array the first element is the parent of the rest.
  const root = Array.isArray(component) ? component[0] : component;
  const text = oneLine(render(component));
  if (root === undefined || !isObject(root) || typeof root.translate !== 'string') return { text, args: [] };
  const args = Array.isArray(root.with) ? root.with.map(arg => oneLine(render(arg))) : [];
  return { key: root.translate, text, args };
}

/**
 * The translation key and plain text of a kick reason (a JSON string at login, network NBT later), for example
 * { key: 'multiplayer.disconnect.kicked', text: 'Kicked by an operator' }.
 */
export function kickInfo(reason: unknown): { key?: string; text: string } {
  const { key, text } = readKick(reason);
  return key === undefined ? { text } : { key, text };
}

let englishPatterns: { kind: FailureKind; pattern: RegExp }[] | undefined;

/** A reason without a key that is word for word the English text of a table key, such as a server that sends plain text. */
function matchEnglish(text: string): { kind: FailureKind; args: string[] } | undefined {
  englishPatterns ??= Object.entries(KEY_KINDS).flatMap(([key, kind]) => {
    const template = english(KEY_PREFIX + key);
    if (template === undefined) return [];
    const parts = oneLine(template).split(/%(?:\d+\$)?s/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return [{ kind, pattern: new RegExp(`^${parts.join('(.+?)')}$`) }];
  });
  for (const { kind, pattern } of englishPatterns) {
    const match = pattern.exec(text);
    if (match) return { kind, args: match.slice(1) };
  }
  return undefined;
}

function versionFromError(message: string): { version?: string } | undefined {
  for (const pattern of VERSION_ERRORS) {
    const match = pattern.exec(message);
    if (match) return { version: match[1] };
  }
  return undefined;
}

/**
 * What went wrong, in words the user can act on, for a failure E-021 recorded (lastFailure) or a kick. Unrecognised
 * reasons keep their raw code and text rather than a guess.
 */
export function explainFailure(failure: Pick<ConnectionFailure, 'code' | 'message' | 'kickReason'>, target: ConnectionTarget): FailureExplanation {
  if (failure.kickReason !== undefined) {
    const kick = readKick(failure.kickReason);
    if (kick.key !== undefined) {
      const kind = kick.key.startsWith(KEY_PREFIX) ? KEY_KINDS[kick.key.slice(KEY_PREFIX.length)] : undefined;
      if (kind === undefined) return { explanation: kick.text, code: kick.key };
      return { kind, explanation: EXPLAIN[kind](target, kick.args), code: kick.key };
    }
    // A /kick with a reason sends only that text; it matches nothing below and stays as it is.
    const matched = matchEnglish(kick.text);
    if (matched) return { kind: matched.kind, explanation: EXPLAIN[matched.kind](target, matched.args), code: kick.text };
    return { explanation: kick.text };
  }

  const message = failure.message;
  const codeKind = failure.code === undefined ? undefined : CODE_KINDS[failure.code];
  if (codeKind !== undefined) {
    // SPAWN_TIMEOUT is this server's own name; the message says what it means.
    return { kind: codeKind, explanation: EXPLAIN[codeKind](target, []), code: failure.code === 'SPAWN_TIMEOUT' ? message : failure.code };
  }
  const versionError = versionFromError(message);
  if (versionError) {
    return { kind: 'version', explanation: EXPLAIN.version(target, versionError.version ? [versionError.version] : []), code: failure.code ?? message };
  }
  // The end of an attempt that had no error before it: the server closed the connection while logging in.
  if (failure.code === undefined && message === 'socketClosed') return { kind: 'closed', explanation: EXPLAIN.closed(target, []), code: message };
  return failure.code === undefined ? { explanation: message } : { explanation: message, code: failure.code };
}
