import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { formatStat } from './format.js';
import { componentToText } from './text-component.js';
import type { MessageKind } from './message-store.js';
import { serverRegistryName, trackServerRegistries } from './server-registries.js';
import { describeOffset } from './tools/terrain-utils.js';
import { configureMovements, installDoorHelper } from './tools/movement-utils.js';

const SUPPORTED_MINECRAFT_VERSION = '26.1.2';

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

interface BotConfig {
  host: string;
  port: number;
  username: string;
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
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs: number;

  constructor(config: BotConfig, callbacks: ConnectionCallbacks, reconnectDelayMs = 2000) {
    this.config = config;
    this.callbacks = callbacks;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  getState(): ConnectionState {
    return this.state;
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

    this.bot = mineflayer.createBot(botOptions);
    this.state = 'connecting';
    this.isReconnecting = false;

    this.registerEventHandlers(this.bot);
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    bot.once('spawn', async () => {
      this.state = 'connected';
      this.callbacks.onLog('info', 'Bot spawned in world');

      const mcData = minecraftData(bot.version);
      const defaultMove = new Movements(bot, mcData);
      configureMovements(defaultMove as never);
      bot.pathfinder.setMovements(defaultMove);
      installDoorHelper(bot);

      bot.chat('LLM-powered bot ready to receive instructions!');
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
      this.callbacks.onEvent?.('kicked', this.formatError(reason));
      this.callbacks.onLog('error', `Bot was kicked from server: ${this.formatError(reason)}`);
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const errorCode = (err as { code?: string }).code || 'Unknown error';
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.callbacks.onLog('error', `Bot error [${errorCode}]: ${errorMsg}`);

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', (reason) => {
      this.callbacks.onEvent?.('disconnected', this.formatError(reason));
      this.callbacks.onBotEnd?.(this.formatError(reason));
      this.callbacks.onLog('info', `Bot disconnected: ${this.formatError(reason)}`);

      if (this.state === 'connected') {
        this.state = 'disconnected';
      }

      if (this.bot === bot) {
        try {
          bot.removeAllListeners();
          this.bot = null;
          this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
        } catch (err) {
          this.callbacks.onLog('warn', `Error cleaning up bot on end event: ${this.formatError(err)}`);
        }
      }
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
        try {
          this.bot.removeAllListeners();
          this.bot.quit('Reconnecting...');
          this.callbacks.onLog('info', 'Old bot instance cleaned up');
        } catch (err) {
          this.callbacks.onLog('warn', `Error while cleaning up old bot: ${this.formatError(err)}`);
        }
      }

      this.callbacks.onLog('info', 'Creating new bot instance...');
      this.connect();
    }, this.reconnectDelayMs);
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    const currentState = this.state;

    if (currentState === 'disconnected') {
      this.attemptReconnect();

      const maxWaitTime = this.reconnectDelayMs + 5000;
      const pollInterval = 100;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        if (this.state === 'connected') {
          return { connected: true };
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      const errorMessage =
        `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}\n\n` +
        `Please ensure:\n` +
        `1. Minecraft server is running on ${this.config.host}:${this.config.port}\n` +
        `2. Server is accessible from this machine\n` +
        `3. Server version is compatible (latest supported: ${SUPPORTED_MINECRAFT_VERSION})\n\n` +
        `For setup instructions, visit: https://github.com/yuniko-software/minecraft-mcp-server`;

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
    if (this.bot) {
      try {
        this.bot.quit('Server shutting down');
      } catch (err) {
        this.callbacks.onLog('warn', `Error during cleanup: ${this.formatError(err)}`);
      }
    }
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
