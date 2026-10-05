import { CONNECTION_KEY, readStore } from "@/lib/app-shared";
import { ensureLocalNode } from "@/lib/desktop-bridge";
import {
  getBootstrapOrigin,
  getLastIceSource,
  getPublicUrl,
  isCustomTurnConfigured,
  isDesktopShell,
  isTurnConfigured,
  loadRoomMeta,
  warmIceServers,
} from "@/lib/p2p-client";
import { getLastVoiceNatReport, resolveMeteredConfigured } from "@/lib/voice-diagnostics";

type ConnectionStatus = "connected" | "connecting" | "reconnecting" | "offline";

export type HealthLevel = "ok" | "warn" | "fail" | "idle" | "checking";

export type HealthRow = {
  id: string;
  label: string;
  level: HealthLevel;
  detail: string;
};

export type NetworkHealthReport = {
  at: string;
  control: HealthRow[];
  voice: HealthRow[];
};

async function probeUrl(url: string, ms = 3500): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

async function probeHealthz(origin: string): Promise<boolean> {
  const base = origin.replace(/\/$/, "");
  if (!base) return false;
  return probeUrl(`${base}/api/healthz`);
}

async function probeInternet(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  // Lightweight public endpoint; opaque CORS still resolves if the network works.
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3000);
    await fetch("https://cloudflare.com/cdn-cgi/trace", {
      method: "GET",
      cache: "no-store",
      mode: "cors",
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    return true;
  } catch {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2500);
      await fetch("https://1.1.1.1", { method: "HEAD", mode: "no-cors", signal: controller.signal });
      window.clearTimeout(timer);
      return true;
    } catch {
      return false;
    }
  }
}

function roomConnectionRow(): HealthRow {
  const status = readStore<ConnectionStatus>(CONNECTION_KEY, "offline");
  if (status === "connected") {
    return { id: "room", label: "Room connection", level: "ok", detail: "Комната синхронизирована" };
  }
  if (status === "connecting" || status === "reconnecting") {
    return { id: "room", label: "Room connection", level: "warn", detail: "Подключаемся…" };
  }
  return { id: "room", label: "Room connection", level: "fail", detail: "Нет соединения с комнатой" };
}

function voiceRowsFromConfigAndLastCall(iceHasStun: boolean, iceHasTurn: boolean): HealthRow[] {
  const source = getLastIceSource();
  const metered = resolveMeteredConfigured();
  const custom = isCustomTurnConfigured();
  const last = getLastVoiceNatReport();
  const peer = last?.peers[0];

  let stun: HealthRow;
  if (iceHasStun) {
    stun = { id: "stun", label: "STUN", level: "ok", detail: "Серверы STUN в ICE-конфиге" };
  } else {
    stun = { id: "stun", label: "STUN", level: "fail", detail: "STUN не найден в ICE" };
  }

  let turn: HealthRow;
  if (custom) {
    turn = { id: "turn", label: "TURN", level: "ok", detail: "Свой TURN (coturn)" };
  } else if (metered || source === "metered-api") {
    turn = { id: "turn", label: "TURN", level: "ok", detail: "Metered API" };
  } else if (iceHasTurn && source === "static-openrelay") {
    turn = {
      id: "turn",
      label: "TURN",
      level: "warn",
      detail: "Open Relay — часто мёртв. Лучше Metered / свой VPS",
    };
  } else if (isTurnConfigured() || iceHasTurn) {
    turn = { id: "turn", label: "TURN", level: "ok", detail: `Источник: ${source}` };
  } else {
    turn = { id: "turn", label: "TURN", level: "fail", detail: "TURN не настроен" };
  }

  let direct: HealthRow;
  let audio: HealthRow;
  if (!peer) {
    direct = { id: "direct", label: "Direct P2P", level: "idle", detail: "Зайдите в голосовой канал" };
    audio = { id: "audio", label: "Audio", level: "idle", detail: "Нет активного голоса" };
  } else {
    const selected = peer.selected?.localType;
    const connected = peer.connectionState === "connected";
    const viaRelay = selected === "relay" || peer.sawLocalRelay;
    if (connected && !viaRelay && (selected === "host" || selected === "srflx")) {
      direct = { id: "direct", label: "Direct P2P", level: "ok", detail: `Путь: ${selected}` };
    } else if (connected && viaRelay) {
      direct = { id: "direct", label: "Direct P2P", level: "warn", detail: "Идёт через TURN relay" };
    } else if (peer.connectionState === "failed") {
      direct = { id: "direct", label: "Direct P2P", level: "fail", detail: "Соединение не установилось" };
    } else {
      direct = {
        id: "direct",
        label: "Direct P2P",
        level: "warn",
        detail: `Состояние: ${peer.connectionState}`,
      };
    }

    const inBytes = peer.audio?.inboundBytes ?? 0;
    const outBytes = peer.audio?.outboundBytes ?? 0;
    const hasTrack = peer.audio?.hasRemoteAudioTrack;
    if (connected && (inBytes > 0 || outBytes > 0 || hasTrack)) {
      audio = { id: "audio", label: "Audio", level: "ok", detail: "Медиа-поток есть" };
    } else if (connected) {
      audio = { id: "audio", label: "Audio", level: "warn", detail: "Connected, но байтов мало" };
    } else {
      audio = { id: "audio", label: "Audio", level: "fail", detail: peer.diagnosis || "Нет аудио" };
    }
  }

  return [stun, turn, direct, audio];
}

export async function probeNetworkHealth(): Promise<NetworkHealthReport> {
  const internetOk = await probeInternet();

  let localNode: HealthRow;
  if (!isDesktopShell()) {
    localNode = { id: "local", label: "Local node", level: "idle", detail: "Только desktop" };
  } else {
    const node = await ensureLocalNode();
    if (node?.origin && (await probeHealthz(node.origin))) {
      localNode = { id: "local", label: "Local node", level: "ok", detail: node.origin };
    } else if (node?.origin) {
      localNode = { id: "local", label: "Local node", level: "warn", detail: "Узел есть, healthz не ответил" };
    } else {
      localNode = { id: "local", label: "Local node", level: "fail", detail: "Локальный узел не поднят" };
    }
  }

  const bootstrap = getBootstrapOrigin();
  let bootstrapRow: HealthRow;
  if (!bootstrap) {
    bootstrapRow = { id: "bootstrap", label: "Bootstrap", level: "idle", detail: "Не задан (не обязателен)" };
  } else if (await probeHealthz(bootstrap)) {
    bootstrapRow = { id: "bootstrap", label: "Bootstrap", level: "ok", detail: bootstrap };
  } else {
    bootstrapRow = { id: "bootstrap", label: "Bootstrap", level: "fail", detail: "Не отвечает" };
  }

  const publicUrl = getPublicUrl();
  const meta = loadRoomMeta();
  let tunnel: HealthRow;
  if (publicUrl) {
    const ok = await probeHealthz(publicUrl);
    tunnel = ok
      ? { id: "tunnel", label: "Tunnel", level: "ok", detail: publicUrl }
      : { id: "tunnel", label: "Tunnel", level: "warn", detail: "URL есть, healthz не подтвердил" };
  } else if (meta?.roomId) {
    tunnel = {
      id: "tunnel",
      label: "Tunnel",
      level: "fail",
      detail: "Нет публичного URL — друзьям из интернета не зайти",
    };
  } else {
    tunnel = { id: "tunnel", label: "Tunnel", level: "idle", detail: "Создайте комнату" };
  }

  const iceServers = await warmIceServers();
  let stun = 0;
  let turn = 0;
  for (const server of iceServers) {
    const list = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const raw of list) {
      const u = String(raw);
      if (u.startsWith("stun:")) stun += 1;
      else if (u.startsWith("turn:") || u.startsWith("turns:")) turn += 1;
    }
  }

  return {
    at: new Date().toISOString(),
    control: [
      {
        id: "internet",
        label: "Internet",
        level: internetOk ? "ok" : "fail",
        detail: internetOk ? "Сеть доступна" : "Нет доступа в интернет",
      },
      localNode,
      bootstrapRow,
      tunnel,
      roomConnectionRow(),
    ],
    voice: voiceRowsFromConfigAndLastCall(stun > 0, turn > 0),
  };
}
