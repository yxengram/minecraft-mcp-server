#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { EventStore } from './event-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerEventTools } from './tools/event-tools.js';
import { registerContainerTools } from './tools/container-tools.js';
import { registerInteractionTools } from './tools/interaction-tools.js';
import { registerFollowTools } from './tools/follow-tools.js';
import { registerWaypointTools } from './tools/waypoint-tools.js';
import { registerRegionTools } from './tools/region-tools.js';
import { registerGatheringTools } from './tools/gathering-tools.js';
import { registerVisionTools } from './tools/vision-tools.js';
import { WaypointStore, defaultWaypointFile } from './waypoint-store.js';
import { Autopilot } from './autopilot/autopilot.js';
import { registerTaskTools } from './tools/task-tools.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();
  const eventStore = new EventStore();
  const autopilot = new Autopilot({ events: eventStore, log });

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => {
        messageStore.addMessage(username, message);
        eventStore.addEvent('chat', `${username}: ${message}`);
      },
      onEvent: (type, message) => eventStore.addEvent(type, message),
      onSystemMessage: (kind, text) => {
        if (messageStore.addMessage('', text, kind)) {
          eventStore.addEvent(kind, text);
        }
      },
      onBotReady: bot => autopilot.bind(bot),
      onBotEnd: () => autopilot.unbind('disconnected')
    }
  );

  connection.connect();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4"
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;
  const getAutopilot = () => autopilot;
  factory.setAutopilot(getAutopilot);

  registerPositionTools(factory, getBot, getAutopilot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerEventTools(factory, eventStore, getBot);
  registerContainerTools(factory, getBot);
  registerInteractionTools(factory, getBot);
  registerFollowTools(factory, getBot, getAutopilot);
  registerTaskTools(factory, getAutopilot);
  registerWaypointTools(factory, getBot, new WaypointStore(config.waypointFile ?? defaultWaypointFile(), config.host));
  registerRegionTools(factory, getBot);
  registerGatheringTools(factory, getBot);
  registerVisionTools(factory, getBot);

  process.stdin.on('end', () => {
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
