export type MessageKind = 'chat' | 'system' | 'action_bar' | 'title' | 'subtitle';

interface StoredMessage {
  timestamp: number;
  username: string;
  content: string;
  kind: MessageKind;
  /** For chat: the speaker's UUID was in the player list (E-035); read-chat quotes and marks the name otherwise. */
  listed: boolean;
}

const MAX_STORED_MESSAGES = 100;
// Servers often resend the same action bar or title every tick; keep only one copy.
const DUPLICATE_WINDOW_MS = 3000;

export class MessageStore {
  private messages: StoredMessage[] = [];
  private maxMessages = MAX_STORED_MESSAGES;

  /** Returns false when the message was dropped as a repeat of the previous one of the same kind. */
  addMessage(username: string, content: string, kind: MessageKind = 'chat', listed = true): boolean {
    const now = Date.now();
    if (kind !== 'chat') {
      const previous = [...this.messages].reverse().find(message => message.kind === kind);
      if (previous && previous.content === content && now - previous.timestamp < DUPLICATE_WINDOW_MS) {
        return false;
      }
    }

    this.messages.push({ timestamp: now, username, content, kind, listed });

    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    return true;
  }

  getRecentMessages(count: number = 10, kinds?: MessageKind[]): StoredMessage[] {
    if (count <= 0) {
      return [];
    }
    const filtered = kinds ? this.messages.filter(message => kinds.includes(message.kind)) : this.messages;
    return filtered.slice(-count);
  }

  getMaxMessages(): number {
    return this.maxMessages;
  }
}
