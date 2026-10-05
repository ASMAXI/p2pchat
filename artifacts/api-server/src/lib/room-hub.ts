import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { randomToken, verifyPeerSignature } from "@workspace/p2p-identity";
import {
  compareMessages,
  joinProofText,
  LIMITS,
  messageProofText,
  PROTOCOL_VERSION,
  validateVoiceSignalData,
  type ClientCommand,
  type ErrorCode,
  type OutgoingMessage,
  type RoomStatus,
  type ServerEvent,
  type WireChannel,
  type WireMember,
  type WireMessage,
  type WireRoomState,
} from "@workspace/p2p-protocol";
import {
  appendChannelEvent,
  appendCoordinatorEvent,
  appendMessageEvent,
  electCoordinator,
  materializeRoomState,
  mergeEventLogs,
  verifyCoordinatorClaimForJoin,
} from "@workspace/p2p-room";
import { logger } from "./logger";

type PersistedRoom = Omit<WireRoomState, "voiceParticipants">;

type ClientConnection = {
  peerId: string;
  displayName: string;
  socket: WebSocket;
  host: boolean;
  sentAt: number[];
  signalSentAt: number[];
};

type RoomRuntime = {
  state: PersistedRoom;
  inviteToken: string;
  clients: Map<string, ClientConnection>;
  voice: Map<string, Map<string, string>>;
  /** Peer whose own node this is and who currently coordinates the room here. */
  hostPeerId: string | null;
};

export type RoomHubOptions = {
  databaseFile?: string;
  /**
   * An always-on bootstrap node coordinates every room itself. A peer node (the desktop app
   * or a test peer) only serves a room while its owner is connected with `host: true`.
   */
  alwaysHost?: boolean;
};

class HubError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly redirect?: string[],
  ) {
    super(message);
  }
}

const DEFAULT_DATABASE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../data/rooms.sqlite");
const now = () => new Date().toISOString();

const isString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function isValidMessage(roomId: string, message: WireMessage): boolean {
  return (
    isString(message?.id, 120) &&
    isString(message.channelId, 120) &&
    isString(message.content, LIMITS.maxCiphertextLength) &&
    isString(message.timestamp, 40) &&
    isString(message.authorPublicKey, 128) &&
    isString(message.signature, 256) &&
    verifyPeerSignature(message.authorId, message.authorPublicKey, messageProofText(roomId, message), message.signature)
  );
}

export class RoomHub {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly database: DatabaseSync;
  private readonly alwaysHost: boolean;
  private readonly sockets = new Set<WebSocket>();
  private closed = false;

  constructor(options: RoomHubOptions = {}) {
    const file = resolve(options.databaseFile ?? process.env["P2PCHAT_DB_FILE"] ?? DEFAULT_DATABASE_FILE);
    this.alwaysHost = options.alwaysHost ?? true;
    mkdirSync(dirname(file), { recursive: true });
    this.database = RoomHub.openDatabase(file);
    this.load();
  }

  private static openDatabase(file: string): DatabaseSync {
    const open = () => {
      const database = new DatabaseSync(file);
      database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          invite_token TEXT NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const check = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      if (check?.integrity_check !== "ok") {
        database.close();
        throw new Error("integrity check failed");
      }
      return database;
    };
    try {
      return open();
    } catch (error) {
      logger.warn({ err: error, file }, "Room cache is damaged, starting with a clean cache");
      if (existsSync(file)) renameSync(file, `${file}.corrupt-${Date.now()}`);
      return open();
    }
  }

  private load(): void {
    const rows = this.database
      .prepare("SELECT id, invite_token, state_json FROM rooms")
      .all() as Array<{ id: string; invite_token: string; state_json: string }>;
    for (const row of rows) {
      try {
        const state = JSON.parse(row.state_json) as PersistedRoom;
        if (!Array.isArray(state.members) || !Array.isArray(state.messages)) continue;
        state.epoch = state.epoch ?? 0;
        if (!Array.isArray(state.events)) state.events = [];
        state.members = state.members.map((member) => ({ ...member, online: false }));
        this.rooms.set(row.id, {
          state,
          inviteToken: row.invite_token,
          clients: new Map(),
          voice: new Map(),
          hostPeerId: null,
        });
      } catch (error) {
        logger.warn({ err: error, roomId: row.id }, "Skipping unreadable room record");
      }
    }
  }

  /** Kept for API compatibility with the previous entrypoint. */
  async init(): Promise<void> {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.terminate();
    this.database.close();
  }

  status(roomId: string, inviteToken: string): RoomStatus | null {
    const room = this.rooms.get(roomId);
    if (!room || room.inviteToken !== inviteToken) return null;
    const hosting = this.alwaysHost || Boolean(room.hostPeerId && room.clients.get(room.hostPeerId)?.host);
    return { roomId, hosting, alwaysHost: this.alwaysHost, epoch: room.state.epoch, hostId: room.state.hostId };
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (socket) => {
      this.sockets.add(socket);
      let bound: { roomId: string; peerId: string } | null = null;
      const send = (event: ServerEvent) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      };

      socket.on("message", (raw) => {
        let command: ClientCommand;
        try {
          command = JSON.parse(raw.toString()) as ClientCommand;
        } catch {
          send({ type: "error", code: "PROTOCOL", message: "Некорректное сообщение протокола" });
          return;
        }
        try {
          if (command.type === "join") {
            if (bound) throw new HubError("PROTOCOL", "Соединение уже привязано к комнате");
            bound = this.join(command, socket);
            return;
          }
          if (command.type === "ping") {
            send({ type: "pong", nonce: Number(command.nonce) || 0 });
            return;
          }
          if (!bound) throw new HubError("PROTOCOL", "Сначала подключитесь к комнате");
          const room = this.rooms.get(bound.roomId);
          const client = room?.clients.get(bound.peerId);
          if (!room || !client || client.socket !== socket) return;
          this.handle(room, client, command);
        } catch (error) {
          if (error instanceof HubError) {
            send({ type: "error", code: error.code, message: error.message, redirect: error.redirect });
          } else {
            logger.warn({ err: error }, "WebSocket event failed");
            send({ type: "error", code: "INVALID", message: "Ошибка обработки события" });
          }
        }
      });

      socket.on("close", () => {
        this.sockets.delete(socket);
        if (bound && !this.closed) this.depart(bound.roomId, bound.peerId, socket);
      });
      socket.on("error", (error) => logger.warn({ err: error }, "WebSocket client error"));
    });
  }

  private join(command: Extract<ClientCommand, { type: "join" }>, socket: WebSocket): { roomId: string; peerId: string } {
    if (command.protocol !== PROTOCOL_VERSION) {
      throw new HubError("PROTOCOL", "Версия приложения несовместима с комнатой — обновите P2PChat");
    }
    const { roomId, peerId, publicKey, inviteToken } = command;
    if (!isString(roomId, 80) || !isString(peerId, 100) || !isString(publicKey, 128) || !isString(inviteToken, 200)) {
      throw new HubError("INVALID", "Некорректный запрос входа");
    }
    if (Math.abs(Date.now() - Number(command.ts)) > LIMITS.joinClockSkewMs) {
      throw new HubError("UNAUTHORIZED", "Проверьте системное время на компьютере");
    }
    if (!verifyPeerSignature(peerId, publicKey, joinProofText(roomId, peerId, command.ts), command.proof)) {
      throw new HubError("UNAUTHORIZED", "Не удалось подтвердить личность участника");
    }
    const displayName = String(command.displayName ?? "").normalize("NFC").trim().slice(0, 40) || "Участник";
    const endpoints = Array.isArray(command.endpoints)
      ? command.endpoints.filter((item) => isString(item, 200)).slice(0, 8)
      : [];
    const mayHost = this.alwaysHost || command.host === true;
    const snapshot = command.snapshot?.id === roomId ? command.snapshot : undefined;

    let room = this.rooms.get(roomId);
    if (!room) {
      if (!mayHost || !snapshot) {
        throw this.alwaysHost
          ? new HubError("NOT_FOUND", "Комната не найдена или ссылка приглашения устарела")
          : new HubError("NOT_COORDINATOR", "Этот участник сейчас не координирует комнату");
      }
      room = this.importRoom(snapshot, inviteToken);
    } else if (room.inviteToken !== inviteToken) {
      throw new HubError("UNAUTHORIZED", "Ссылка приглашения недействительна");
    }

    if (!this.alwaysHost && !command.host) {
      const hostClient = room.hostPeerId ? room.clients.get(room.hostPeerId) : undefined;
      if (!hostClient) {
        const hint = room.state.members.find((member) => member.id === room!.state.hostId)?.endpoints;
        throw new HubError("NOT_COORDINATOR", "Этот участник сейчас не координирует комнату", hint);
      }
    }

    const merged = snapshot ? this.reconcile(room, snapshot) : [];

    const previous = room.clients.get(peerId);
    if (previous && previous.socket !== socket) previous.socket.close(4000, "reconnected");

    const existing = room.state.members.find((member) => member.id === peerId);
    if (existing) {
      if (existing.publicKey && existing.publicKey !== publicKey) {
        throw new HubError("UNAUTHORIZED", "Ключ участника не совпадает с сохранённым");
      }
      Object.assign(existing, { name: displayName, publicKey, endpoints, online: true });
    } else {
      room.state.members.push({
        id: peerId,
        name: displayName,
        role: peerId === room.state.ownerId ? "owner" : "member",
        joinedAt: now(),
        online: true,
        publicKey,
        endpoints,
      });
    }
    room.clients.set(peerId, {
      peerId,
      displayName,
      socket,
      host: !this.alwaysHost && command.host === true,
      sentAt: [],
      signalSentAt: [],
    });

    if (!this.alwaysHost && command.host) {
      const previousHostId = room.state.hostId !== peerId ? room.state.hostId : null;
      let nextEpoch = room.state.epoch;
      if (command.coordinatorClaim) {
        const claimError = verifyCoordinatorClaimForJoin(command.coordinatorClaim, {
          roomId,
          peerId,
          publicKey,
          roomEpoch: room.state.epoch,
          roomHostId: room.state.hostId,
        });
        if (claimError) throw new HubError("UNAUTHORIZED", claimError);
        nextEpoch = command.coordinatorClaim.epoch;
      } else if (room.hostPeerId !== peerId || room.state.hostId !== peerId) {
        nextEpoch = room.state.epoch + 1;
      }
      room.hostPeerId = peerId;
      const asWire = this.asWire(room);
      const next = appendCoordinatorEvent(asWire, {
        hostId: peerId,
        hostName: displayName,
        epoch: Math.max(1, nextEpoch),
        previousHostId,
      });
      this.applyMaterialized(room, next);
    } else if (this.alwaysHost && !room.clients.has(room.state.hostId)) {
      this.electHost(room);
    }

    this.persist(room);
    this.sendTo(socket, { type: "state", state: this.snapshot(room, true) });
    for (const message of merged) {
      for (const client of room.clients.values()) {
        if (client.peerId !== peerId) this.sendTo(client.socket, { type: "message", message });
      }
    }
    this.broadcastPresence(room);
    return { roomId, peerId };
  }

  private importRoom(snapshot: WireRoomState, inviteToken: string): RoomRuntime {
    const state: PersistedRoom = {
      id: snapshot.id,
      name: String(snapshot.name ?? "").slice(0, 80) || "Комната без названия",
      ownerId: String(snapshot.ownerId ?? ""),
      hostId: String(snapshot.hostId ?? ""),
      hostName: String(snapshot.hostName ?? ""),
      epoch: Number(snapshot.epoch) || 0,
      channels: [],
      messages: [],
      members: [],
      events: Array.isArray(snapshot.events) ? snapshot.events : [],
    };
    const room: RoomRuntime = { state, inviteToken, clients: new Map(), voice: new Map(), hostPeerId: null };
    this.rooms.set(state.id, room);
    return room;
  }

  /**
   * Merges a peer's replica: signed messages are unioned, newer epochs win metadata.
   * Returns the messages this node did not have yet.
   */
  private reconcile(room: RoomRuntime, snapshot: WireRoomState): WireMessage[] {
    const known = new Set(room.state.messages.map((message) => message.id));
    const added: WireMessage[] = [];
    for (const message of Array.isArray(snapshot.messages) ? snapshot.messages : []) {
      if (known.has(message?.id) || !isValidMessage(room.state.id, message)) continue;
      room.state.messages.push(message);
      known.add(message.id);
      added.push(message);
    }
    if (added.length > 0) {
      room.state.messages.sort(compareMessages);
      room.state.messages = room.state.messages.slice(-LIMITS.maxStoredMessages);
    }
    for (const channel of Array.isArray(snapshot.channels) ? snapshot.channels : []) {
      if (room.state.channels.length >= LIMITS.maxChannels) break;
      if (!isString(channel?.id, 120) || room.state.channels.some((item) => item.id === channel.id)) continue;
      if (channel.type !== "text" && channel.type !== "voice") continue;
      room.state.channels.push({
        id: channel.id,
        name: String(channel.name).slice(0, LIMITS.maxChannelNameLength),
        type: channel.type,
        unreadCount: 0,
        members: 0,
      });
    }
    for (const member of Array.isArray(snapshot.members) ? snapshot.members : []) {
      if (!isString(member?.id, 100) || room.state.members.some((item) => item.id === member.id)) continue;
      room.state.members.push({
        id: member.id,
        name: String(member.name ?? "Участник").slice(0, 40),
        role: member.role === "owner" || member.role === "admin" ? member.role : "member",
        joinedAt: String(member.joinedAt ?? now()),
        online: false,
        publicKey: member.publicKey,
        endpoints: Array.isArray(member.endpoints) ? member.endpoints.slice(0, 8) : [],
      });
    }
    room.state.events = mergeEventLogs(room.state.events, snapshot.events);
    // Append message events for newly validated messages missing from the log.
    let wire = this.asWire(room);
    for (const message of added) {
      const already = wire.events?.some(
        (event) => event.kind === "message" && event.message.id === message.id,
      );
      if (!already) wire = appendMessageEvent(wire, message);
    }
    if (Number(snapshot.epoch) > wire.epoch && !(wire.events && wire.events.length > 0)) {
      // Legacy snapshot without events: keep scalar epoch bump.
      wire = {
        ...wire,
        epoch: Number(snapshot.epoch),
        hostId: room.hostPeerId ? wire.hostId : String(snapshot.hostId),
        hostName: room.hostPeerId ? wire.hostName : String(snapshot.hostName),
      };
    }
    this.applyMaterialized(room, materializeRoomState(wire));
    return added;
  }

  private handle(room: RoomRuntime, client: ClientConnection, command: ClientCommand): void {
    switch (command.type) {
      case "message":
        this.acceptMessage(room, client, command.message);
        return;
      case "create_channel": {
        const name = String(command.name ?? "").normalize("NFC").trim();
        if (!name || name.length > LIMITS.maxChannelNameLength) {
          throw new HubError("INVALID", "Название канала должно содержать от 1 до 50 символов");
        }
        const channelType = command.channelType === "voice" ? "voice" : "text";
        const sameKind = room.state.channels.filter((item) => item.type === channelType).length;
        const typeLimit = channelType === "voice" ? LIMITS.maxVoiceChannels : LIMITS.maxTextChannels;
        if (sameKind >= typeLimit) {
          throw new HubError(
            "INVALID",
            channelType === "voice" ? "Лимит голосовых каналов: 5" : "Лимит текстовых каналов: 5",
          );
        }
        if (room.state.channels.length >= LIMITS.maxChannels) throw new HubError("INVALID", "Слишком много каналов");
        const channel: WireChannel = {
          id: `channel-${randomToken(9)}`,
          name,
          type: channelType,
          unreadCount: 0,
          members: 0,
        };
        this.applyMaterialized(room, appendChannelEvent(this.asWire(room), channel));
        this.persist(room);
        this.broadcastPresence(room);
        return;
      }
      case "voice_join":
      case "voice_leave": {
        const channel = room.state.channels.find((item) => item.id === command.channelId && item.type === "voice");
        if (!channel) throw new HubError("INVALID", "Голосовой канал не найден");
        const participants = room.voice.get(channel.id) ?? new Map<string, string>();
        if (command.type === "voice_join") {
          for (const [peerId, name] of participants) {
            if (peerId !== client.peerId) {
              this.sendTo(client.socket, { type: "voice", channelId: channel.id, peerId, displayName: name, joined: true });
            }
          }
          participants.set(client.peerId, client.displayName);
          room.voice.set(channel.id, participants);
        } else {
          participants.delete(client.peerId);
          if (participants.size === 0) room.voice.delete(channel.id);
        }
        this.broadcast(room, {
          type: "voice",
          channelId: channel.id,
          peerId: client.peerId,
          displayName: client.displayName,
          joined: command.type === "voice_join",
        });
        this.broadcastPresence(room);
        return;
      }
      case "signal": {
        const invalid = validateVoiceSignalData(command.data);
        if (invalid) throw new HubError("INVALID", invalid);
        const kind =
          command.data && typeof command.data === "object" && "kind" in command.data
            ? String((command.data as { kind?: unknown }).kind ?? "")
            : "";
        // SDP must not be dropped — ICE floods are what trip the limit at N≈6.
        const countsTowardLimit = kind !== "offer" && kind !== "answer";
        if (countsTowardLimit) {
          const nowMs = Date.now();
          client.signalSentAt = client.signalSentAt.filter((at) => nowMs - at < LIMITS.rateWindowMs);
          if (client.signalSentAt.length >= LIMITS.rateMaxSignals) {
            throw new HubError("RATE_LIMIT", "Слишком много голосовых сигналов — подождите секунду");
          }
          client.signalSentAt.push(nowMs);
        }
        const target = room.clients.get(command.toPeerId);
        if (target) this.sendTo(target.socket, { type: "signal", fromPeerId: client.peerId, data: command.data });
        return;
      }
      case "leave":
        this.depart(room.state.id, client.peerId, client.socket, command.redirect);
        client.socket.close(1000, "left");
        return;
      default:
        return;
    }
  }

  private acceptMessage(room: RoomRuntime, client: ClientConnection, input: OutgoingMessage): void {
    const existing = room.state.messages.find((message) => message.id === input?.id);
    if (existing) {
      this.sendTo(client.socket, { type: "message", message: existing });
      return;
    }
    const channel = room.state.channels.find((item) => item.id === input?.channelId);
    if (!channel) throw new HubError("INVALID", "Канал не найден");
    const nowMs = Date.now();
    client.sentAt = client.sentAt.filter((at) => nowMs - at < LIMITS.rateWindowMs);
    if (client.sentAt.length >= LIMITS.rateMaxMessages) {
      throw new HubError("RATE_LIMIT", "Слишком много сообщений подряд — подождите пару секунд");
    }
    const member = room.state.members.find((item) => item.id === client.peerId);
    const message: WireMessage = {
      id: String(input.id),
      channelId: channel.id,
      authorId: client.peerId,
      author: client.displayName,
      authorPublicKey: member?.publicKey ?? "",
      content: String(input.content),
      timestamp: String(input.timestamp),
      signature: String(input.signature),
    };
    if (!isValidMessage(room.state.id, message)) throw new HubError("INVALID", "Подпись сообщения не прошла проверку");
    client.sentAt.push(nowMs);
    this.applyMaterialized(room, appendMessageEvent(this.asWire(room), message));
    this.persist(room);
    this.broadcast(room, { type: "message", message });
  }

  private depart(roomId: string, peerId: string, socket: WebSocket, redirect?: string): void {
    const room = this.rooms.get(roomId);
    const current = room?.clients.get(peerId);
    if (!room || !current || current.socket !== socket) return;
    room.clients.delete(peerId);
    for (const [channelId, participants] of room.voice) {
      participants.delete(peerId);
      if (participants.size === 0) room.voice.delete(channelId);
    }

    if (!this.alwaysHost && room.hostPeerId === peerId) {
      room.hostPeerId = null;
      const hint = redirect && isString(redirect, 200) ? [redirect] : undefined;
      for (const client of room.clients.values()) {
        this.sendTo(client.socket, {
          type: "error",
          code: "NOT_COORDINATOR",
          message: "Координатор комнаты сменился",
          redirect: hint,
        });
        client.socket.close(4001, "coordinator left");
      }
      room.clients.clear();
      room.voice.clear();
    } else if (this.alwaysHost && room.state.hostId === peerId) {
      this.electHost(room);
    }
    for (const member of room.state.members) member.online = room.clients.has(member.id);
    this.persist(room);
    this.broadcastPresence(room);
  }

  private electHost(room: RoomRuntime): void {
    const next = electCoordinator([...room.clients.keys()]);
    if (!next || next === room.state.hostId) return;
    const previousHostId = room.state.hostId;
    const hostName = room.clients.get(next)?.displayName ?? "Координатор";
    this.applyMaterialized(
      room,
      appendCoordinatorEvent(this.asWire(room), {
        hostId: next,
        hostName,
        epoch: room.state.epoch + 1,
        previousHostId,
      }),
    );
  }

  private asWire(room: RoomRuntime): WireRoomState {
    return {
      ...room.state,
      voiceParticipants: {},
      events: room.state.events ?? [],
    };
  }

  private applyMaterialized(room: RoomRuntime, next: WireRoomState): void {
    room.state.messages = next.messages;
    room.state.channels = next.channels;
    room.state.epoch = next.epoch;
    room.state.hostId = next.hostId;
    room.state.hostName = next.hostName;
    room.state.events = next.events ?? [];
    if (room.state.messages.length > LIMITS.maxStoredMessages) {
      room.state.messages = room.state.messages.slice(-LIMITS.maxStoredMessages);
    }
  }

  private snapshot(room: RoomRuntime, withMessages: boolean): WireRoomState {
    const materialized = materializeRoomState(this.asWire(room));
    this.applyMaterialized(room, materialized);
    const members: WireMember[] = room.state.members.map((member) => ({ ...member, online: room.clients.has(member.id) }));
    return {
      ...materialized,
      members,
      channels: materialized.channels.map((channel) => ({
        ...channel,
        members: channel.type === "voice" ? (room.voice.get(channel.id)?.size ?? 0) : room.clients.size,
      })),
      messages: withMessages ? materialized.messages : [],
      voiceParticipants: Object.fromEntries(
        [...room.voice.entries()].map(([channelId, participants]) => [
          channelId,
          [...participants.entries()].map(([id, name]) => ({ id, name })),
        ]),
      ),
    };
  }

  private sendTo(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  private broadcast(room: RoomRuntime, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of room.clients.values()) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }

  private broadcastPresence(room: RoomRuntime): void {
    this.broadcast(room, { type: "presence", state: this.snapshot(room, false) });
  }

  private persist(room: RoomRuntime): void {
    if (this.closed) return;
    const statement = this.database.prepare(`
      INSERT INTO rooms (id, invite_token, state_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        invite_token = excluded.invite_token,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
    this.database.exec("BEGIN");
    try {
      statement.run(room.state.id, room.inviteToken, JSON.stringify(room.state), now());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      logger.error({ err: error, roomId: room.state.id }, "Could not persist room");
    }
  }
}
