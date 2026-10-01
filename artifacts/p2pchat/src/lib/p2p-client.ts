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
import { debugLog } from "@/lib/debug-log";
import {
  applyAutoPublicUrl,
  collectNodeEndpoints,
  getPublicUrl,
  isPublicHttpOrigin,
  orderInviteOrigins,
  warmIceServers,
} from "@/lib/network-settings";

export { VoiceMesh, type VoiceMeshOptions, type VoicePeerStatus } from "@/lib/voice-mesh";
export {
  buildIceServers,
  DEFAULT_FREE_TURN,
  getPublicUrl,
  isCustomTurnConfigured,
  isTurnConfigured,
  loadIceSettings,
  saveIceSettings,
  setPublicUrl,
  warmIceServers,
  type IceSettings,
  type TurnConfig,
} from "@/lib/network-settings";
export { restartPublicTunnel } from "@/lib/desktop-bridge";

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
  if (localNode?.publicOrigin) applyAutoPublicUrl(localNode.publicOrigin);
  void warmIceServers();
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
  const publicUrl = getPublicUrl() || localNode?.publicOrigin || "";
  const endpoints = collectNodeEndpoints(
    localNode
      ? {
          origin: localNode.origin,
          lanOrigins: localNode.lanOrigins,
          publicOrigin: localNode.publicOrigin,
        }
      : null,
  );
  const state = createInitialRoomState({
    roomId,
    name: input.name,
    ownerId: identity.peerId,
    ownerName: identity.displayName,
    ownerPublicKey: identity.publicKey,
    endpoints,
  });
  const inviteOrigins = orderInviteOrigins([
    ...(publicUrl ? [publicUrl] : []),
    ...(localNode?.lanOrigins ?? []),
    ...(bootstrap && isPublicHttpOrigin(bootstrap) ? [bootstrap] : []),
    ...(localNode && !publicUrl && localNode.lanOrigins.length === 0 ? [localNode.origin] : []),
  ]);
  const invite = buildInvite({
    roomId,
    inviteToken,
    roomKey,
    origins:
      inviteOrigins.length > 0
        ? inviteOrigins
        : bootstrap
          ? [bootstrap]
          : localNode
            ? [localNode.origin]
            : [],
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
  debugLog("room", "created", {
    roomId,
    endpoints,
    inviteOrigins: inviteOrigins.slice(0, 5),
    publicUrl,
    tunnelError: localNode?.tunnelError,
  });
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
  if (localNode?.publicOrigin) applyAutoPublicUrl(localNode.publicOrigin);
  void warmIceServers();
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
  debugLog("room", "prepareJoin", {
    roomId: meta.roomId,
    origins: origins.slice(0, 8),
    hasLocalNode: Boolean(localNode),
    publicOrigin: localNode?.publicOrigin,
    tunnelError: localNode?.tunnelError,
  });
  return { identity, meta, localNode };
}

export function rebuildInviteOrigins(meta: RoomMeta, extraOrigins: string[] = []): RoomMeta {
  const publicUrl = getPublicUrl();
  const origins = orderInviteOrigins([
    ...(publicUrl ? [publicUrl] : []),
    ...extraOrigins,
    ...meta.bootstrapOrigins.filter((origin) => isPublicHttpOrigin(origin)),
  ]);
  if (origins.length === 0) return meta;
  const invite = buildInvite({
    roomId: meta.roomId,
    inviteToken: meta.inviteToken,
    roomKey: meta.roomKey,
    origins,
  });
  const next = { ...meta, invite };
  saveRoomMeta(next);
  return next;
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
  if (localNode?.publicOrigin) applyAutoPublicUrl(localNode.publicOrigin);
  void warmIceServers();
  const endpoints = collectNodeEndpoints(
    localNode
      ? {
          origin: localNode.origin,
          lanOrigins: localNode.lanOrigins,
          publicOrigin: localNode.publicOrigin,
        }
      : null,
  );
  let lastStatus: string | null = null;
  const session = new RoomSession({
    roomId: meta.roomId,
    inviteToken: meta.inviteToken,
    roomKey: meta.roomKey,
    identity,
    bootstrapOrigins: meta.bootstrapOrigins,
    localNode: localNode
      ? {
          origin: localNode.origin,
          endpoints: endpoints.length > 0 ? endpoints : [localNode.origin, ...localNode.lanOrigins],
        }
      : null,
    initial: loadSnapshot(),
    onView: (view) => {
      const key = `${view.status}:${view.isCoordinator}:${view.state?.hostId}:${view.state?.epoch}`;
      if (key !== lastStatus) {
        lastStatus = key;
        debugLog("session", `status=${view.status}`, {
          coordinator: view.isCoordinator,
          hostId: view.state?.hostId,
          online: view.state?.members.filter((m) => m.online).length,
          epoch: view.state?.epoch,
        });
      }
      input.onView(view);
    },
    onPersist: saveSnapshot,
    onError: (message) => {
      debugLog("session", message, undefined, "error");
      input.onError?.(message);
    },
    onVoice: (event) => {
      debugLog("voice", event.joined ? "peer joined channel" : "peer left channel", {
        channelId: event.channelId,
        peerId: event.peerId,
        name: event.displayName,
      });
      input.onVoice?.(event);
    },
    onSignal: (event) => {
      const kind =
        event.data && typeof event.data === "object" && "kind" in event.data
          ? String((event.data as { kind?: string }).kind)
          : "unknown";
      debugLog("signal", `from ${event.fromPeerId}`, { kind }, "debug");
      input.onSignal?.(event);
    },
  });
  debugLog("session", "start", { roomId: meta.roomId, endpoints, bootstrap: meta.bootstrapOrigins });
  session.start();
  return {
    session,
    close: () => {
      debugLog("session", "stop");
      session.stop();
    },
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
