/**
 * Wire protocol shared by clients, the Node bootstrap node and the Rust desktop node
 * (`artifacts/p2pchat/src-tauri/src/local_hub.rs`). Any change here must be mirrored there
 * and must bump PROTOCOL_VERSION when it is not backwards compatible.
 */
export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  maxPlainMessageLength: 250_000,
  maxCiphertextLength: 400_000,
  maxStoredMessages: 1000,
  maxChannelNameLength: 50,
  maxChannels: 50,
  rateWindowMs: 5000,
  rateMaxMessages: 12,
  joinClockSkewMs: 10 * 60 * 1000,
} as const;

export type ChannelType = "text" | "voice";
export type MemberRole = "owner" | "admin" | "member";

export type WireChannel = {
  id: string;
  name: string;
  type: ChannelType;
  unreadCount: number;
  members: number;
};

export type WireMessage = {
  id: string;
  channelId: string;
  authorId: string;
  author: string;
  authorPublicKey: string;
  /** AES-GCM ciphertext (`e1.<nonce>.<sealed>`); nodes never see plaintext. */
  content: string;
  timestamp: string;
  signature: string;
};

export type WireMember = {
  id: string;
  name: string;
  role: MemberRole;
  joinedAt: string;
  online: boolean;
  publicKey?: string;
  /** Addresses of this member's own node, used to migrate the coordinator role. */
  endpoints?: string[];
};

export type WireRoomState = {
  id: string;
  name: string;
  ownerId: string;
  hostId: string;
  hostName: string;
  epoch: number;
  channels: WireChannel[];
  messages: WireMessage[];
  members: WireMember[];
  voiceParticipants: Record<string, Array<{ id: string; name: string }>>;
};

export type OutgoingMessage = Pick<WireMessage, "id" | "channelId" | "content" | "timestamp" | "signature">;

export type ClientCommand =
  | {
      type: "join";
      protocol: number;
      roomId: string;
      inviteToken: string;
      peerId: string;
      displayName: string;
      publicKey: string;
      ts: number;
      proof: string;
      endpoints: string[];
      /** Set when the client connects to its own node to act as coordinator. */
      host: boolean;
      snapshot?: WireRoomState;
    }
  | { type: "message"; message: OutgoingMessage }
  | { type: "create_channel"; name: string; channelType: ChannelType }
  | { type: "voice_join"; channelId: string }
  | { type: "voice_leave"; channelId: string }
  | { type: "signal"; toPeerId: string; data: unknown }
  | { type: "leave"; redirect?: string }
  | { type: "ping"; nonce: number };

export type ErrorCode = "NOT_COORDINATOR" | "UNAUTHORIZED" | "NOT_FOUND" | "PROTOCOL" | "RATE_LIMIT" | "INVALID";

export type ServerEvent =
  | { type: "state"; state: WireRoomState }
  | { type: "presence"; state: WireRoomState }
  | { type: "message"; message: WireMessage }
  | { type: "voice"; channelId: string; peerId: string; displayName: string; joined: boolean }
  | { type: "signal"; fromPeerId: string; data: unknown }
  | { type: "error"; code: ErrorCode; message: string; redirect?: string[] }
  | { type: "pong"; nonce: number };

export type RoomStatus = {
  roomId: string;
  hosting: boolean;
  alwaysHost: boolean;
  epoch: number;
  hostId: string;
};

export function joinProofText(roomId: string, peerId: string, ts: number): string {
  return `p2pchat/v${PROTOCOL_VERSION}/join/${roomId}/${peerId}/${ts}`;
}

export function messageProofText(
  roomId: string,
  message: Pick<WireMessage, "id" | "channelId" | "authorId" | "timestamp" | "content">,
): string {
  return `p2pchat/v${PROTOCOL_VERSION}/msg/${roomId}/${message.id}/${message.channelId}/${message.authorId}/${message.timestamp}/${message.content}`;
}

export function messageAad(roomId: string, messageId: string): string {
  return `${roomId}/${messageId}`;
}

export function compareMessages(left: WireMessage, right: WireMessage): number {
  if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function defaultChannels(): WireChannel[] {
  return [
    { id: "general", name: "общий", type: "text", unreadCount: 0, members: 0 },
    { id: "lounge", name: "вечерний лоунж", type: "voice", unreadCount: 0, members: 0 },
  ];
}

export function createInitialRoomState(input: {
  roomId: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerPublicKey: string;
  endpoints: string[];
}): WireRoomState {
  return {
    id: input.roomId,
    name: input.name.normalize("NFC").trim().slice(0, 80) || "Комната без названия",
    ownerId: input.ownerId,
    hostId: input.ownerId,
    hostName: input.ownerName,
    epoch: 0,
    channels: defaultChannels(),
    messages: [],
    members: [
      {
        id: input.ownerId,
        name: input.ownerName,
        role: "owner",
        joinedAt: new Date().toISOString(),
        online: false,
        publicKey: input.ownerPublicKey,
        endpoints: input.endpoints,
      },
    ],
    voiceParticipants: {},
  };
}

export type Invite = {
  roomId: string;
  inviteToken: string;
  roomKey?: string;
  origins: string[];
};

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/api\/?$/, "").replace(/\/$/, "");
}

export function buildInvite(invite: Invite): string {
  const params = new URLSearchParams();
  params.set("room", invite.roomId);
  params.set("token", invite.inviteToken);
  if (invite.roomKey) params.set("key", invite.roomKey);
  for (const origin of invite.origins) params.append("api", normalizeOrigin(origin));
  return `p2pchat://join?${params.toString()}`;
}

export function parseInvite(value: string): Invite | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const roomId = url.searchParams.get("room");
    const inviteToken = url.searchParams.get("token");
    if (!roomId || !inviteToken) return null;
    return {
      roomId,
      inviteToken,
      roomKey: url.searchParams.get("key") ?? undefined,
      origins: url.searchParams.getAll("api").map(normalizeOrigin).filter(Boolean),
    };
  } catch {
    return null;
  }
}
