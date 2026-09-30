import { generateRoomKey, loadOrCreateIdentity, randomToken, type StoredIdentity } from "@workspace/p2p-identity";
import {
  buildInvite,
  createInitialRoomState,
  normalizeOrigin,
  parseInvite as parseProtocolInvite,
  type ChannelType,
  type WireMember,
  type WireRoomState,
} from "@workspace/p2p-protocol";
import {
  RoomSession,
  type SessionSnapshot,
  type SessionStatus,
  type SessionView,
} from "@workspace/p2p-room";
import { ensureLocalNode, type LocalNodeInfo } from "@/lib/desktop-bridge";

export type { ChannelType, WireRoomState as RoomState, WireMember as RoomMember };

export type RoomChannel = WireRoomState["channels"][number];

export type RoomMessage = {
  id: string;
  authorId: string;
  author: string;
  content: string;
  timestamp: string;
  channelId: string;
};

const BOOTSTRAP_KEY = "p2pchat-api-origin";
const ROOM_META_KEY = "p2pchat-room-meta";
const SESSION_SNAPSHOT_KEY = "p2pchat-session-snapshot";

export type RoomMeta = {
  roomId: string;
  inviteToken: string;
  roomKey: string;
  invite: string;
  bootstrapOrigins: string[];
};

export function isDesktopShell(): boolean {
  return "__TAURI_INTERNALS__" in window || window.location.hostname.endsWith("tauri.localhost");
}

export function getPeerId(): string {
  return loadOrCreateIdentity("Участник").peerId;
}

export function getBootstrapOrigin(): string {
  const configured = window.localStorage.getItem(BOOTSTRAP_KEY)?.trim();
  if (configured) return normalizeOrigin(configured);
  if (!isDesktopShell() && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
    return window.location.origin;
  }
  return "";
}

export function setBootstrapOrigin(origin: string): void {
  const normalized = normalizeOrigin(origin);
  if (normalized) window.localStorage.setItem(BOOTSTRAP_KEY, normalized);
  else window.localStorage.removeItem(BOOTSTRAP_KEY);
}

/** @deprecated use getBootstrapOrigin */
export const getApiOrigin = getBootstrapOrigin;
/** @deprecated use setBootstrapOrigin */
export const setApiOrigin = setBootstrapOrigin;

export function isLocalhostOrigin(value: string): boolean {
  try {
    const origins = parseProtocolInvite(value)?.origins ?? [value];
    return origins.some((origin) => {
      const host = new URL(origin).hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    });
  } catch {
    return /127\.0\.0\.1|localhost/i.test(value);
  }
}

export function parseInvite(value: string): {
  roomId: string;
  inviteToken: string;
  roomKey?: string;
  origins: string[];
  apiOrigin?: string;
} | null {
  const parsed = parseProtocolInvite(value);
  if (!parsed) return null;
  return {
    roomId: parsed.roomId,
    inviteToken: parsed.inviteToken,
    roomKey: parsed.roomKey,
    origins: parsed.origins,
    apiOrigin: parsed.origins[0],
  };
}

export function saveRoomMeta(meta: RoomMeta): void {
  window.localStorage.setItem(ROOM_META_KEY, JSON.stringify(meta));
}

export function loadRoomMeta(): RoomMeta | null {
  try {
    const raw = window.localStorage.getItem(ROOM_META_KEY);
    return raw ? (JSON.parse(raw) as RoomMeta) : null;
  } catch {
    return null;
  }
}

function saveSnapshot(snapshot: SessionSnapshot): void {
  window.localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function loadSnapshot(): SessionSnapshot | null {
  try {
    const raw = window.localStorage.getItem(SESSION_SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as SessionSnapshot) : null;
  } catch {
    return null;
  }
}

export type CreatedRoom = {
  identity: StoredIdentity;
  meta: RoomMeta;
  state: WireRoomState;
  localNode: LocalNodeInfo | null;
};

export async function createLocalRoom(input: {
  name: string;
  displayName: string;
  bootstrapOrigin?: string;
}): Promise<CreatedRoom> {
  const identity = loadOrCreateIdentity(input.displayName);
  const localNode = await ensureLocalNode();
  const bootstrap = normalizeOrigin(input.bootstrapOrigin ?? getBootstrapOrigin());
  if (bootstrap) setBootstrapOrigin(bootstrap);
  if (!localNode && !bootstrap) {
    throw new Error(
      isDesktopShell()
        ? "Не удалось запустить локальный узел комнаты"
        : "Укажите адрес bootstrap-узла или откройте приложение на компьютере с desktop-сборкой",
    );
  }

  const roomId = randomToken(8);
  const inviteToken = randomToken(24);
  const roomKey = generateRoomKey();
  const endpoints = localNode
    ? [localNode.origin, ...localNode.lanOrigins].filter(
        (origin, index, list) => list.indexOf(origin) === index,
      )
    : [];
  const state = createInitialRoomState({
    roomId,
    name: input.name,
    ownerId: identity.peerId,
    ownerName: identity.displayName,
    ownerPublicKey: identity.publicKey,
    endpoints,
  });
  const inviteOrigins = [
    ...(localNode?.lanOrigins ?? []),
    ...(bootstrap && !isLocalhostOrigin(bootstrap) ? [bootstrap] : []),
    ...(localNode && (localNode.lanOrigins.length === 0 || !bootstrap) ? [localNode.origin] : []),
  ].filter((origin, index, list) => list.indexOf(origin) === index);
  const invite = buildInvite({
    roomId,
    inviteToken,
    roomKey,
    origins: inviteOrigins.length > 0 ? inviteOrigins : bootstrap ? [bootstrap] : [localNode!.origin],
  });
  const meta: RoomMeta = {
    roomId,
    inviteToken,
    roomKey,
    invite,
    bootstrapOrigins: bootstrap ? [bootstrap] : [],
  };
  saveRoomMeta(meta);
  saveSnapshot({ state, outbox: [] });
  return { identity, meta, state, localNode };
}

export async function prepareJoin(input: {
  invite: string;
  displayName: string;
  bootstrapOrigin?: string;
}): Promise<{ identity: StoredIdentity; meta: RoomMeta; localNode: LocalNodeInfo | null }> {
  const parsed = parseInvite(input.invite);
  if (!parsed) throw new Error("Некорректная ссылка приглашения");
  if (!parsed.roomKey) throw new Error("В ссылке нет ключа шифрования — попросите новую пригласительную ссылку");

  const identity = loadOrCreateIdentity(input.displayName);
  const localNode = await ensureLocalNode();
  const bootstrap = normalizeOrigin(input.bootstrapOrigin ?? "");
  if (bootstrap) setBootstrapOrigin(bootstrap);
  const origins = [
    ...parsed.origins,
    ...(bootstrap ? [bootstrap] : []),
    ...(!isDesktopShell() && getBootstrapOrigin() ? [getBootstrapOrigin()] : []),
  ].filter((origin, index, list) => list.indexOf(origin) === index);

  if (origins.length === 0 && !localNode) {
    throw new Error("В ссылке нет адреса узла — укажите bootstrap вручную");
  }

  const meta: RoomMeta = {
    roomId: parsed.roomId,
    inviteToken: parsed.inviteToken,
    roomKey: parsed.roomKey,
    invite: input.invite.trim(),
    bootstrapOrigins: origins,
  };
  saveRoomMeta(meta);
  return { identity, meta, localNode };
}

export type OpenSessionHandles = {
  session: RoomSession;
  close: () => void;
};

export async function openRoomSession(input: {
  onView: (view: SessionView) => void;
  onError?: (message: string) => void;
  onVoice?: (event: { channelId: string; peerId: string; displayName: string; joined: boolean }) => void;
  onSignal?: (event: { fromPeerId: string; data: unknown }) => void;
}): Promise<OpenSessionHandles | null> {
  const meta = loadRoomMeta();
  if (!meta) return null;
  const identity = loadOrCreateIdentity("Участник");
  const localNode = await ensureLocalNode();
  const session = new RoomSession({
    roomId: meta.roomId,
    inviteToken: meta.inviteToken,
    roomKey: meta.roomKey,
    identity,
    bootstrapOrigins: meta.bootstrapOrigins,
    localNode: localNode
      ? {
          origin: localNode.origin,
          endpoints: [localNode.origin, ...localNode.lanOrigins].filter(
            (origin, index, list) => list.indexOf(origin) === index,
          ),
        }
      : null,
    initial: loadSnapshot(),
    onView: input.onView,
    onPersist: saveSnapshot,
    onError: input.onError,
    onVoice: input.onVoice,
    onSignal: input.onSignal,
  });
  session.start();
  return {
    session,
    close: () => session.stop(),
  };
}

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "connected":
      return "Синхронизировано между участниками";
    case "connecting":
      return "Подключаемся к комнате…";
    case "reconnecting":
      return "Переподключаемся к комнате…";
    default:
      return "Нет соединения с комнатой";
  }
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
