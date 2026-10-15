import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { EventStore } from '../event-store.js';

export function registerEventTools(factory: ToolFactory, eventStore: EventStore): void {
  factory.registerTool(
    "get-events",
    "Get recent game events (chat, death, damage taken, item pickups, players joining/leaving, kicks, disconnects). Pass the returned 'nextSince' as 'since' to read only new events",
    {
      since: z.coerce.number().int().min(0).optional().describe("Only return events with an id greater than this (default: 0, returns the latest events)"),
      types: z.array(z.string()).optional().describe("Only return these event types, e.g. ['death', 'damaged']"),
      limit: z.coerce.number().int().min(1).max(100).optional().describe("Maximum number of events to return (default: 20, max: 100)")
    },
    async ({ since = 0, types, limit = 20 }) => {
      const { events, nextSince, dropped } = eventStore.query({ since, types, limit });

      let output = events.length === 0
        ? "No new events"
        : `Found ${events.length} event(s):\n\n${events
          .map(event => `#${event.id} ${new Date(event.timestamp).toISOString()} [${event.type}] ${event.message}`)
          .join('\n')}`;

      if (dropped) {
        output += "\n\nWarning: some events were dropped because the buffer overflowed since 'since'";
      }
      output += `\n\nnextSince: ${nextSince}`;

      return factory.createResponse(output);
    }
  );
}
