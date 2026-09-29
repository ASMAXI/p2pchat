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

export type RoomEnvelope = {
  room: RoomState;
  invite?: string;
  inviteToken?: string;
};

export type RoomSocketEvent =
  | { type: "state"; state: RoomState }
  | { type: "message"; message: RoomMessage }
  | { type: "presence"; state: RoomState }
  | { type: "voice"; channelId: string; peerId: string; displayName: string; joined: boolean }
  | { type: "signal"; fromPeerId: string; data: unknown }
  | { type: "error"; message: string }
  | { type: "pong" };

export type RoomSocketCommand =
  | {
      type: "join";
      roomId: string;
      inviteToken: string;
      peerId: string;
      displayName: string;
    }
  | { type: "message"; channelId: string; content: string; messageId?: string }
  | { type: "create_channel"; name: string; channelType: ChannelType }
  | { type: "voice_join"; channelId: string }
  | { type: "voice_leave"; channelId: string }
  | { type: "signal"; toPeerId: string; data: unknown }
  | { type: "ping" };

type SocketStatus = "connecting" | "connected" | "offline";

const API_ORIGIN_KEY = "p2pchat-api-origin";
const PEER_ID_KEY = "p2pchat-peer-id";

function normalizeApiOrigin(origin: string): string {
  return origin.trim().replace(/\/api\/?$/, "").replace(/\/$/, "");
}

export function isDesktopShell(): boolean {
  return "__TAURI_INTERNALS__" in window || window.location.hostname.endsWith("tauri.localhost");
}

export function getApiOrigin(): string {
  const configured = window.localStorage.getItem(API_ORIGIN_KEY)?.trim();
  if (configured) return normalizeApiOrigin(configured);
  if (!isDesktopShell() && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
    return window.location.origin;
  }
  return "";
}

export function setApiOrigin(origin: string): void {
  const normalized = normalizeApiOrigin(origin);
  if (normalized) window.localStorage.setItem(API_ORIGIN_KEY, normalized);
  else window.localStorage.removeItem(API_ORIGIN_KEY);
}

function apiBase(): string {
  const origin = getApiOrigin();
  if (origin) return `${origin}/api`;
  return "";
}

function apiRequest(path: string, init: RequestInit): Promise<Response> {
  const base = apiBase();
  if (!base) throw new Error("Для desktop-подключения укажите адрес API сервера");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function readResponse(response: Response): Promise<RoomEnvelope> {
  const payload = (await response.json()) as RoomEnvelope & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Сервер не принял запрос");
  return payload;
}

export function getPeerId(): string {
  const existing = window.localStorage.getItem(PEER_ID_KEY);
  if (existing) return existing;
  const value =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `peer-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  window.localStorage.setItem(PEER_ID_KEY, value);
  return value;
}

export function createRoom(input: {
  name: string;
  peerId: string;
  displayName: string;
}): Promise<RoomEnvelope> {
  return apiRequest("/rooms", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(readResponse);
}

export function joinRoom(input: {
  invite: string;
  displayName: string;
}, apiOrigin?: string): Promise<RoomEnvelope> {
  if (apiOrigin) setApiOrigin(apiOrigin);
  return apiRequest("/rooms/join", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(readResponse);
}

export function parseInvite(value: string): { roomId: string; inviteToken: string; apiOrigin?: string } | null {
  const input = value.trim();
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const roomId = url.searchParams.get("room");
    const inviteToken = url.searchParams.get("token");
    const apiOrigin = url.searchParams.get("api") ?? undefined;
    if (roomId && inviteToken) return { roomId, inviteToken, apiOrigin };
  } catch {
    // Compact legacy links are handled below.
  }
  const match = input.match(/(?:join[/:])([^/?#]+)(?:[/:]([^/?#]+))?/i);
  if (!match?.[1] || !match[2]) return null;
  return {
    roomId: decodeURIComponent(match[1]),
    inviteToken: decodeURIComponent(match[2]),
  };
}

export function inviteWithApiOrigin(invite: string, apiOrigin: string): string {
  if (!apiOrigin) return invite;
  try {
    const url = new URL(invite);
    url.searchParams.set("api", normalizeApiOrigin(apiOrigin));
    return url.toString();
  } catch {
    return invite;
  }
}

export function connectRoom(
  input: {
    roomId: string;
    inviteToken: string;
    peerId: string;
    displayName: string;
  },
  onEvent: (event: RoomSocketEvent) => void,
  onStatus: (status: SocketStatus) => void,
): { send: (command: RoomSocketCommand) => void; close: () => void } {
  const base = apiBase();
  if (!base) {
    onStatus("offline");
    return { send: () => undefined, close: () => undefined };
  }

  const wsBase = base.replace(/^http/, "ws");
  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let closed = false;

  const open = () => {
    if (closed) return;
    onStatus("connecting");
    socket = new WebSocket(`${wsBase}/ws`);
    socket.onopen = () => {
      onStatus("connected");
      socket?.send(JSON.stringify({ type: "join", ...input }));
    };
    socket.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data as string) as RoomSocketEvent);
      } catch {
        onEvent({ type: "error", message: "Получено некорректное событие сервера" });
      }
    };
    socket.onerror = () => onStatus("offline");
    socket.onclose = () => {
      socket = null;
      onStatus("offline");
      if (!closed) reconnectTimer = window.setTimeout(open, 1800);
    };
  };

  open();

  return {
    send: (command) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
      else onEvent({ type: "error", message: "Нет соединения с комнатой" });
    },
    close: () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },
  };
}

type VoiceSignal =
  | { kind: "offer"; description: RTCSessionDescriptionInit }
  | { kind: "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export class VoiceMesh {
  private readonly selfId: string;
  private readonly sendSignal: (toPeerId: string, data: VoiceSignal) => void;
  private stream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private audioElements = new Map<string, HTMLAudioElement>();

  constructor(selfId: string, sendSignal: (toPeerId: string, data: VoiceSignal) => void) {
    this.selfId = selfId;
    this.sendSignal = sendSignal;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Браузер не поддерживает доступ к микрофону");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  async addPeer(peerId: string, initiator: boolean): Promise<void> {
    if (peerId === this.selfId || this.peers.has(peerId)) return;
    if (!this.stream) await this.start();
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.peers.set(peerId, peer);
    for (const track of this.stream?.getTracks() ?? []) peer.addTrack(track, this.stream!);
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, { kind: "ice", candidate: event.candidate.toJSON() });
      }
    };
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      let audio = this.audioElements.get(peerId);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.setAttribute("aria-hidden", "true");
        audio.style.display = "none";
        document.body.appendChild(audio);
        this.audioElements.set(peerId, audio);
      }
      audio.srcObject = stream;
    };
    peer.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(peer.connectionState)) this.removePeer(peerId);
    };
    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.sendSignal(peerId, { kind: "offer", description: offer });
    }
  }

  async handleSignal(fromPeerId: string, data: unknown): Promise<void> {
    const signal = data as Partial<VoiceSignal>;
    if (!signal.kind) return;
    if (!this.peers.has(fromPeerId)) await this.addPeer(fromPeerId, false);
    const peer = this.peers.get(fromPeerId);
    if (!peer) return;
    if (signal.kind === "offer" && signal.description) {
      await peer.setRemoteDescription(signal.description);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal(fromPeerId, { kind: "answer", description: answer });
    } else if (signal.kind === "answer" && signal.description) {
      await peer.setRemoteDescription(signal.description);
    } else if (signal.kind === "ice" && signal.candidate) {
      await peer.addIceCandidate(signal.candidate);
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  setDeafened(deafened: boolean): void {
    for (const audio of this.audioElements.values()) audio.muted = deafened;
  }

  removePeer(peerId: string): void {
    this.peers.get(peerId)?.close();
    this.peers.delete(peerId);
    const audio = this.audioElements.get(peerId);
    audio?.remove();
    this.audioElements.delete(peerId);
  }

  stop(): void {
    for (const peerId of this.peers.keys()) this.removePeer(peerId);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}