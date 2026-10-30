// Contract: docs/BLUEPRINT.md F-054 (E-042). The --check self-test: join the world once, check the key, print a report
// on stdout and return the exit code. It never reads OPENROUTER_API_KEY itself: the client does, and the report only
// uses what the client says about it (invariant I4).
import { BotConnection, SUPPORTED_MINECRAFT_VERSION, SUPPORTED_PROTOCOL_VERSION } from './bot-connection.js';
import { explainFailure, type ConnectionTarget } from './connection-errors.js';
import { usernameWarning, type ServerConfig } from './config.js';
import { NO_KEY_REASON, OpenRouterClient, type DecisionHealth } from './decisions/openrouter-client.js';
import { PolicyStore, type Policy } from './autopilot/policy.js';
import { log } from './logger.js';

type ConnectionCallbacks = ConstructorParameters<typeof BotConnection>[1];

/** The part of BotConnection the self-check uses; it never calls checkConnectionAndReconnect, so it connects once. */
export type SelfCheckConnection = Pick<BotConnection, 'connect' | 'getState' | 'getBot' | 'lastFailure' | 'getServerVersion' | 'cleanup'>;

/** The part of OpenRouterClient the self-check uses: whether there is a key, and E-036's check. */
export type SelfCheckDecisionClient = Pick<OpenRouterClient, 'status' | 'checkAccess'>;

/** Only for tests. */
export interface SelfCheckDeps {
  createConnection?: (target: ConnectionTarget, callbacks: ConnectionCallbacks) => SelfCheckConnection;
  createDecisionClient?: (getPolicy: () => Policy, now: () => number) => SelfCheckDecisionClient;
  /** Takes the report; process.stdout by default. */
  write?: (text: string) => void;
  now?: () => number;
}

// As often as checkConnectionAndReconnect looks. E-021's watchdog ends an attempt within CONNECT_TIMEOUT_MS (30 s),
// so the wait always ends.
const POLL_MS = 100;
// What a check that threw is reported as. Its message is not used: only the client removes the key from text (I4).
const CHECK_THREW = 'the check failed';

/** Resolves once the attempt has joined (connected) or ended (disconnected). */
function attemptSettled(connection: SelfCheckConnection): Promise<'connected' | 'disconnected'> {
  return new Promise(resolve => {
    const poll = () => {
      const state = connection.getState();
      if (state === 'connecting') setTimeout(poll, POLL_MS);
      else resolve(state);
    };
    poll();
  });
}

/** Where the bot spawned: whole block coordinates, and the dimension without "minecraft:". */
function spawnPlace(connection: SelfCheckConnection): string {
  const bot = connection.getBot();
  const position = bot?.entity?.position;
  const at = position ? `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})` : 'an unknown place';
  const dimension = (bot?.game as { dimension?: string } | undefined)?.dimension?.replace(/^minecraft:/, '');
  return `${at} in ${dimension || 'an unknown dimension'}`;
}

/** The decision model line (step 6) from the health checkAccess left. */
function decisionLine(model: string, health: DecisionHealth): string {
  if (health.state === 'online') return `OK decision model ${model}: key accepted`;
  if (health.state === 'offline') return `WARN decision model OFFLINE (${health.reason ?? CHECK_THREW})`;
  return `WARN decision model not checked (${health.reason ?? CHECK_THREW})`;
}

/**
 * Runs the self-check of `--check` (E-042) and returns the exit code: 0 when the bot joined the world (WARN lines
 * too), 1 when it could not. Wrong options (2) never get here: parseConfig has already failed on them. Every line of
 * the report starts with OK, WARN or FAIL, and the last one with Ready or Not ready.
 */
export async function runSelfCheck(config: ServerConfig, deps: SelfCheckDeps = {}): Promise<number> {
  const write = deps.write ?? (text => { process.stdout.write(text); });
  const now = deps.now ?? Date.now;
  const report = (line: string) => write(`${line}\n`);
  // Only these three: no greeting, so the bot says nothing in chat even with --greeting (E-034).
  const target: ConnectionTarget = { host: config.host, port: config.port, username: config.username };

  const policy = new PolicyStore({ decisionModel: config.decisionModel });
  const createDecisionClient = deps.createDecisionClient ?? ((getPolicy, clock) => new OpenRouterClient({ getPolicy, now: clock }));
  const decisions = createDecisionClient(() => policy.get(), now);
  const hasKey = decisions.status().configured;
  // Started together with the connection, so the whole check ends with the 30 s watchdog at the latest, not after it.
  // Without a key nothing is sent.
  const access: Promise<DecisionHealth> | null = hasKey
    ? Promise.resolve().then(() => decisions.checkAccess()).catch(() => ({ state: 'unchecked' as const, reason: CHECK_THREW }))
    : null;

  // The connection event of the join, which carries E-030's sentence when the server runs another version.
  let joinedEvent = null as string | null;
  const callbacks: ConnectionCallbacks = {
    onLog: log,
    onChatMessage: () => {},
    onEvent: (type, message) => {
      if (type === 'connection') joinedEvent = message;
    }
  };
  const connection = (deps.createConnection ?? ((to, on) => new BotConnection(to, on)))(target, callbacks);

  let joined = false;
  try {
    connection.connect();
    joined = (await attemptSettled(connection)) === 'connected';

    const at = `${target.host}:${target.port}`;
    let notReady = '';
    if (joined) {
      report(`OK joined ${at} as ${target.username} (offline account); spawned at ${spawnPlace(connection)}`);
    } else {
      // Every attempt that ends before spawning has a record (E-021); a bot that left right after spawning may not.
      const { explanation, code } = explainFailure(connection.lastFailure() ?? { message: 'socketClosed' }, target);
      report(`FAIL Cannot connect to Minecraft server at ${at}: ${explanation}${code === undefined ? '' : ` (${code})`}`);
      notReady = explanation;
    }

    const warning = usernameWarning(target.username);
    if (warning) report(`WARN ${warning}`);

    // The only line about the version. As E-030 judges it: without a version number in the name, only the protocol.
    const server = joined ? connection.getServerVersion() : null;
    if (server) {
      const otherProtocol = server.protocol !== null && server.protocol !== SUPPORTED_PROTOCOL_VERSION;
      const otherVersion = server.version !== null && server.version !== SUPPORTED_MINECRAFT_VERSION;
      if (!otherProtocol && !otherVersion) report(`OK Minecraft ${SUPPORTED_MINECRAFT_VERSION} (protocol ${SUPPORTED_PROTOCOL_VERSION})`);
      else if (joinedEvent) report(`WARN ${joinedEvent}`);
    }

    report(hasKey
      ? 'OK OPENROUTER_API_KEY is set'
      : 'WARN OPENROUTER_API_KEY is not set: the instinct will be offline and the bot will not react to dangers by itself');

    let offline: string | null = hasKey ? null : NO_KEY_REASON;
    if (access) {
      const health = await access;
      report(decisionLine(policy.get().decisions.model, health));
      if (health.state === 'offline') offline = health.reason ?? CHECK_THREW;
    }

    report(joined
      ? `Ready: use the same --host, --port and --username in your MCP client config${offline === null ? '' : `; the instinct is offline (${offline})`}`
      : `Not ready: ${notReady}`);
  } finally {
    try {
      connection.cleanup();
    } catch {
      // The report is written; leaving the world is all that is left.
    }
  }
  return joined ? 0 : 1;
}
