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
  createSecureIdentityStorage,
  getSecureRoomMetaRaw,
  getSecureSavedServersRaw,
  setSecureRoomMetaRaw,
  setSecureSavedServersRaw,
} from "@/lib/secure-storage";
import {
  applyAutoPublicUrl,
  collectNodeEndpoints,
  filterShareableInviteOrigins,
  getPublicUrl,
  isPublicHttpOrigin,
  orderBootstrapOrigins,
  warmIceServers,
} from "@/lib/network-settings";

const identityStorage = createSecureIdentityStorage();

export {
  VoiceMesh,
  getActiveVoiceMesh,
  type VoiceMeshOptions,
  type VoicePeerStatus,
  type VoiceQualitySnapshot,
  type MicProcessing,
} from "@/lib/voice-mesh";
export {
  buildIceServers,
  DEFAULT_FREE_TURN,
  getLastIceSource,
  getPublicUrl,
  isCustomTurnConfigured,
  isTurnConfigured,
  loadIceSettings,
  saveIceSettings,
  setPublicUrl,
  warmIceServers,
  type IceSettings,
  type IceSource,
  type TurnConfig,
} from "@/lib/network-settings";
export { restartPublicTunnel } from "@/lib/desktop-bridge";
export { checkForAppUpdate, currentAppVersion, installAppUpdate, type AppUpdateInfo } from "@/lib/app-update";

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

const PROFILE_NAME_KEY = "p2pchat-profile-name";
const BOOTSTRAP_KEY = "p2pchat-api-origin";
const SESSION_SNAPSHOT_KEY = "p2pchat-session-snapshot";

/** Prefer saved profile name; empty string keeps existing identity name. */
export function readProfileDisplayName(): string {
  try {
    const raw = window.localStorage.getItem(PROFILE_NAME_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return parsed.trim();
    return raw.trim();
  } catch {
    return "";
  }
}

export function writeProfileDisplayName(name: string): void {
  window.localStorage.setItem(PROFILE_NAME_KEY, JSON.stringify(name.trim() || "Участник"));
}

export type RoomMeta = {
  roomId: string;
  inviteToken: string;
  roomKey: string;
  invite: string;
  bootstrapOrigins: string[];
};

export type SavedServer = {
  roomId: string;
  name: string;
  invite: string;
  inviteToken: string;
  roomKey: string;
  role: string;
  hostName?: string;
  lastJoinedAt: number;
};

function clearSnapshot(): void {
  window.localStorage.removeItem(SESSION_SNAPSHOT_KEY);
}

export function loadSavedServers(): SavedServer[] {
  try {
    const raw = getSecureSavedServersRaw();
    if (!raw) return migrateLegacyServer();
    const parsed = JSON.parse(raw) as SavedServer[];
    if (!Array.isArray(parsed)) return migrateLegacyServer();
    const list = parsed
      .filter((item) => item?.roomId && item?.invite && item?.inviteToken && item?.roomKey)
      .sort((left, right) => right.lastJoinedAt - left.lastJoinedAt);
    return list.length > 0 ? list : migrateLegacyServer();
  } catch {
    return migrateLegacyServer();
  }
}

function migrateLegacyServer(): SavedServer[] {
  try {
    const raw = window.localStorage.getItem("p2pchat-server");
    const meta = loadRoomMeta();
    if (!raw || !meta?.invite) return [];
    const server = JSON.parse(raw) as {
      roomId?: string;
      name?: string;
      role?: string;
      hostName?: string;
    };
    if (!server.roomId || server.roomId !== meta.roomId) return [];
    const saved: SavedServer = {
      roomId: meta.roomId,
      name: server.name || "Комната",
      invite: meta.invite,
      inviteToken: meta.inviteToken,
      roomKey: meta.roomKey,
      role: server.role || "Участник",
      hostName: server.hostName,
      lastJoinedAt: Date.now(),
    };
    setSecureSavedServersRaw(JSON.stringify([saved]));
    return [saved];
  } catch {
    return [];
  }
}

export function upsertSavedServer(input: Omit<SavedServer, "lastJoinedAt"> & { lastJoinedAt?: number }): SavedServer[] {
  const next: SavedServer = {
    ...input,
    lastJoinedAt: input.lastJoinedAt ?? Date.now(),
  };
  const list = loadSavedServers().filter((item) => item.roomId !== next.roomId);
  list.unshift(next);
  setSecureSavedServersRaw(JSON.stringify(list.slice(0, 24)));
  return list;
}

export function removeSavedServer(roomId: string): SavedServer[] {
  const list = loadSavedServers().filter((item) => item.roomId !== roomId);
  setSecureSavedServersRaw(JSON.stringify(list));
  return list;
}

/** Activate a previously joined room without a fresh invite paste. */
export function activateSavedServer(server: SavedServer): RoomMeta {
  const parsed = parseInvite(server.invite);
  const origins = orderBootstrapOrigins(
    parsed?.origins?.length
      ? parsed.origins
      : loadRoomMeta()?.roomId === server.roomId
        ? loadRoomMeta()?.bootstrapOrigins ?? []
        : [],
  );
  const meta: RoomMeta = {
    roomId: server.roomId,
    inviteToken: server.inviteToken,
    roomKey: server.roomKey,
    invite: server.invite,
    bootstrapOrigins: origins,
  };
  const current = loadSnapshot();
  if (!current?.state || current.state.id !== server.roomId) clearSnapshot();
  saveRoomMeta(meta);
  upsertSavedServer(server);
  return meta;
}

export function leaveCurrentRoom(): void {
  clearSnapshot();
  setSecureRoomMetaRaw(null);
}

export function isDesktopShell(): boolean {
  return "__TAURI_INTERNALS__" in window || window.location.hostname.endsWith("tauri.localhost");
}

export function getPeerId(): string {
  return loadOrCreateIdentity(readProfileDisplayName() || "", identityStorage).peerId;
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
  setSecureRoomMetaRaw(JSON.stringify(meta));
}

export function loadRoomMeta(): RoomMeta | null {
  try {
    const raw = getSecureRoomMetaRaw();
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
  const identity = loadOrCreateIdentity(input.displayName.trim() || readProfileDisplayName() || "Участник", identityStorage);
  writeProfileDisplayName(identity.displayName);
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
  // Prefer the live tunnel from this start — stored public URL is often a dead Quick Tunnel hostname.
  const publicUrl = localNode?.publicOrigin || getPublicUrl() || "";
  if (publicUrl) applyAutoPublicUrl(publicUrl);
  const endpoints = collectNodeEndpoints(
    localNode
      ? {
          origin: localNode.origin,
          lanOrigins: localNode.lanOrigins,
          publicOrigin: localNode.publicOrigin || publicUrl || null,
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
  const inviteOrigins = filterShareableInviteOrigins([
    ...(publicUrl ? [publicUrl] : []),
    ...(localNode?.lanOrigins ?? []),
    ...(bootstrap && isPublicHttpOrigin(bootstrap) ? [bootstrap] : []),
    ...(localNode && !publicUrl && localNode.lanOrigins.length === 0 ? [localNode.origin] : []),
  ]);
  const origins =
    inviteOrigins.length > 0
      ? inviteOrigins
      : bootstrap
        ? [bootstrap]
        : localNode
          ? [localNode.origin]
          : [];
  const invite = buildInvite({
    roomId,
    inviteToken,
    roomKey,
    origins,
  });
  const meta: RoomMeta = {
    roomId,
    inviteToken,
    roomKey,
    invite,
    // Creator hosts locally immediately — invite origins are for friends, not our bootstrap.
    bootstrapOrigins: [],
  };
  saveRoomMeta(meta);
  saveSnapshot({ state, outbox: [] });
  try {
    window.sessionStorage.removeItem("p2pchat-join-only");
  } catch {
    /* ignore */
  }
  upsertSavedServer({
    roomId,
    name: input.name,
    invite,
    inviteToken,
    roomKey,
    role: "Владелец",
    hostName: identity.displayName,
  });
  debugLog("room", "created", {
    roomId,
    endpoints,
    inviteOrigins: origins.slice(0, 5),
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

  const identity = loadOrCreateIdentity(input.displayName.trim() || readProfileDisplayName() || "Участник", identityStorage);
  writeProfileDisplayName(identity.displayName);
  const localNode = await ensureLocalNode();
  // Do NOT apply joiner's own tunnel as the room public URL — that would rewrite invites to the wrong peer.
  void warmIceServers();
  const bootstrap = normalizeOrigin(input.bootstrapOrigin ?? "");
  if (bootstrap) setBootstrapOrigin(bootstrap);
  const origins = orderBootstrapOrigins([
    ...parsed.origins,
    ...(bootstrap ? [bootstrap] : []),
    ...(!isDesktopShell() && getBootstrapOrigin() ? [getBootstrapOrigin()] : []),
  ]);

  if (origins.length === 0 && !localNode) {
    throw new Error("В ссылке нет адреса узла — укажите bootstrap вручную");
  }

  // Invite join must find the live host. A leftover snapshot made us self-host
  // our own hub instead of connecting to the friend (see debug logs).
  clearSnapshot();

  const meta: RoomMeta = {
    roomId: parsed.roomId,
    inviteToken: parsed.inviteToken,
    roomKey: parsed.roomKey,
    invite: input.invite.trim(),
    bootstrapOrigins: origins.filter((origin) => {
      try {
        const host = new URL(origin).hostname;
        return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
      } catch {
        return false;
      }
    }),
  };
  saveRoomMeta(meta);
  // Mark next openRoomSession as join-only until a live host answers.
  window.sessionStorage.setItem("p2pchat-join-only", meta.roomId);
  upsertSavedServer({
    roomId: meta.roomId,
    name: "Комната",
    invite: meta.invite,
    inviteToken: meta.inviteToken,
    roomKey: meta.roomKey,
    role: "Участник",
  });
  debugLog("room", "prepareJoin", {
    roomId: meta.roomId,
    origins: meta.bootstrapOrigins.slice(0, 8),
    hasLocalNode: Boolean(localNode),
    publicOrigin: localNode?.publicOrigin,
    tunnelError: localNode?.tunnelError,
    joinOnly: true,
  });
  return { identity, meta, localNode };
}

export function rebuildInviteOrigins(meta: RoomMeta, extraOrigins: string[] = []): RoomMeta {
  const publicUrl = getPublicUrl();
  // Live endpoints first; drop any historical trycloudflare hostnames not in the current set.
  const fresh = [publicUrl, ...extraOrigins].map(normalizeOrigin).filter(Boolean);
  // Public tunnel → invite is public-only (no VPN/LAN leak). LAN-only party keeps private origins.
  const usable = filterShareableInviteOrigins(fresh);
  if (usable.length === 0) return meta;
  const invite = buildInvite({
    roomId: meta.roomId,
    inviteToken: meta.inviteToken,
    roomKey: meta.roomKey,
    origins: usable,
  });
  const next = { ...meta, invite, bootstrapOrigins: usable };
  saveRoomMeta(next);
  const saved = loadSavedServers().find((item) => item.roomId === meta.roomId);
  upsertSavedServer({
    roomId: meta.roomId,
    name: saved?.name ?? "Комната",
    invite,
    inviteToken: meta.inviteToken,
    roomKey: meta.roomKey,
    role: saved?.role ?? "Владелец",
    hostName: saved?.hostName,
  });
  return next;
}

/** Refresh invite with current public/LAN endpoints (coordinator after tunnel change). */
export async function refreshCoordinatorInvite(meta?: RoomMeta | null): Promise<RoomMeta | null> {
  const current = meta ?? loadRoomMeta();
  if (!current) return null;
  const localNode = await ensureLocalNode();
  if (localNode?.publicOrigin) applyAutoPublicUrl(localNode.publicOrigin);
  const endpoints = collectNodeEndpoints(
    localNode
      ? {
          origin: localNode.origin,
          lanOrigins: localNode.lanOrigins,
          publicOrigin: localNode.publicOrigin,
        }
      : null,
  );
  return rebuildInviteOrigins(current, endpoints);
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
  onInvite?: (meta: RoomMeta) => void;
}): Promise<OpenSessionHandles | null> {
  const meta = loadRoomMeta();
  if (!meta) return null;
  const identity = loadOrCreateIdentity(readProfileDisplayName() || "", identityStorage);
  if (identity.displayName) writeProfileDisplayName(identity.displayName);
  const localNode = await ensureLocalNode();
  if (localNode?.publicOrigin) applyAutoPublicUrl(localNode.publicOrigin);
  void warmIceServers();

  const snap = loadSnapshot();
  if (snap?.state && snap.state.id !== meta.roomId) clearSnapshot();

  const endpoints = collectNodeEndpoints(
    localNode
      ? {
          origin: localNode.origin,
          lanOrigins: localNode.lanOrigins,
          publicOrigin: localNode.publicOrigin,
        }
      : null,
  );

  const joinOnlyFlag = window.sessionStorage.getItem("p2pchat-join-only");
  const joinOnly = joinOnlyFlag === meta.roomId;
  if (joinOnly) window.sessionStorage.removeItem("p2pchat-join-only");
  // Drift principle: equal rights — любой desktop с local hub может стать координатором,
  // как только в сессии есть реплика комнаты (canHost в migration требует state).
  // Fresh invite чистит snapshot в prepareJoin, поэтому первый connect идёт по invite
  // к живому хосту, а не в premature self-host. После обрыва хоста joiner уже с state
  // может подхватить роль.
  const allowSelfHost = Boolean(localNode);

  // Coordinator: refresh invite when Quick Tunnel URL rotated so friends get a live link.
  let activeMeta = meta;
  const ownerOrHost =
    snap?.state?.ownerId === identity.peerId || snap?.state?.hostId === identity.peerId;
  if (ownerOrHost && allowSelfHost) {
    const publicUrl = getPublicUrl() || localNode?.publicOrigin || "";
    const inviteOrigins = parseInvite(meta.invite)?.origins ?? meta.bootstrapOrigins;
    // With a public URL we intentionally omit LAN/VPN from the invite — don't refresh just for that.
    const needsRefresh =
      (publicUrl && !inviteOrigins.includes(normalizeOrigin(publicUrl))) ||
      (!publicUrl &&
        Boolean(localNode?.lanOrigins?.some((origin) => !inviteOrigins.includes(normalizeOrigin(origin)))));
    if (needsRefresh) {
      activeMeta = rebuildInviteOrigins(meta, endpoints);
      input.onInvite?.(activeMeta);
      debugLog("room", "invite refreshed", { publicUrl, origins: activeMeta.bootstrapOrigins.slice(0, 5) });
    }
  }

  // Bootstrap for connect = invite origins, minus our own addresses (never join ourselves).
  const selfSet = new Set(endpoints.map(normalizeOrigin).concat(localNode ? [normalizeOrigin(localNode.origin)] : []));
  const bootstrap = orderBootstrapOrigins(
    (activeMeta.bootstrapOrigins.length > 0
      ? activeMeta.bootstrapOrigins
      : parseInvite(activeMeta.invite)?.origins ?? []
    ).filter((origin) => !selfSet.has(normalizeOrigin(origin))),
  );

  let lastStatus: string | null = null;
  let sawCoordinator = false;
  debugLog("session", "open", {
    roomId: activeMeta.roomId,
    allowSelfHost,
    joinOnly,
    bootstrap,
    selfEndpoints: endpoints.slice(0, 6),
    hasSnapshot: Boolean(snap?.state && snap.state.id === activeMeta.roomId),
  });
  const session = new RoomSession({
    roomId: activeMeta.roomId,
    inviteToken: activeMeta.inviteToken,
    roomKey: activeMeta.roomKey,
    identity,
    bootstrapOrigins: bootstrap,
    allowSelfHost,
    localNode: localNode
      ? {
          origin: localNode.origin,
          endpoints: endpoints.length > 0 ? endpoints : [localNode.origin, ...localNode.lanOrigins],
        }
      : null,
    initial: !joinOnly && snap?.state?.id === activeMeta.roomId ? snap : null,
    onAttempt: (event) => {
      debugLog(
        "connect",
        `${event.outcome} ${event.host ? "host" : "join"} ${event.origin}`,
        {
          ms: event.ms,
          healthz: event.healthz,
          code: event.code,
          message: event.message,
        },
        event.outcome === "connected" ? "info" : event.outcome === "rejected" ? "warn" : "warn",
      );
    },
    onView: (view) => {
      const key = `${view.status}:${view.isCoordinator}:${view.state?.hostId}:${view.state?.epoch}`;
      if (key !== lastStatus) {
        lastStatus = key;
        debugLog("session", `status=${view.status}`, {
          coordinator: view.isCoordinator,
          hostId: view.state?.hostId,
          online: view.state?.members.filter((m) => m.online).length,
          epoch: view.state?.epoch,
          origin: view.origin,
          lastError: view.lastError,
        });
      }
      if (view.isCoordinator && view.status === "connected" && !sawCoordinator) {
        sawCoordinator = true;
        void refreshCoordinatorInvite(activeMeta).then((next) => {
          if (!next) return;
          const changed = next.invite !== activeMeta.invite;
          activeMeta = next;
          if (changed) input.onInvite?.(next);
          debugLog("room", "coordinator invite synced", { origins: next.bootstrapOrigins.slice(0, 5), changed });
        });
      }
      if (view.state) {
        upsertSavedServer({
          roomId: view.state.id,
          name: view.state.name,
          invite: activeMeta.invite,
          inviteToken: activeMeta.inviteToken,
          roomKey: activeMeta.roomKey,
          role: view.state.ownerId === identity.peerId ? "Владелец" : "Участник",
          hostName: view.state.hostName,
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
          ? String((event.data as { kind?: unknown }).kind)
          : "unknown";
      debugLog("signal", `from ${event.fromPeerId}`, { kind }, "debug");
      input.onSignal?.(event);
    },
  });
  debugLog("session", "start", { roomId: activeMeta.roomId });
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
