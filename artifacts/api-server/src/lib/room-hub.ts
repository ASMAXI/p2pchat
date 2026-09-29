import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "./logger";

export type ChannelType = "text" | "voice";

export type RoomChannel = {
  id: string;
  name: string;
  type: ChannelType;
  unreadCount: number;
  members: number;
};

export type RoomMessage = {
  id: string;
  authorId: string;
  author: string;
  content: string;
  timestamp: string;
  channelId: string;
};

export type RoomMember = {
  id: string;
  name: string;
  role: "owner" | "member";
  joinedAt: string;
  online: boolean;
};

export type RoomState = {
  id: string;
  name: string;
  ownerId: string;
  hostId: string;
  hostName: string;
  channels: RoomChannel[];
  messages: RoomMessage[];
  members: RoomMember[];
  voiceParticipants: Record<string, Array<{ id: string; name: string }>>;
};

type PersistedRoom = Omit<RoomState, "voiceParticipants"> & {
  inviteToken: string;
};

type RoomRuntime = Omit<PersistedRoom, "members"> & {
  members: RoomMember[];
  clients: Map<string, ClientConnection>;
  voiceParticipants: Map<string, Map<string, string>>;
};

type ClientConnection = {
  peerId: string;
  displayName: string;
  roomId: string;
  socket: WebSocket;
};

type ClientEvent =
  | { type: "join"; roomId: string; inviteToken: string; peerId: string; displayName: string }
  | { type: "message"; channelId: string; content: string; messageId?: string }
  | { type: "create_channel"; name: string; channelType: ChannelType }
  | { type: "voice_join"; channelId: string }
  | { type: "voice_leave"; channelId: string }
  | { type: "signal"; toPeerId: string; data: unknown }
  | { type: "ping" };

type ServerEvent =
  | { type: "state"; state: RoomState }
  | { type: "message"; message: RoomMessage }
  | { type: "presence"; state: RoomState }
  | { type: "voice"; channelId: string; peerId: string; displayName: string; joined: boolean }
  | { type: "error"; message: string }
  | { type: "pong" };

const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
const DATABASE_FILE = resolve(
  process.env["P2PCHAT_DB_FILE"] ?? resolve(DEFAULT_DATA_DIR, "rooms.sqlite"),
);
const LEGACY_JSON_FILES = [
  resolve(DEFAULT_DATA_DIR, "rooms.json"),
  resolve(process.cwd(), "artifacts/api-server/data/rooms.json"),
];

const defaultChannels = (): RoomChannel[] => [
  { id: "general", name: "общий", type: "text", unreadCount: 0, members: 1 },
  { id: "lounge", name: "вечерний лоунж", type: "voice", unreadCount: 0, members: 0 },
];

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${randomUUID()}`;

export function createInvite(roomId: string, inviteToken: string): string {
  return `p2pchat://join?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(inviteToken)}`;
}

export function parseInvite(input: string): { roomId: string; inviteToken: string } | null {
  const value = input.trim();
  if (!value) return null;

  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const roomId = url.searchParams.get("room");
    const inviteToken = url.searchParams.get("token");
    if (roomId && inviteToken) return { roomId, inviteToken };
  } catch {
    // Fall through to the compact path format for pasted legacy links.
  }

  const match = value.match(/(?:join[/:])([^/?#]+)(?:[/:]([^/?#]+))?/i);
  if (!match?.[1] || !match[2]) return null;
  return { roomId: decodeURIComponent(match[1]), inviteToken: decodeURIComponent(match[2]) };
}

export class RoomHub {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly database: DatabaseSync;
  private loaded = false;

  constructor() {
    mkdirSync(dirname(DATABASE_FILE), { recursive: true });
    this.database = new DatabaseSync(DATABASE_FILE);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        invite_token TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const rows = this.database
      .prepare("SELECT id, invite_token, state_json FROM rooms")
      .all() as Array<{ id: string; invite_token: string; state_json: string }>;
    if (rows.length === 0) await this.migrateLegacyJson();
    for (const row of rows) {
      const state = JSON.parse(row.state_json) as Omit<RoomState, "voiceParticipants">;
      this.rooms.set(row.id, {
        ...state,
        inviteToken: row.invite_token,
        members: state.members.map((member) => ({ ...member, online: false })),
        clients: new Map(),
        voiceParticipants: new Map(),
      });
    }
  }

  private async migrateLegacyJson(): Promise<void> {
    for (const file of LEGACY_JSON_FILES) {
      try {
        const raw = await readFile(file, "utf8");
        const legacyRooms = JSON.parse(raw) as PersistedRoom[];
        for (const room of legacyRooms) {
          this.rooms.set(room.id, {
            ...room,
            members: room.members.map((member) => ({ ...member, online: false })),
            clients: new Map(),
            voiceParticipants: new Map(),
          });
        }
        if (this.rooms.size > 0) {
          await this.persist();
          logger.info({ file, rooms: this.rooms.size }, "Migrated legacy room store to SQLite");
          return;
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") logger.warn({ err: error, file }, "Could not migrate legacy room store");
      }
    }
  }

  async createRoom(input: {
    name: string;
    ownerId: string;
    displayName: string;
  }): Promise<{ state: RoomState; invite: string; inviteToken: string }> {
    await this.init();
    const roomId = randomBytes(8).toString("hex");
    const inviteToken = randomBytes(24).toString("base64url");
    const owner = {
      id: input.ownerId,
      name: input.displayName,
      role: "owner" as const,
      joinedAt: now(),
      online: false,
    };
    const room: RoomRuntime = {
      id: roomId,
      name: input.name.trim() || "Комната без названия",
      ownerId: input.ownerId,
      hostId: input.ownerId,
      hostName: input.displayName,
      channels: defaultChannels(),
      messages: [],
      members: [owner],
      inviteToken,
      clients: new Map(),
      voiceParticipants: new Map(),
    };
    this.rooms.set(room.id, room);
    await this.persist();
    return {
      state: this.state(room),
      invite: createInvite(room.id, room.inviteToken),
      inviteToken: room.inviteToken,
    };
  }

  joinByInvite(input: {
    invite: string;
    displayName: string;
  }): { state: RoomState; room: RoomRuntime } {
    const parsed = parseInvite(input.invite);
    if (!parsed) throw new Error("Некорректная ссылка приглашения");
    const room = this.rooms.get(parsed.roomId);
    if (!room || room.inviteToken !== parsed.inviteToken) {
      throw new Error("Комната не найдена или ссылка приглашения устарела");
    }
    return { state: this.state(room), room };
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (socket) => {
      const client: Partial<ClientConnection> = { socket };
      let closed = false;

      const send = (event: ServerEvent) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      };

      socket.on("message", async (raw) => {
        let event: ClientEvent;
        try {
          event = JSON.parse(raw.toString()) as ClientEvent;
        } catch {
          send({ type: "error", message: "Некорректное сообщение протокола" });
          return;
        }

        try {
          if (event.type === "join") {
            const joined = await this.acceptClient(event, socket);
            client.peerId = joined.peerId;
            client.roomId = joined.roomId;
            client.displayName = joined.displayName;
            send({ type: "state", state: this.state(this.rooms.get(joined.roomId)!) });
            this.broadcastPresence(joined.roomId);
            return;
          }

          if (event.type === "ping") {
            send({ type: "pong" });
            return;
          }

          if (!client.roomId || !client.peerId) {
            send({ type: "error", message: "Сначала подключитесь к комнате" });
            return;
          }

          const room = this.rooms.get(client.roomId);
          if (!room) {
            send({ type: "error", message: "Комната больше не существует" });
            return;
          }

          if (event.type === "signal") {
            const target = room.clients.get(event.toPeerId);
            if (target) {
              target.socket.send(JSON.stringify({
                type: "signal",
                fromPeerId: client.peerId,
                data: event.data,
              }));
            }
            return;
          }

          if (event.type === "message") {
            const content = event.content.trim();
            if (!content || content.length > 4000) {
              send({ type: "error", message: "Сообщение должно содержать от 1 до 4000 символов" });
              return;
            }
            if (!room.channels.some((channel) => channel.id === event.channelId && channel.type === "text")) {
              send({ type: "error", message: "Текстовый канал не найден" });
              return;
            }
            const message: RoomMessage = {
              id: event.messageId?.trim() || id("message"),
              authorId: client.peerId,
              author: client.displayName ?? "Участник",
              content,
              timestamp: now(),
              channelId: event.channelId,
            };
            room.messages.push(message);
            await this.persist();
            this.broadcast(room.id, { type: "message", message });
            return;
          }

          if (event.type === "create_channel") {
            const name = event.name.trim();
            if (!name || name.length > 50) {
              send({ type: "error", message: "Название канала должно содержать от 1 до 50 символов" });
              return;
            }
            const channel: RoomChannel = {
              id: id("channel"),
              name,
              type: event.channelType,
              unreadCount: 0,
              members: event.channelType === "voice" ? 0 : room.clients.size,
            };
            room.channels.push(channel);
            await this.persist();
            this.broadcastPresence(room.id);
            return;
          }

          if (event.type === "voice_join" || event.type === "voice_leave") {
            const channel = room.channels.find(
              (item) => item.id === event.channelId && item.type === "voice",
            );
            if (!channel) {
              send({ type: "error", message: "Голосовой канал не найден" });
              return;
            }
            const participants = room.voiceParticipants.get(event.channelId) ?? new Map<string, string>();
            if (event.type === "voice_join") {
              participants.set(client.peerId, client.displayName ?? "Участник");
              room.voiceParticipants.set(event.channelId, participants);
              for (const [peerId, name] of participants) {
                if (peerId !== client.peerId) {
                  socket.send(JSON.stringify({
                    type: "voice",
                    channelId: event.channelId,
                    peerId,
                    displayName: name,
                    joined: true,
                  }));
                }
              }
            } else {
              participants.delete(client.peerId);
              if (participants.size === 0) room.voiceParticipants.delete(event.channelId);
            }
            await this.persist();
            this.broadcast(room.id, {
              type: "voice",
              channelId: event.channelId,
              peerId: client.peerId,
              displayName: client.displayName ?? "Участник",
              joined: event.type === "voice_join",
            });
            this.broadcastPresence(room.id);
          }
        } catch (error) {
          logger.warn({ err: error }, "WebSocket event failed");
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Ошибка обработки события",
          });
        }
      });

      socket.on("close", () => {
        if (closed) return;
        closed = true;
        if (client.roomId && client.peerId) {
          void this.removeClient(client.roomId, client.peerId, client.socket);
        }
      });

      socket.on("error", (error) => {
        logger.warn({ err: error }, "WebSocket client error");
      });
    });
  }

  private async acceptClient(
    event: Extract<ClientEvent, { type: "join" }>,
    socket: WebSocket,
  ): Promise<ClientConnection> {
    const room = this.rooms.get(event.roomId);
    if (!room || room.inviteToken !== event.inviteToken) {
      throw new Error("Комната не найдена или ссылка приглашения устарела");
    }
    const displayName = event.displayName.trim().slice(0, 40);
    if (!event.peerId || !displayName) throw new Error("Необходимо имя участника");

    const previous = room.clients.get(event.peerId);
    if (previous && previous.socket !== socket) previous.socket.close(1000, "reconnected");

    const existing = room.members.find((member) => member.id === event.peerId);
    if (existing) {
      existing.name = displayName;
      existing.online = true;
    } else {
      room.members.push({
        id: event.peerId,
        name: displayName,
        role: "member",
        joinedAt: now(),
        online: true,
      });
    }
    room.clients.set(event.peerId, {
      peerId: event.peerId,
      displayName,
      roomId: room.id,
      socket,
    });
    if (!room.hostId || !room.clients.has(room.hostId)) this.electHost(room);
    await this.persist();
    return room.clients.get(event.peerId)!;
  }

  private async removeClient(roomId: string, peerId: string, socket?: WebSocket): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const current = room.clients.get(peerId);
    if (current && socket && current.socket !== socket) return;
    room.clients.delete(peerId);
    const member = room.members.find((item) => item.id === peerId);
    if (member) member.online = false;
    for (const [channelId, participants] of room.voiceParticipants) {
      participants.delete(peerId);
      if (participants.size === 0) room.voiceParticipants.delete(channelId);
    }
    if (room.hostId === peerId) this.electHost(room);
    await this.persist();
    this.broadcastPresence(room.id);
  }

  private electHost(room: RoomRuntime): void {
    const candidate = [...room.clients.values()]
      .sort((left, right) => left.peerId.localeCompare(right.peerId))[0];
    if (candidate) {
      room.hostId = candidate.peerId;
      room.hostName = candidate.displayName;
    } else {
      room.hostId = room.ownerId;
      room.hostName = room.members.find((member) => member.id === room.ownerId)?.name ?? "Владелец";
    }
  }

  private state(room: RoomRuntime): RoomState {
    const onlineIds = new Set(room.clients.keys());
    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      hostId: room.hostId,
      hostName: room.hostName,
      channels: room.channels.map((channel) => ({
        ...channel,
        members: channel.type === "voice" ? channel.members : room.clients.size,
      })),
      messages: room.messages.slice(-500),
      members: room.members.map((member) => ({ ...member, online: onlineIds.has(member.id) })),
      voiceParticipants: Object.fromEntries(
        [...room.voiceParticipants.entries()].map(([channelId, participants]) => [
          channelId,
          [...participants.entries()].map(([id, name]) => ({ id, name })),
        ]),
      ),
    };
  }

  private broadcast(roomId: string, event: ServerEvent): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const client of room.clients.values()) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(event));
    }
  }

  private broadcastPresence(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) this.broadcast(roomId, { type: "presence", state: this.state(room) });
  }

  private async persist(): Promise<void> {
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
      for (const { clients: _clients, voiceParticipants: _voiceParticipants, ...room } of this.rooms.values()) {
        statement.run(room.id, room.inviteToken, JSON.stringify(room), now());
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      logger.error({ err: error }, "Could not persist room store");
      throw error;
    }
  }
}