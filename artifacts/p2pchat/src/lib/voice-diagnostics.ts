/**
 * Structured voice/NAT diagnostics for friend beta reports.
 * No TURN credentials or full chat content — only transport facts.
 */

import { debugLog } from "@/lib/debug-log";
import {
  getLastIceSource,
  isCustomTurnConfigured,
  loadIceSettings,
} from "@/lib/network-settings";

export type IceCandidateSummary = {
  type: string;
  protocol?: string;
  /** v4 | v6 | unknown */
  family: string;
  /** private | public | unknown — never logs the raw IP */
  scope: string;
  tcpType?: string;
};

export type PeerNatSnapshot = {
  peerId: string;
  connectionState: string;
  iceConnectionState: string;
  iceGatheringState: string;
  localTypes: string[];
  remoteTypes: string[];
  sawLocalRelay: boolean;
  sawRemoteRelay: boolean;
  selected?: {
    localType?: string;
    remoteType?: string;
    protocol?: string;
    currentRoundTripTime?: number;
    bytesSent?: number;
    bytesReceived?: number;
    packetsLost?: number;
    availableOutgoingBitrate?: number;
  };
  audio?: {
    inboundBytes?: number;
    outboundBytes?: number;
    inboundPacketsLost?: number;
    hasRemoteAudioTrack: boolean;
  };
  diagnosis: string;
  hint: string;
};

export type VoiceNatReport = {
  at: string;
  iceSource: string;
  meteredConfigured: boolean;
  customTurn: boolean;
  iceServerSummary: { stun: number; turn: number; turns: number; urls?: string[] };
  peers: PeerNatSnapshot[];
  summary: string;
};

let lastReport: VoiceNatReport | null = null;
let lastIceServerSummary: VoiceNatReport["iceServerSummary"] | null = null;

export function getLastVoiceNatReport(): VoiceNatReport | null {
  return lastReport;
}

export function setLastVoiceNatReport(report: VoiceNatReport): void {
  lastReport = report;
}

export function rememberIceServerSummary(summary: VoiceNatReport["iceServerSummary"]): void {
  lastIceServerSummary = summary;
}

export function getLastIceServerSummary(): VoiceNatReport["iceServerSummary"] {
  return lastIceServerSummary ?? { stun: 0, turn: 0, turns: 0 };
}

export function resolveMeteredConfigured(
  settings: ReturnType<typeof loadIceSettings> = loadIceSettings(),
): boolean {
  if (settings.meteredApiKey?.trim()) return true;
  try {
    return Boolean((import.meta.env.VITE_METERED_API_KEY as string | undefined)?.trim());
  } catch {
    return false;
  }
}

/** Summarize RTCIceServer list without leaking credentials. */
export function summarizeIceServers(servers: RTCIceServer[]): {
  stun: number;
  turn: number;
  turns: number;
  urls: string[];
} {
  let stun = 0;
  let turn = 0;
  let turns = 0;
  const urls: string[] = [];
  for (const server of servers) {
    const list = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const raw of list) {
      if (!raw) continue;
      const u = String(raw);
      const bare = u.split("?")[0] ?? u;
      urls.push(bare);
      if (u.startsWith("turns:")) turns += 1;
      else if (u.startsWith("turn:")) turn += 1;
      else if (u.startsWith("stun:")) stun += 1;
    }
  }
  return { stun, turn, turns, urls: urls.slice(0, 12) };
}

export function classifyAddress(address?: string | null): { family: string; scope: string } {
  if (!address) return { family: "unknown", scope: "unknown" };
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    const scope =
      lower.startsWith("fc") || lower.startsWith("fd") || lower === "::1" ? "private" : "public";
    return { family: "v6", scope };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const privateIp =
      address.startsWith("10.") ||
      address.startsWith("192.168.") ||
      address.startsWith("127.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
    return { family: "v4", scope: privateIp ? "private" : "public" };
  }
  return { family: "unknown", scope: "unknown" };
}

export function summarizeCandidate(
  candidate: RTCIceCandidate | RTCIceCandidateInit | null | undefined,
): IceCandidateSummary | null {
  if (!candidate) return null;
  const type =
    ("type" in candidate && candidate.type) ||
    (typeof candidate.candidate === "string"
      ? candidate.candidate.match(/ typ (\w+)/)?.[1]
      : undefined) ||
    "unknown";
  const address =
    ("address" in candidate && (candidate as RTCIceCandidate).address) ||
    (typeof candidate.candidate === "string"
      ? candidate.candidate.split(" ")[4]
      : undefined);
  const { family, scope } = classifyAddress(address ?? undefined);
  const protocol =
    ("protocol" in candidate && (candidate as RTCIceCandidate).protocol) ||
    (typeof candidate.candidate === "string"
      ? candidate.candidate.match(/ (udp|tcp) /i)?.[1]?.toLowerCase()
      : undefined);
  const tcpType =
    ("tcpType" in candidate && (candidate as RTCIceCandidate).tcpType) || undefined;
  return {
    type: String(type),
    protocol: protocol || undefined,
    family,
    scope,
    tcpType: tcpType || undefined,
  };
}

function diagnosePeer(input: {
  connectionState: string;
  sawLocalRelay: boolean;
  sawRemoteRelay: boolean;
  selectedLocal?: string;
  selectedRemote?: string;
  hasRemoteAudio: boolean;
  inboundBytes?: number;
}): { diagnosis: string; hint: string } {
  const iceSource = getLastIceSource();
  const metered = resolveMeteredConfigured();

  if (input.connectionState === "connected") {
    const path = `${input.selectedLocal || "?"}→${input.selectedRemote || "?"}`;
    if ((input.inboundBytes ?? 0) === 0 && input.hasRemoteAudio) {
      return {
        diagnosis: "CONNECTED_NO_AUDIO_BYTES",
        hint: `WebRTC connected (${path}), but no inbound audio bytes yet — mute/deaf/device/autoplay?`,
      };
    }
    if (!input.hasRemoteAudio) {
      return {
        diagnosis: "CONNECTED_NO_REMOTE_AUDIO_TRACK",
        hint: `Connected (${path}) but no remote audio track — peer mic / renegotiation issue`,
      };
    }
    if (input.selectedLocal === "relay" || input.selectedRemote === "relay") {
      return {
        diagnosis: "CONNECTED_VIA_RELAY",
        hint: `OK via TURN relay (${path})`,
      };
    }
    if (input.selectedLocal === "srflx" || input.selectedRemote === "srflx") {
      return {
        diagnosis: "CONNECTED_VIA_SRFLX",
        hint: `OK via server-reflexive NAT mapping (${path})`,
      };
    }
    return {
      diagnosis: "CONNECTED_VIA_HOST",
      hint: `OK likely same LAN / VPN (${path})`,
    };
  }

  if (!input.sawLocalRelay && !metered && (iceSource === "static-openrelay" || iceSource === "cache")) {
    return {
      diagnosis: "NO_RELAY_NO_METERED",
      hint: "No local relay candidate + no Metered key — classic symmetric NAT failure. Set Metered API key.",
    };
  }
  if (!input.sawLocalRelay) {
    return {
      diagnosis: "NO_LOCAL_RELAY",
      hint: "TURN did not allocate a local relay candidate — check Metered app name/key or custom TURN.",
    };
  }
  if (!input.sawRemoteRelay) {
    return {
      diagnosis: "NO_REMOTE_RELAY",
      hint: "Peer sent no relay candidates — their TURN/Metered likely missing or broken.",
    };
  }
  if (input.sawLocalRelay) {
    return {
      diagnosis: "FAILED_DESPITE_RELAY",
      hint: "Had relay candidates but PC still failed — firewall/UDP block, expired TURN creds, or peer offline.",
    };
  }
  return {
    diagnosis: "FAILED_UNKNOWN",
    hint: "Voice PC failed without a clear relay picture — send full debug report.",
  };
}

export async function snapshotPeerConnection(
  peerId: string,
  connection: RTCPeerConnection,
  meta: {
    localTypes: Iterable<string>;
    remoteTypes: Iterable<string>;
    sawLocalRelay: boolean;
    sawRemoteRelay: boolean;
    hasRemoteAudioTrack: boolean;
  },
): Promise<PeerNatSnapshot> {
  const localTypes = [...meta.localTypes];
  const remoteTypes = [...meta.remoteTypes];
  let selected: PeerNatSnapshot["selected"];
  let inboundBytes: number | undefined;
  let outboundBytes: number | undefined;
  let inboundPacketsLost: number | undefined;

  try {
    type IceCand = {
      id: string;
      candidateType?: string;
      protocol?: string;
    };
    type IcePair = {
      id: string;
      state?: string;
      nominated?: boolean;
      selected?: boolean;
      localCandidateId?: string;
      remoteCandidateId?: string;
      currentRoundTripTime?: number;
      bytesSent?: number;
      bytesReceived?: number;
      availableOutgoingBitrate?: number;
    };

    const stats = await connection.getStats();
    let selectedPairId: string | undefined;
    const locals = new Map<string, IceCand>();
    const remotes = new Map<string, IceCand>();
    const pairs = new Map<string, IcePair>();

    stats.forEach((report) => {
      if (report.type === "local-candidate") {
        locals.set(report.id, report as unknown as IceCand);
      } else if (report.type === "remote-candidate") {
        remotes.set(report.id, report as unknown as IceCand);
      } else if (report.type === "candidate-pair") {
        const pair = report as unknown as IcePair;
        pairs.set(report.id, pair);
        if (pair.selected || pair.nominated) selectedPairId = report.id;
      } else if (report.type === "transport") {
        const t = report as { selectedCandidatePairId?: string };
        if (t.selectedCandidatePairId) selectedPairId = t.selectedCandidatePairId;
      } else if (report.type === "inbound-rtp" && (report as { kind?: string }).kind === "audio") {
        inboundBytes = (report as { bytesReceived?: number }).bytesReceived;
        inboundPacketsLost = (report as { packetsLost?: number }).packetsLost;
      } else if (report.type === "outbound-rtp" && (report as { kind?: string }).kind === "audio") {
        outboundBytes = (report as { bytesSent?: number }).bytesSent;
      }
    });

    const pair = selectedPairId
      ? pairs.get(selectedPairId)
      : [...pairs.values()].find((p) => p.state === "succeeded");
    if (pair) {
      const local = pair.localCandidateId ? locals.get(pair.localCandidateId) : undefined;
      const remote = pair.remoteCandidateId ? remotes.get(pair.remoteCandidateId) : undefined;
      selected = {
        localType: local?.candidateType,
        remoteType: remote?.candidateType,
        protocol: local?.protocol || remote?.protocol,
        currentRoundTripTime: pair.currentRoundTripTime,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
        packetsLost: inboundPacketsLost,
        availableOutgoingBitrate: pair.availableOutgoingBitrate,
      };
    }
  } catch (error) {
    debugLog("voice-nat", "getStats failed", { peerId, error }, "warn");
  }

  const { diagnosis, hint } = diagnosePeer({
    connectionState: connection.connectionState,
    sawLocalRelay: meta.sawLocalRelay,
    sawRemoteRelay: meta.sawRemoteRelay,
    selectedLocal: selected?.localType,
    selectedRemote: selected?.remoteType,
    hasRemoteAudio: meta.hasRemoteAudioTrack,
    inboundBytes,
  });

  return {
    peerId,
    connectionState: connection.connectionState,
    iceConnectionState: connection.iceConnectionState,
    iceGatheringState: connection.iceGatheringState,
    localTypes,
    remoteTypes,
    sawLocalRelay: meta.sawLocalRelay,
    sawRemoteRelay: meta.sawRemoteRelay,
    selected,
    audio: {
      inboundBytes,
      outboundBytes,
      inboundPacketsLost,
      hasRemoteAudioTrack: meta.hasRemoteAudioTrack,
    },
    diagnosis,
    hint,
  };
}

export function buildVoiceNatReport(
  peers: PeerNatSnapshot[],
  iceServerSummary?: VoiceNatReport["iceServerSummary"],
): VoiceNatReport {
  const settings = loadIceSettings();
  const summary = iceServerSummary ?? getLastIceServerSummary();
  if (iceServerSummary) rememberIceServerSummary(iceServerSummary);
  const report: VoiceNatReport = {
    at: new Date().toISOString(),
    iceSource: getLastIceSource(),
    meteredConfigured: resolveMeteredConfigured(settings),
    customTurn: isCustomTurnConfigured(settings),
    iceServerSummary: summary,
    peers,
    summary:
      peers.length === 0
        ? "No active voice peer connections in this snapshot"
        : peers.map((p) => `${p.peerId.slice(0, 8)}:${p.diagnosis}`).join("; "),
  };
  setLastVoiceNatReport(report);
  return report;
}

export function iceConfigFlags() {
  const settings = loadIceSettings();
  return {
    iceSource: getLastIceSource(),
    meteredConfigured: resolveMeteredConfigured(settings),
    customTurn: isCustomTurnConfigured(settings),
    meteredAppName: settings.meteredAppName || null,
    hasMeteredKey: Boolean(settings.meteredApiKey?.trim()),
  };
}
