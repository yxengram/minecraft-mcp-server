import { z } from "zod";
import type mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { EventStore, GameEvent } from '../event-store.js';
import { formatStat, UNTRUSTED_PLAYER_TEXT } from '../format.js';
import { describeEntity, findNearbyEntities } from './entity-utils.js';

const WAIT_POLL_MS = 250;
const DEFAULT_WAIT_MS = 30000;
// MCP clients usually give up on a request after 60 seconds.
const MAX_WAIT_MS = 55000;

function formatEvents(events: GameEvent[]): string {
  return events
    .map(event => `#${event.id} ${new Date(event.timestamp).toISOString()} [${event.type}] ${event.message}`)
    .join('\n');
}

export function registerEventTools(factory: ToolFactory, eventStore: EventStore, getBot?: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-events",
    `Get recent game events (chat, death, damage taken, item pickups, players joining/leaving, kicks, disconnects). Pass the returned 'nextSince' as 'since' to read only new events. ${UNTRUSTED_PLAYER_TEXT}`,
    {
      since: z.coerce.number().int().min(0).optional().describe("Only return events with an id greater than this (default: 0, returns the latest events)"),
      types: z.array(z.string()).optional().describe("Only return these event types, e.g. ['death', 'damaged']"),
      limit: z.coerce.number().int().min(1).max(100).optional().describe("Maximum number of events to return (default: 20, max: 100)")
    },
    async ({ since = 0, types, limit = 20 }) => {
      const { events, nextSince, dropped } = eventStore.query({ since, types, limit });

      let output = events.length === 0
        ? "No new events"
        : `Found ${events.length} event(s):\n\n${formatEvents(events)}`;

      if (dropped) {
        output += "\n\nWarning: some events were dropped because the buffer overflowed since 'since'";
      }
      output += `\n\nnextSince: ${nextSince}`;

      return factory.createResponse(output);
    }
  );

  if (!getBot) return;

  factory.registerTool(
    "wait-for-event",
    `Wait until something happens instead of polling: a new game event (optionally only certain types), a hostile mob coming close, or health dropping low. Returns as soon as one condition is met, or after the timeout (max ${MAX_WAIT_MS / 1000}s). ${UNTRUSTED_PLAYER_TEXT}`,
    {
      types: z.array(z.string()).optional().describe("Event types to wait for, e.g. ['chat', 'damaged', 'sound', 'death'] (default: any event)"),
      hostileWithin: z.coerce.number().finite().positive().optional().describe("Also return when a hostile mob is within this many blocks"),
      healthBelow: z.coerce.number().finite().positive().optional().describe("Also return when health drops below this value"),
      timeoutMs: z.coerce.number().int().min(100).max(MAX_WAIT_MS).optional().describe(`How long to wait in milliseconds (default: ${DEFAULT_WAIT_MS}, max: ${MAX_WAIT_MS})`)
    },
    async ({ types, hostileWithin, healthBelow, timeoutMs = DEFAULT_WAIT_MS }: {
      types?: string[]; hostileWithin?: number; healthBelow?: number; timeoutMs?: number;
    }) => {
      const bot = getBot();
      const since = eventStore.getLastId();
      const started = Date.now();

      while (Date.now() - started < timeoutMs) {
        const { events, nextSince } = eventStore.query({ since, types, limit: 20 });
        if (events.length > 0) {
          return factory.createResponse(
            `Event(s) after ${((Date.now() - started) / 1000).toFixed(1)}s:\n\n${formatEvents(events)}\n\nnextSince: ${nextSince}`
          );
        }

        if (typeof healthBelow === 'number' && typeof bot.health === 'number' && bot.health < healthBelow) {
          return factory.createResponse(`Health is ${formatStat(bot.health)}, below ${healthBelow}`);
        }

        if (typeof hostileWithin === 'number') {
          const hostile = findNearbyEntities(bot, { type: 'hostile', maxDistance: hostileWithin })[0];
          if (hostile) {
            return factory.createResponse(`Hostile mob within ${hostileWithin} blocks: ${describeEntity(hostile)}`);
          }
        }

        await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
      }

      return factory.createResponse(`Nothing happened within ${(timeoutMs / 1000).toFixed(1)}s\n\nnextSince: ${eventStore.getLastId()}`);
    }
  );
}
