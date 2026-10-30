#!/usr/bin/env node

import { format } from 'node:util';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { ConfigError, parseConfig, usernameWarning, type ServerConfig } from './config.js';
import { COMMAND_NAME, PACKAGE_VERSION } from './package-info.js';
import { BotConnection, SUPPORTED_MINECRAFT_VERSION } from './bot-connection.js';
import { runSelfCheck } from './self-check.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { EventStore } from './event-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { chatCallbacks, registerChatTools } from './tools/chat-tools.js';
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
import { registerPolicyTools } from './tools/policy-tools.js';
import { registerTradeTools } from './tools/trade-tools.js';

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  // Parsed before setupStdioFiltering, which would drop the --help and --version text that yargs prints.
  let config: ServerConfig;
  try {
    config = parseConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // Nothing is running yet (no connection, timer or transport), so the process ends by itself once stderr is written;
    // process.exit could cut that line short on a pipe. E-042: with --check, the same line exits with 2 instead.
    process.stderr.write(`${COMMAND_NAME}: ${error.message}; run with --help for the options\n`);
    process.exitCode = error.exitCode;
    return;
  }
  // --check (E-042): the report on stdout, unfiltered, and no MCP server, stores, Autopilot or stdin handler. The
  // username warning is a line of the report. The log stays on stderr.
  if (config.check) {
    // mineflayer's createBot logs every bot error with console.log by default (an ECONNREFUSED with its stack, for
    // one), and the report alone goes to stdout: library console output goes to stderr, where it is kept, not dropped.
    // runSelfCheck writes the report with process.stdout.write, which this leaves as it is.
    const toStderr = (...args: unknown[]) => {
      process.stderr.write(`${format(...args)}\n`);
    };
    console.log = console.info = console.debug = toStderr;
    const code = await runSelfCheck(config);
    // On macOS stdout to a pipe is asynchronous, and exit() could cut the report short: exit once it is written out.
    // exitCode as well, for a process that ends before the callback, for example on a closed pipe.
    process.exitCode = code;
    process.stdout.write('', () => process.exit(code));
    return;
  }
  setupStdioFiltering();
  const warning = usernameWarning(config.username);
  if (warning) log('warn', warning);

  const messageStore = new MessageStore();
  const eventStore = new EventStore();
  const waypointStore = new WaypointStore(config.waypointFile ?? defaultWaypointFile(), config.host);
  const autopilot = new Autopilot({ events: eventStore, waypoints: waypointStore, decisionModel: config.decisionModel, log });
  // The key is checked once now and again on every join (E-036); the result goes to stderr and an instinct event,
  // and get-policy shows it before the bot joins. Not awaited: connecting does not wait for OpenRouter.
  void autopilot.checkDecisionModel();

  // Public chat to read-chat and chat events, whispers to whisper events; only listed speakers reach the triage (E-035).
  const chat = chatCallbacks(messageStore, eventStore, (speaker, text, whisper) => autopilot.handleChat(speaker, text, whisper));
  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: chat.onChatMessage,
      onEvent: (type, message) => eventStore.addEvent(type, message),
      onSystemMessage: chat.onSystemMessage,
      // The world first, so that nothing the Autopilot starts at bind reads another world's waypoints (E-041).
      onBotReady: bot => {
        waypointStore.setWorld(connection.getWorldFingerprint());
        autopilot.bind(bot);
      },
      onBotEnd: () => autopilot.unbind('disconnected'),
      onDamage: info => autopilot.noteDamage(info)
    }
  );

  connection.connect();

  // Name and version come from package.json (F-049, E-024); the name is the command name, without the package's scope.
  const server = new McpServer({
    name: COMMAND_NAME,
    version: PACKAGE_VERSION
  });

  // --call-limit-seconds sets each call's budget, for clients that wait longer than 60 s for a reply (E-038).
  const factory = new ToolFactory(server, connection, { callLimitMs: config.callLimitSeconds * 1000 });
  factory.setEvents(eventStore);
  const getBot = () => connection.getBot()!;
  const getAutopilot = () => autopilot;
  factory.setAutopilot(getAutopilot);

  registerPositionTools(factory, getBot, getAutopilot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot, getAutopilot);
  registerChatTools(factory, getBot, messageStore, { allowCommands: config.allowCommands });
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot, getAutopilot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerEventTools(factory, eventStore, getBot);
  registerContainerTools(factory, getBot);
  registerInteractionTools(factory, getBot);
  registerTradeTools(factory, getBot);
  registerFollowTools(factory, getBot, getAutopilot);
  registerTaskTools(factory, getAutopilot);
  registerPolicyTools(factory, getAutopilot, eventStore);
  registerWaypointTools(factory, getBot, waypointStore);
  registerRegionTools(factory, getBot);
  registerGatheringTools(factory, getAutopilot);
  registerVisionTools(factory, getBot);

  process.stdin.on('end', () => {
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // After connect, so the line means stdio is being served: F-051 (c) waits for it before closing stdin.
  log('info', `${COMMAND_NAME} v${PACKAGE_VERSION}, tested with Minecraft ${SUPPORTED_MINECRAFT_VERSION}`);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
