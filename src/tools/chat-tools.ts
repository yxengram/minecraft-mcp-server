import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { MessageKind, MessageStore } from '../message-store.js';

const KIND_LABELS: Record<Exclude<MessageKind, 'chat'>, string> = {
  system: 'system',
  action_bar: 'action bar',
  title: 'title',
  subtitle: 'subtitle'
};

export function registerChatTools(factory: ToolFactory, getBot: () => mineflayer.Bot, messageStore: MessageStore): void {
  factory.registerTool(
    "send-chat",
    "Send a chat message in-game",
    {
      message: z.string().describe("Message to send in chat")
    },
    async ({ message }) => {
      const bot = getBot();
      bot.chat(message);
      return factory.createResponse(`Sent message: "${message}"`);
    }
  );

  factory.registerTool(
    "read-chat",
    "Get recent chat messages from players, plus system messages (command feedback, death messages, server notices), action bar text and titles",
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
        const body = msg.kind === 'chat' ? `${msg.username}: ${msg.content}` : `[${KIND_LABELS[msg.kind]}] ${msg.content}`;
        output += `${index + 1}. ${timestamp} - ${body}\n`;
      });

      return factory.createResponse(output);
    }
  );
}
