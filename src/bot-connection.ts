import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { formatStat } from './format.js';
import { componentToText } from './text-component.js';
import { explainFailure, kickInfo, type FailureKind } from './connection-errors.js';
import type { MessageKind } from './message-store.js';
import { serverRegistryName, trackServerRegistries } from './server-registries.js';
import { describeOffset, wokeUpInsideBlock } from './tools/terrain-utils.js';
import { configureMovements, installDoorHelper } from './tools/movement-utils.js';
import { fixToolMaterials } from './tools/block-utils.js';

/** The Minecraft version the bot is tested with; the connection errors and the startup line name it (E-024). */
export const SUPPORTED_MINECRAFT_VERSION = '26.1.2';
/** Its protocol. 26.1 and 26.1.1 have it too, so only the version name in the server's ping tells them apart (E-030). */
export const SUPPORTED_PROTOCOL_VERSION = 775;
// The version number in the ping's version name: "26.1.2", "Paper 26.1.2" (E-030).
const VERSION_NUMBER = /\d+\.\d+(\.\d+)?/;
/** How long an attempt may take to spawn before it counts as failed (E-021). */
export const CONNECT_TIMEOUT_MS = 30_000;
// The server moves the player off the bed right after waking; look at where the head ended up after that (E-014).
const WAKE_CHECK_DELAY_MS = 1000;

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

/** Why the latest attempt failed before spawning, or why the bot was kicked (E-021); E-028 explains it to the user. */
export interface ConnectionFailure {
  /** The error code (ENOTFOUND), SPAWN_TIMEOUT for the watchdog; absent for an error without one and for an end. */
  code?: string;
  message: string;
  /** The kick reason as the server sent it (JSON text or NBT). */
  kickReason?: unknown;
  time: number;
}

/** What the server's ping response says about its version (E-030); E-042's --check reads it too. */
export interface ServerVersion {
  /** version.name as the server sent it: "26.1.2", "Paper 26.1.2"; null when it sent none. */
  name: string | null;
  /** version.protocol; null when it sent none. */
  protocol: number | null;
  /** The version number in the name ("26.1.2" for "Paper 26.1.2"); null when the name has none. */
  version: string | null;
}

type CreateBot = (options: mineflayer.BotOptions) => mineflayer.Bot;

// minecraft-protocol calls these with the ping response before it lets the login go on (autoVersion.js). The client
// does not declare the array, and only reads it when it exists.
type AutoVersionHook = (response: unknown, client: unknown, options: unknown) => void;

/** One instance's end (E-029). A promise rather than a listener on the bot, which removeAllListeners would remove. */
interface EndSignal {
  readonly ended: Promise<string>;
  resolve(reason: string): void;
  /** The kick reason as plain text; it says more than the end that follows the kick. */
  kick?: string;
}

// Socket failures end the attempt at once. mineflayer sends an end as well, but before or after the error depending
// on how the socket failed, and the state used to stay at connecting when the end came first (E-021).
const ATTEMPT_ENDING_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE']);
// Version failures arrive as an error without a code and with no end after it; the socket stays open (E-021).
const VERSION_FAILURE = /Unsupported protocol version|No data available for version|Server version '.*' is not supported|This server is version/;

function endsAttempt(failure: { code?: string; message: string }): boolean {
  return (failure.code !== undefined && ATTEMPT_ENDING_CODES.has(failure.code)) || VERSION_FAILURE.test(failure.message);
}

// Kicks whose text does not say what to do get the explanation after it in the kicked event (E-028). "Kicked by an
// operator" and "The server is full!" say enough by themselves.
const EXPLAINED_KICKS: ReadonlySet<FailureKind> = new Set<FailureKind>(['online_mode', 'same_name', 'version', 'not_whitelisted', 'banned', 'ip_banned']);
const SETUP_LINE = 'For setup instructions, visit: https://github.com/yxengram/minecraft-mcp-server#getting-started';

interface BotConfig {
  host: string;
  port: number;
  username: string;
  /** Said in chat when an instance first spawns (--greeting, E-034); without it the bot says nothing when it joins. */
  greeting?: string;
}

interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
  onEvent?: (type: string, message: string) => void;
  onSystemMessage?: (kind: Exclude<MessageKind, 'chat'>, text: string) => void;
  /** The bot spawned for the first time after (re)connecting. */
  onBotReady?: (bot: mineflayer.Bot) => void;
  /** The bot left the game. */
  onBotEnd?: (reason: string) => void;
  /** A player whispered to the bot (BLUEPRINT E-005). */
  onWhisper?: (username: string, message: string) => void;
  /** The bot took damage; attackerId is the entity that caused it, if any (BLUEPRINT E-005). */
  onDamage?: (info: { attackerId?: number; type: string; time: number }) => void;
}

const SOUND_RADIUS = 32;
const SOUND_SOURCE_RADIUS = 2;
const SOUND_REPEAT_MS = 5000;
const LOUD_VOLUME = 2;
// Sound packets store coordinates multiplied by 8.
const SOUND_POSITION_SCALE = 8;

type SoundPacket = {
  sound?: { soundId?: number; data?: { soundName?: string } };
  soundCategory?: string;
  volume?: number;
  x?: number; y?: number; z?: number;
  entityId?: number;
};

// Damage events arrive just before the matching health update.
const DAMAGE_SOURCE_WINDOW_MS = 1500;

type BotEntityLike = { id: number; username?: string; displayName?: string; name?: string; type?: string };

function describeDamager(entity: BotEntityLike | undefined): string | undefined {
  if (!entity) return undefined;
  return `${entity.username || entity.name || entity.displayName || entity.type || 'unknown'} (id ${entity.id})`;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  // The latest damage to the bot, kept for the death report of a command that was running (E-018).
  private latestDamage: { description: string; time: number } | null = null;
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // An attempt that is never answered sends no event at all, so only a timer can end it (E-021).
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: ConnectionFailure | null = null;
  // The instance whose attempt already has a record: the first error or kick of an attempt says the most.
  private failureRecordedFor: mineflayer.Bot | null = null;
  private readonly endSignals = new WeakMap<mineflayer.Bot, EndSignal>();
  // The current attempt's server version, from its ping response (E-030).
  private serverVersion: ServerVersion | null = null;
  // The version warning of the latest join, until a tool reply takes it (E-030).
  private joinNote: { bot: mineflayer.Bot; text: string } | null = null;
  private readonly reconnectDelayMs: number;
  private readonly createBot: CreateBot;

  /** options.createBot is only for tests (E-021). */
  constructor(config: BotConfig, callbacks: ConnectionCallbacks, reconnectDelayMs = 2000, options: { createBot?: CreateBot } = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.reconnectDelayMs = reconnectDelayMs;
    this.createBot = options.createBot ?? (botOptions => mineflayer.createBot(botOptions));
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  /** What last hurt the bot ("lava", "mob_attack from zombie (id 12)"), and when. */
  lastDamage(): { description: string; time: number } | null {
    return this.latestDamage;
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** Why the latest attempt failed or the bot was kicked; cleared when the bot spawns (E-021). */
  lastFailure(): Readonly<ConnectionFailure> | null {
    return this.failure;
  }

  /** The server's version from the current attempt's ping response, or null before it arrives (E-030). */
  getServerVersion(): Readonly<ServerVersion> | null {
    return this.serverVersion;
  }

  /**
   * The warning that the server runs another Minecraft version, once per join (E-030): the tool factory adds it to the
   * first reply after the bot joined. Null when the versions match, when a reply already took it, or once the bot that
   * joined is no longer in the game.
   */
  takeJoinNote(): string | null {
    const note = this.joinNote;
    this.joinNote = null;
    return note && note.bot === this.bot && this.state === 'connected' ? note.text : null;
  }

  /**
   * Resolves with why `bot` left the game (E-029): the kick text when it was kicked, otherwise the end's reason. It
   * resolves when the instance is let go: in the end handler after onBotEnd, when an attempt fails, when a reconnect
   * replaces it and at cleanup. Letting go removes all of the bot's listeners, so a body command waiting for a goto
   * or a dig would never hear back; this tells it to return.
   */
  whenEnded(bot: mineflayer.Bot): Promise<string> {
    return this.endSignal(bot).ended;
  }

  private endSignal(bot: mineflayer.Bot): EndSignal {
    let signal = this.endSignals.get(bot);
    if (!signal) {
      let resolve: (reason: string) => void = () => {};
      // The executor runs at once, so resolve is the promise's own by the next line.
      const ended = new Promise<string>(settle => { resolve = settle; });
      signal = { ended, resolve };
      this.endSignals.set(bot, signal);
    }
    return signal;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      plugins: { pathfinder },
    };

    this.clearConnectTimer();
    // A new attempt may reach a server that has changed since the last join (E-030).
    this.serverVersion = null;
    this.joinNote = null;
    let bot: mineflayer.Bot;
    try {
      bot = this.createBot(botOptions);
    } catch (err) {
      // Left at connecting, or with isReconnecting set, attemptReconnect would never try again (E-021).
      this.bot = null;
      this.failure = { code: (err as { code?: string }).code, message: err instanceof Error ? err.message : String(err), time: Date.now() };
      this.failureRecordedFor = null;
      this.state = 'disconnected';
      this.isReconnecting = false;
      this.callbacks.onLog('error', `Could not create the bot: ${this.failure.message}`);
      return;
    }
    this.bot = bot;
    this.state = 'connecting';
    this.isReconnecting = false;

    this.watchServerVersion(bot);
    this.registerEventHandlers(bot);
    this.connectTimer = setTimeout(() => {
      this.failAttempt(bot, { code: 'SPAWN_TIMEOUT', message: `no spawn within ${CONNECT_TIMEOUT_MS / 1000} s` });
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /**
   * Records the version name and protocol of the server's ping response (E-030). bot.version cannot tell 26.1, 26.1.1
   * and 26.1.2 apart: all three are protocol 775 and the data version "26.1". The ping arrives after createBot has
   * returned, so the hook is in place in time. A stand-in without _client is skipped.
   */
  private watchServerVersion(bot: mineflayer.Bot): void {
    const client = (bot as unknown as { _client?: { autoVersionHooks?: AutoVersionHook[] } })._client;
    if (!client) return;
    client.autoVersionHooks ??= [];
    client.autoVersionHooks.push(response => {
      // The login goes on right after the hooks; a throw here would stall it until the watchdog.
      try {
        if (this.bot !== bot) return;
        const version = (response as { version?: { name?: unknown; protocol?: unknown } } | null | undefined)?.version;
        const name = typeof version?.name === 'string' && version.name.trim() !== '' ? version.name : null;
        const protocol = typeof version?.protocol === 'number' ? version.protocol : null;
        if (name === null && protocol === null) return;
        this.serverVersion = { name, protocol, version: name?.match(VERSION_NUMBER)?.[0] ?? null };
      } catch (err) {
        this.callbacks.onLog('warn', `Could not read the server version: ${this.formatError(err)}`);
      }
    });
  }

  /**
   * At a join (E-030): a connection event, and when the server is not 26.1.2, a warning on stderr and for the first
   * tool reply. The bot stays in: other versions may still work. Without a version name only the protocol counts;
   * with no ping data at all (a stand-in) there is nothing to judge.
   */
  private checkServerVersion(bot: mineflayer.Bot): void {
    const server = this.serverVersion;
    if (!server) return;
    const { host, port, username } = this.config;
    const joined = `Joined ${host}:${port} as ${username}`;
    const otherProtocol = server.protocol !== null && server.protocol !== SUPPORTED_PROTOCOL_VERSION;
    const otherVersion = server.version !== null && server.version !== SUPPORTED_MINECRAFT_VERSION;
    if (!otherProtocol && !otherVersion) {
      this.callbacks.onEvent?.('connection', `${joined} (Minecraft ${SUPPORTED_MINECRAFT_VERSION})`);
      return;
    }
    // Without a number in the name, the version mineflayer took the protocol for.
    const runs = `Minecraft ${server.version ?? bot.version}${server.protocol === null ? '' : ` (protocol ${server.protocol})`}`;
    const text = `${joined}; the server runs ${runs}; this bot is verified only with ${SUPPORTED_MINECRAFT_VERSION}, so some tools may misbehave`;
    this.callbacks.onLog('warn', text);
    this.callbacks.onEvent?.('connection', text);
    this.joinNote = { bot, text };
  }

  /** Keeps the first record of the current instance's attempt; events of an instance already let go are ignored. */
  private recordFailure(bot: mineflayer.Bot, failure: Omit<ConnectionFailure, 'time'>): void {
    if (this.bot !== bot || this.failureRecordedFor === bot) return;
    this.failure = { ...failure, time: Date.now() };
    this.failureRecordedFor = bot;
  }

  /**
   * Ends an attempt that failed before the bot spawned (E-021), so the next tool call reconnects instead of
   * replying "please wait" until the client restarts. onBotEnd is not called: the Autopilot binds only at spawn.
   */
  private failAttempt(bot: mineflayer.Bot, failure: Omit<ConnectionFailure, 'time'>): void {
    if (this.bot !== bot) return;
    this.clearConnectTimer();
    this.recordFailure(bot, failure);
    this.state = 'disconnected';
    this.bot = null;
    this.releaseBot(bot, failure.message, 'Connection attempt failed');

    const recorded = this.failure ?? { ...failure, time: Date.now() };
    const detail = recorded.code && !recorded.message.includes(recorded.code) ? `${recorded.code}: ${recorded.message}` : recorded.message;
    this.callbacks.onEvent?.('disconnected', `Could not join ${this.config.host}:${this.config.port}: ${detail}`);
    this.callbacks.onLog('error', `Connection attempt failed before spawn: ${detail}`);
  }

  /**
   * Lets go of an instance. The no-op error listener stays because ping can report a second error after the other
   * listeners are gone, and an error nobody listens to is thrown. bot.end rather than bot.quit: quit comes with the
   * kick plugin, which is not loaded before inject_allowed (E-021). `endedBecause` is what whenEnded resolves with,
   * unless the bot was kicked (E-029); `reason` goes to bot.end.
   */
  private releaseBot(bot: mineflayer.Bot, endedBecause: string, reason?: string): void {
    bot.removeAllListeners();
    bot.on('error', () => {});
    try {
      bot.end(reason);
    } catch (err) {
      this.callbacks.onLog('warn', `Error while letting go of the bot: ${this.formatError(err)}`);
    }
    const signal = this.endSignal(bot);
    signal.resolve(signal.kick ?? endedBecause);
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    // Before the first spawn, failures end the attempt (E-021); after it, they keep their old handling.
    let spawned = false;

    bot.once('spawn', async () => {
      // First, so that a throw in the setup below cannot leave the watchdog running.
      spawned = true;
      this.clearConnectTimer();
      this.failure = null;
      this.failureRecordedFor = null;
      this.state = 'connected';
      this.callbacks.onLog('info', 'Bot spawned in world');
      // Before the setup, which an unsupported version is the likeliest to break (E-030).
      this.checkServerVersion(bot);

      // Before anything estimates a dig: the shared block data understates pickaxe speed for 108 blocks (E-017).
      fixToolMaterials(bot.registry as never);
      const mcData = minecraftData(bot.version);
      const defaultMove = new Movements(bot, mcData);
      configureMovements(defaultMove as never);
      bot.pathfinder.setMovements(defaultMove);
      installDoorHelper(bot);

      // Once per instance, so again after a reconnect but not on a respawn. No public greeting by default (E-034).
      if (this.config.greeting) bot.chat(this.config.greeting);
      this.callbacks.onBotReady?.(bot);
      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onChatMessage(username, message);
    });

    bot.on('whisper', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onEvent?.('whisper', `${username}: ${message}`);
      this.callbacks.onWhisper?.(username, message);
    });

    bot.on('spawn', () => {
      const { x, y, z } = bot.entity.position;
      this.callbacks.onEvent?.('spawn', `Bot spawned at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)})`);
    });

    bot.on('death', () => {
      this.callbacks.onEvent?.('death', 'Bot died');
    });

    // Also when the server wakes the bot in the morning: with no free spot next to the bed it stands the bot on the
    // bed, where a low ceiling suffocates it. Only reported; moving the bot needs a lease (G1).
    bot.on('wake', () => {
      setTimeout(() => {
        if (this.bot !== bot) return;
        const problem = wokeUpInsideBlock(bot);
        if (problem) this.callbacks.onEvent?.('woke_up', problem);
      }, WAKE_CHECK_DELAY_MS);
    });

    trackServerRegistries(bot);
    let lastDamage: { description: string; time: number } | null = null;

    bot._client.on('damage_event', (packet: { entityId: number; sourceTypeId: number; sourceCauseId: number; sourceDirectId: number }) => {
      if (!bot.entity || packet.entityId !== bot.entity.id) return;
      const type = serverRegistryName(bot, 'damage_type', packet.sourceTypeId) ?? `damage type ${packet.sourceTypeId}`;
      const entities = bot.entities as Record<number, BotEntityLike | undefined>;
      const cause = describeDamager(entities[packet.sourceCauseId - 1]);
      const direct = packet.sourceDirectId !== packet.sourceCauseId ? entities[packet.sourceDirectId - 1] : undefined;
      let description = type;
      if (cause) description += ` from ${cause}`;
      if (direct) description += ` via ${direct.name ?? direct.type ?? 'projectile'}`;
      lastDamage = { description, time: Date.now() };
      this.latestDamage = lastDamage;
      // The cause id is the attacker's entity id + 1, or 0 when nothing caused it (fall, fire, drowning).
      this.callbacks.onDamage?.({ attackerId: packet.sourceCauseId > 0 ? packet.sourceCauseId - 1 : undefined, type, time: lastDamage.time });
    });

    let lastHealth = bot.health;
    bot.on('health', () => {
      if (typeof lastHealth === 'number' && bot.health < lastHealth) {
        const source = lastDamage && Date.now() - lastDamage.time < DAMAGE_SOURCE_WINDOW_MS ? ` (${lastDamage.description})` : '';
        this.callbacks.onEvent?.('damaged', `Health dropped from ${formatStat(lastHealth)} to ${formatStat(bot.health)}${source}`);
        lastDamage = null;
      }
      lastHealth = bot.health;
    });

    // Sound ids cannot be mapped to names reliably on every version, so describe sounds by category and source;
    // packets that carry an explicit sound name keep it.
    const lastSoundAt = new Map<string, number>();
    const reportSound = (packet: SoundPacket, position: { x: number; y: number; z: number } | undefined, source?: BotEntityLike) => {
      if (!bot.entity || !position || source === (bot.entity as unknown as BotEntityLike)) return;
      const name = packet.sound?.data?.soundName?.replace(/^minecraft:/, '');
      const category = packet.soundCategory ?? 'unknown';
      const volume = packet.volume ?? 1;
      const loud = volume >= LOUD_VOLUME;
      if (!name && category !== 'hostile' && !loud) return;

      const dx = position.x - bot.entity.position.x;
      const dz = position.z - bot.entity.position.z;
      const distance = Math.hypot(dx, position.y - bot.entity.position.y, dz);
      if (distance > SOUND_RADIUS * Math.max(1, volume)) return;

      const key = `${source?.id ?? `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`}:${name ?? category}`;
      const now = Date.now();
      if (now - (lastSoundAt.get(key) ?? 0) < SOUND_REPEAT_MS) return;
      lastSoundAt.set(key, now);

      const what = name ?? (category === 'weather' ? 'thunder or weather sound' : `${category} sound`);
      const from = describeDamager(source);
      this.callbacks.onEvent?.('sound', `${what}${from ? ` from ${from}` : ''}, ${describeOffset(Math.round(dx), Math.round(dz), Math.round(position.y - bot.entity.position.y))}${loud ? ' (loud)' : ''}`);
    };

    const nearestEntityTo = (position: { x: number; y: number; z: number }) => {
      let best: BotEntityLike | undefined;
      let bestDistance = SOUND_SOURCE_RADIUS;
      for (const entity of Object.values(bot.entities ?? {})) {
        if (entity === bot.entity || !entity.position) continue;
        const distance = entity.position.distanceTo(position as never);
        if (distance <= bestDistance) {
          best = entity as unknown as BotEntityLike;
          bestDistance = distance;
        }
      }
      return best;
    };

    bot._client.on('sound_effect', (packet: SoundPacket) => {
      if (typeof packet.x !== 'number' || typeof packet.y !== 'number' || typeof packet.z !== 'number') return;
      const position = { x: packet.x / SOUND_POSITION_SCALE, y: packet.y / SOUND_POSITION_SCALE, z: packet.z / SOUND_POSITION_SCALE };
      reportSound(packet, position, nearestEntityTo(position));
    });

    bot._client.on('entity_sound_effect', (packet: SoundPacket) => {
      const entity = typeof packet.entityId === 'number' ? bot.entities?.[packet.entityId] : undefined;
      reportSound(packet, entity?.position, entity as unknown as BotEntityLike | undefined);
    });

    bot._client.on('explosion', (packet: { center?: { x: number; y: number; z: number }; x?: number; y?: number; z?: number }) => {
      if (!bot.entity) return;
      const center = packet.center ?? (typeof packet.x === 'number' ? { x: packet.x, y: packet.y ?? 0, z: packet.z ?? 0 } : undefined);
      if (!center) return;
      const dx = Math.round(center.x - bot.entity.position.x);
      const dz = Math.round(center.z - bot.entity.position.z);
      const dy = Math.round(center.y - bot.entity.position.y);
      this.callbacks.onEvent?.('explosion', `Explosion at (${Math.floor(center.x)}, ${Math.floor(center.y)}, ${Math.floor(center.z)}), ${describeOffset(dx, dz, dy)}`);
    });

    const forwardSystemMessage = (kind: Exclude<MessageKind, 'chat'>, text: string) => {
      const trimmed = text.trim();
      if (trimmed) this.callbacks.onSystemMessage?.(kind, trimmed);
    };

    bot.on('message', (message, position) => {
      if (position === 'chat') return;
      forwardSystemMessage(position === 'game_info' ? 'action_bar' : 'system', message.toString());
    });

    bot.on('title', (text: unknown, type: string) => {
      forwardSystemMessage(type === 'subtitle' ? 'subtitle' : 'title', componentToText(text));
    });

    // Newer protocols send the action bar as its own packet, which mineflayer does not surface.
    bot._client.on('action_bar', (packet: { text?: unknown }) => {
      forwardSystemMessage('action_bar', componentToText(packet.text));
    });

    bot.on('playerJoined', (player) => {
      if (player.username === bot.username) return;
      this.callbacks.onEvent?.('player_joined', `${player.username} joined the game`);
    });

    bot.on('playerLeft', (player) => {
      if (player.username === bot.username) return;
      this.callbacks.onEvent?.('player_left', `${player.username} left the game`);
    });

    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity) return;
      try {
        const item = collected.getDroppedItem();
        if (item) {
          this.callbacks.onEvent?.('item_picked_up', `Picked up ${item.count} ${item.name}`);
        }
      } catch {
        // Item metadata may not be available yet; skip the event.
      }
    });

    // mineflayer only updates bot.vehicle when the bot is listed as a passenger, so it never notices
    // dismounting on protocols where the server answers with an empty passenger list.
    bot._client.on('set_passengers', (packet: { entityId: number; passengers: number[] }) => {
      const vehicle = (bot as unknown as { vehicle?: { id: number } | null }).vehicle;
      if (vehicle && packet.entityId === vehicle.id && !packet.passengers.includes(bot.entity.id)) {
        (bot as unknown as { vehicle: null }).vehicle = null;
        bot.emit('dismount', vehicle as never);
      }
    });

    bot.on('kicked', (reason) => {
      // The message stays raw: the disconnected event of a kick during login is built from it (E-021).
      this.recordFailure(bot, { message: this.formatError(reason), kickReason: reason });
      const { text } = kickInfo(reason);
      // A body command running now returns with this text once the end comes (E-029), not with the end's reason. An
      // empty kick text says nothing, so the end's reason is used then.
      if (text) this.endSignal(bot).kick ??= text;
      const description = this.describeKick(reason, text);
      this.callbacks.onEvent?.('kicked', description);
      this.callbacks.onLog('error', `Bot was kicked from server: ${description}`);
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const errorCode = (err as { code?: string }).code || 'Unknown error';
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.callbacks.onLog('error', `Bot error [${errorCode}]: ${errorMsg}`);

      if (!spawned) {
        // Other errors may still be followed by an end or a kick; until then they wait in lastFailure.
        const failure = { code: (err as { code?: string }).code, message: errorMsg };
        if (endsAttempt(failure)) this.failAttempt(bot, failure);
        else this.recordFailure(bot, failure);
        return;
      }

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', (reason) => {
      // A late end from an older instance must not touch the state of the newer one.
      if (this.bot !== bot) return;
      if (!spawned) {
        // An earlier error or kick of this attempt says more than "socketClosed"; recordFailure keeps it.
        this.failAttempt(bot, { message: typeof reason === 'string' ? reason : this.formatError(reason) });
        return;
      }

      this.callbacks.onEvent?.('disconnected', this.formatError(reason));
      this.callbacks.onBotEnd?.(this.formatError(reason));
      this.callbacks.onLog('info', `Bot disconnected: ${this.formatError(reason)}`);

      if (this.state === 'connected') {
        this.state = 'disconnected';
      }

      this.bot = null;
      // After onBotEnd, so a body command that returns now finds the Autopilot unbound (E-029).
      this.releaseBot(bot, typeof reason === 'string' ? reason : this.formatError(reason));
      this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
    });
  }

  attemptReconnect(): void {
    if (this.isReconnecting || this.state === 'connecting') {
      return;
    }

    this.isReconnecting = true;
    this.state = 'connecting';
    this.callbacks.onLog('info', `Attempting to reconnect to Minecraft server in ${this.reconnectDelayMs}ms...`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.bot) {
        this.releaseBot(this.bot, 'replaced by a new connection', 'Reconnecting...');
        this.callbacks.onLog('info', 'Old bot instance cleaned up');
      }

      this.callbacks.onLog('info', 'Creating new bot instance...');
      this.connect();
    }, this.reconnectDelayMs);
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    const currentState = this.state;

    if (currentState === 'disconnected') {
      // Every record made from here on belongs to the attempt this call starts; an older one says nothing about it.
      const earlierFailure = this.failure;
      this.attemptReconnect();

      const maxWaitTime = this.reconnectDelayMs + 5000;
      const pollInterval = 100;
      const startTime = Date.now();
      // An error outside E-021's list is recorded while the attempt goes on, so the state has to say it ended too.
      const failureOfThisAttempt = () => (this.state === 'disconnected' && this.failure !== earlierFailure ? this.failure : null);

      while (Date.now() - startTime < maxWaitTime) {
        if (this.state === 'connected') {
          return { connected: true };
        }
        // Reply as soon as the attempt has failed, with the reason, instead of waiting out the full time (E-028).
        const failure = failureOfThisAttempt();
        if (failure) return { connected: false, message: this.describeFailure(failure) };
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      const failure = failureOfThisAttempt();
      if (failure) return { connected: false, message: this.describeFailure(failure) };

      // Neither joined nor failed yet, for example still in the handshake: only the general checklist is known.
      const errorMessage =
        `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}\n\n` +
        `Please ensure:\n` +
        `1. Minecraft server is running on ${this.config.host}:${this.config.port}\n` +
        `2. Server is accessible from this machine\n` +
        `3. Server version is compatible (latest supported: ${SUPPORTED_MINECRAFT_VERSION})\n\n` +
        SETUP_LINE;

      return { connected: false, message: errorMessage };
    }

    if (currentState === 'connecting') {
      return { connected: false, message: 'Bot is connecting to the Minecraft server. Please wait a moment and try again.' };
    }

    return { connected: true };
  }

  cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.clearConnectTimer();
    if (this.bot) {
      this.releaseBot(this.bot, 'the MCP server is shutting down', 'Server shutting down');
    }
  }

  /** The reply when this call's attempt failed: the usual first line, then what went wrong and what to do (E-028). */
  private describeFailure(failure: Readonly<ConnectionFailure>): string {
    const { explanation, code } = explainFailure(failure, this.config);
    return `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}: ${explanation}${code === undefined ? '' : ` (${code})`}\n\n${SETUP_LINE}`;
  }

  /** The kick reason as plain text rather than JSON or NBT, so the LLM can read it in get-events (E-028). */
  private describeKick(reason: unknown, text: string): string {
    const { kind, explanation } = explainFailure({ message: text, kickReason: reason }, this.config);
    return kind !== undefined && EXPLAINED_KICKS.has(kind) ? `${text}: ${explanation}` : text;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
