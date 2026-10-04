import {
  LIMITS,
  type RoomEvent,
  type WireChannel,
  type WireMessage,
  type WireRoomState,
} from "@workspace/p2p-protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type RoomEventInput = DistributiveOmit<RoomEvent, "eventId" | "sequence" | "predecessorId" | "ts"> & {
  eventId?: string;
  ts?: string;
};

function randomEventId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function lastEventId(events: RoomEvent[] | undefined): string | undefined {
  if (!events?.length) return undefined;
  return [...events].sort((a, b) => a.sequence - b.sequence).at(-1)?.eventId;
}

export function nextSequence(events: RoomEvent[] | undefined): number {
  if (!events?.length) return 1;
  return Math.max(...events.map((event) => event.sequence)) + 1;
}

export function appendRoomEvent(events: RoomEvent[] | undefined, partial: RoomEventInput): RoomEvent[] {
  const list = events ? [...events] : [];
  const event = {
    ...partial,
    eventId: partial.eventId ?? randomEventId(),
    sequence: nextSequence(list),
    predecessorId: lastEventId(list),
    ts: partial.ts ?? new Date().toISOString(),
  } as RoomEvent;
  list.push(event);
  if (list.length > LIMITS.maxStoredEvents) {
    return list.slice(-LIMITS.maxStoredEvents);
  }
  return list;
}

/** Bootstrap an event log from a legacy snapshot (no events yet). */
export function seedEventsFromSnapshot(state: WireRoomState): RoomEvent[] {
  let events: RoomEvent[] = [];
  for (const channel of state.channels) {
    events = appendRoomEvent(events, { kind: "channel_create", channel: { ...channel } });
  }
  events = appendRoomEvent(events, {
    kind: "coordinator_takeover",
    hostId: state.hostId,
    hostName: state.hostName,
    epoch: Math.max(1, state.epoch || 1),
    previousHostId: null,
  });
  const messages = [...state.messages].sort((a, b) =>
    a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const message of messages) {
    events = appendRoomEvent(events, { kind: "message", message: { ...message } });
  }
  return events;
}

export function ensureEventLog(state: WireRoomState): RoomEvent[] {
  if (Array.isArray(state.events) && state.events.length > 0) return state.events;
  return seedEventsFromSnapshot(state);
}

export function mergeEventLogs(local: RoomEvent[] | undefined, remote: RoomEvent[] | undefined): RoomEvent[] {
  const byId = new Map<string, RoomEvent>();
  for (const event of [...(local ?? []), ...(remote ?? [])]) {
    if (!event?.eventId) continue;
    byId.set(event.eventId, event);
  }
  const messageIds = new Set<string>();
  const channelIds = new Set<string>();
  const out: RoomEvent[] = [];
  for (const event of [...byId.values()].sort(
    (left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
  )) {
    if (event.kind === "message") {
      if (messageIds.has(event.message.id)) continue;
      messageIds.add(event.message.id);
    } else if (event.kind === "channel_create") {
      if (channelIds.has(event.channel.id)) continue;
      channelIds.add(event.channel.id);
    }
    out.push(event);
  }
  return out;
}

/** Derive messages / channels / coordinator fields from the event log (source of truth). */
export function foldRoomState(base: WireRoomState, events: RoomEvent[]): WireRoomState {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const channels: WireChannel[] = [];
  const messages: WireMessage[] = [];
  let hostId = base.hostId;
  let hostName = base.hostName;
  let epoch = base.epoch;

  for (const event of ordered) {
    if (event.kind === "channel_create") {
      if (!channels.some((channel) => channel.id === event.channel.id)) {
        channels.push({ ...event.channel });
      }
    } else if (event.kind === "message") {
      if (!messages.some((message) => message.id === event.message.id)) {
        messages.push({ ...event.message });
      }
    } else if (event.kind === "coordinator_takeover") {
      hostId = event.hostId;
      hostName = event.hostName;
      epoch = event.epoch;
    }
  }

  return {
    ...base,
    channels: channels.length > 0 ? channels : base.channels,
    messages,
    hostId,
    hostName,
    epoch,
    events: ordered,
  };
}

/** Materialize SoT projection; seeds legacy rooms once. */
export function materializeRoomState(state: WireRoomState): WireRoomState {
  const events = ensureEventLog(state);
  return foldRoomState(state, events);
}

export function appendMessageEvent(state: WireRoomState, message: WireMessage): WireRoomState {
  const events = appendRoomEvent(ensureEventLog(state), { kind: "message", message });
  return foldRoomState(state, events);
}

export function appendChannelEvent(state: WireRoomState, channel: WireChannel): WireRoomState {
  const events = appendRoomEvent(ensureEventLog(state), { kind: "channel_create", channel });
  return foldRoomState(state, events);
}

export function appendCoordinatorEvent(
  state: WireRoomState,
  input: { hostId: string; hostName: string; epoch: number; previousHostId: string | null },
): WireRoomState {
  const events = appendRoomEvent(ensureEventLog(state), {
    kind: "coordinator_takeover",
    ...input,
  });
  return foldRoomState(state, events);
}
