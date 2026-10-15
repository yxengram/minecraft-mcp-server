export interface GameEvent {
  id: number;
  timestamp: number;
  type: string;
  message: string;
}

export interface EventQuery {
  since?: number;
  types?: string[];
  limit?: number;
}

export interface EventQueryResult {
  events: GameEvent[];
  nextSince: number;
  dropped: boolean;
}

const MAX_STORED_EVENTS = 200;

export class EventStore {
  private events: GameEvent[] = [];
  private lastId = 0;
  private maxEvents = MAX_STORED_EVENTS;

  addEvent(type: string, message: string): GameEvent {
    const event: GameEvent = {
      id: ++this.lastId,
      timestamp: Date.now(),
      type,
      message
    };

    this.events.push(event);

    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    return event;
  }

  getLastId(): number {
    return this.lastId;
  }

  getMaxEvents(): number {
    return this.maxEvents;
  }

  query({ since = 0, types, limit = 20 }: EventQuery = {}): EventQueryResult {
    const typeFilter = types && types.length > 0 ? new Set(types) : null;
    const oldestId = this.events.length > 0 ? this.events[0].id : this.lastId + 1;
    const dropped = since > 0 && oldestId > since + 1;

    let matching = this.events.filter(event =>
      event.id > since && (!typeFilter || typeFilter.has(event.type))
    );

    if (limit <= 0) {
      return { events: [], nextSince: since > 0 ? since : this.lastId, dropped };
    }

    if (since <= 0) {
      matching = matching.slice(-limit);
      return { events: matching, nextSince: this.lastId, dropped: false };
    }

    const truncated = matching.length > limit;
    matching = matching.slice(0, limit);
    const nextSince = truncated ? matching[matching.length - 1].id : this.lastId;

    return { events: matching, nextSince, dropped };
  }
}
