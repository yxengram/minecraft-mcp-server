import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { MessageKind, MessageStore } from '../message-store.js';
import type { EventStore } from '../event-store.js';
import type { ChatSpeaker } from '../bot-connection.js';
import { chatLine, quoteUntrusted, UNTRUSTED_PLAYER_TEXT } from '../format.js';

const KIND_LABELS: Record<Exclude<MessageKind, 'chat'>, string> = {
  system: 'system',
  action_bar: 'action bar',
  title: 'title',
  subtitle: 'subtitle'
};

/**
 * BotConnection's onChatMessage and onSystemMessage as src/main.ts wires them (E-035). Public chat goes to the store
 * and a chat event, a whisper only to a whisper event (whispers never were in read-chat), and only a speaker in the
 * player list goes on to `triage` (Autopilot.handleChat). Event bodies are quoted; the store keeps the raw text, which
 * read-chat quotes and its repeat check compares.
 */
export function chatCallbacks(
  messageStore: MessageStore,
  events: Pick<EventStore, 'addEvent'>,
  triage: (speaker: string, text: string, whisper: boolean) => void
) {
  return {
    onChatMessage(speaker: ChatSpeaker, text: string): void {
      if (speaker.whisper) {
        events.addEvent('whisper', chatLine(speaker, text));
      } else {
        messageStore.addMessage(speaker.name, text, 'chat', speaker.listed);
        events.addEvent('chat', chatLine(speaker, text));
      }
      if (speaker.listed) triage(speaker.name, text, speaker.whisper);
    },
    onSystemMessage(kind: Exclude<MessageKind, 'chat'>, text: string): void {
      if (messageStore.addMessage('', text, kind)) events.addEvent(kind, quoteUntrusted(text));
    }
  };
}

export interface ChatToolOptions {
  /** --allow-commands (BLUEPRINT E-033): send-chat may run server commands. Off when left out. */
  allowCommands?: boolean;
}

// Commands that only talk to players always go through send-chat; every other command is a server command (E-033).
const CHAT_COMMANDS = new Set(['msg', 'tell', 'w', 'me', 'teammsg', 'tm']);

const SINGLE_LINE_ERROR = 'Nothing was sent: commands must be a single line (a message that starts with / is sent as one ' +
  'command, so it cannot contain line breaks or control characters)';

function refusedCommand(name: string): string {
  return `"/${name}" is a server command and this MCP server was started without --allow-commands, so nothing was sent. ` +
    'Plain chat and /msg, /tell, /w, /me, /teammsg, /tm always work; other commands need the user to add ' +
    "--allow-commands to the server's arguments and restart it";
}

// U+0000 to U+001F and U+007F; the vanilla server kicks a client whose command contains them (illegal_characters).
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The pieces bot.chat hands to the client, cut as mineflayer's chatWithHeader cuts them (lib/plugins/chat.js): a
 * message that starts with / goes out whole; any other is split at line breaks, empty lines are dropped, and each line
 * is cut into chunks of `limit` UTF-16 units. The client sends every piece that starts with / as a command.
 */
function chatPieces(message: string, limit: number): string[] {
  if (message.startsWith('/')) return [message];
  const pieces: string[] = [];
  for (const line of message.split('\n')) {
    for (let i = 0; i < line.length; i += limit) pieces.push(line.substring(i, i + limit));
  }
  return pieces;
}

// mineflayer cuts chat at 256 characters, or at 100 on servers before 1.11 (its lessCharsInChat feature).
function chatLengthLimit(bot: mineflayer.Bot): number {
  return typeof bot.supportFeature === 'function' && bot.supportFeature('lessCharsInChat') ? 100 : 256;
}

/** The first word after the /, in lower case and without a "minecraft:" prefix. */
function commandName(piece: string): string {
  const name = piece.slice(1).split(/\s/, 1)[0].toLowerCase();
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name;
}

export function registerChatTools(
  factory: ToolFactory,
  getBot: () => mineflayer.Bot,
  messageStore: MessageStore,
  options: ChatToolOptions = {}
): void {
  const allowCommands = options.allowCommands === true;
  factory.registerTool(
    "send-chat",
    allowCommands
      ? "Send a chat message in-game, or run a server command (this server was started with --allow-commands)"
      : "Send a chat message in-game. Chat commands (/msg, /tell, /w, /me, /teammsg, /tm) always work; other server commands are refused because this server was started without --allow-commands",
    {
      message: z.string().describe("Message to send in chat")
    },
    async ({ message }) => {
      const bot = getBot();
      // A command is never split, so a line break would carry a second command inside the first one's arguments.
      if (message.startsWith('/') && hasControlCharacter(message)) {
        return factory.createErrorResponse(SINGLE_LINE_ERROR);
      }
      const commands = chatPieces(message, chatLengthLimit(bot))
        .filter(piece => piece.startsWith('/') && !CHAT_COMMANDS.has(commandName(piece)));
      if (commands.length > 0 && !allowCommands) {
        return factory.createErrorResponse(refusedCommand(commandName(commands[0])));
      }
      bot.chat(message);
      const ran = commands.length === 0
        ? ''
        : ` (ran ${commands.length} command${commands.length === 1 ? '' : 's'}: ${commands.join(', ')})`;
      return factory.createResponse(`Sent message: "${message}"${ran}`);
    }
  );

  factory.registerTool(
    "read-chat",
    `Get recent chat messages from players, plus system messages (command feedback, death messages, server notices), action bar text and titles. ${UNTRUSTED_PLAYER_TEXT}`,
    {
      count: z.number().optional().describe("Number of recent messages to retrieve (default: 10, max: 100)"),
      includeSystem: z.boolean().optional().describe("Include system messages, action bar text and titles (default: true)")
    },
    async ({ count = 10, includeSystem = true }) => {
      const maxCount = Math.min(count, messageStore.getMaxMessages());
      const messages = messageStore.getRecentMessages(maxCount, includeSystem ? undefined : ['chat']);

      if (messages.length === 0) {
        return factory.createResponse("No chat messages found");
      }

      const chatCount = messages.filter(msg => msg.kind === 'chat').length;
      let output = chatCount === messages.length
        ? `Found ${messages.length} chat message(s):\n\n`
        : `Found ${messages.length} message(s) (${chatCount} chat, ${messages.length - chatCount} system/action bar/title):\n\n`;
      messages.forEach((msg, index) => {
        const timestamp = new Date(msg.timestamp).toISOString();
        const body = msg.kind === 'chat'
          ? chatLine({ name: msg.username, listed: msg.listed }, msg.content)
          : `[${KIND_LABELS[msg.kind]}] ${quoteUntrusted(msg.content)}`;
        output += `${index + 1}. ${timestamp} - ${body}\n`;
      });

      return factory.createResponse(output);
    }
  );
}
