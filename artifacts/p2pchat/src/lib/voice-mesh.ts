import { buildIceServers, isTurnConfigured, loadIceSettings, warmIceServers } from "@/lib/network-settings";
import { debugLog } from "@/lib/debug-log";

type VoiceSignal =
  | { kind: "offer"; description: RTCSessionDescriptionInit }
  | { kind: "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export type VoicePeerStatus = "connecting" | "connected" | "failed" | "closed";

export type VoiceMeshOptions = {
  onPeerStatus?: (peerId: string, status: VoicePeerStatus, detail?: string) => void;
};

type PeerRuntime = {
  connection: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  remoteReady: boolean;
  failTimer?: number;
};

export class VoiceMesh {
  private readonly selfId: string;
  private readonly sendSignal: (toPeerId: string, data: VoiceSignal) => void;
  private readonly options: VoiceMeshOptions;
  private stream: MediaStream | null = null;
  private peers = new Map<string, PeerRuntime>();
  private audioElements = new Map<string, HTMLAudioElement>();

  constructor(
    selfId: string,
    sendSignal: (toPeerId: string, data: VoiceSignal) => void,
    options: VoiceMeshOptions = {},
  ) {
    this.selfId = selfId;
    this.sendSignal = sendSignal;
    this.options = options;
  }

  hasTurn(): boolean {
    return isTurnConfigured(loadIceSettings());
  }

  async start(): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Браузер не поддерживает доступ к микрофону");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    debugLog("voice", "microphone acquired");
  }

  async addPeer(peerId: string, initiator: boolean): Promise<void> {
    if (peerId === this.selfId || this.peers.has(peerId)) return;
    if (!this.stream) await this.start();
    await warmIceServers();
    debugLog("voice", "addPeer", { peerId, initiator, turn: this.hasTurn() });

    const connection = new RTCPeerConnection({ iceServers: buildIceServers() });
    const runtime: PeerRuntime = { connection, pendingIce: [], remoteReady: false };
    this.peers.set(peerId, runtime);
    this.options.onPeerStatus?.(peerId, "connecting");

    for (const track of this.stream?.getTracks() ?? []) connection.addTrack(track, this.stream!);

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, { kind: "ice", candidate: event.candidate.toJSON() });
      }
    };

    connection.oniceconnectionstatechange = () => {
      debugLog("voice", "iceConnectionState", {
        peerId,
        state: connection.iceConnectionState,
      });
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      debugLog("voice", "ontrack", { peerId, tracks: stream.getTracks().length });
      let audio = this.audioElements.get(peerId);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.setAttribute("playsinline", "true");
        audio.setAttribute("aria-hidden", "true");
        audio.style.display = "none";
        document.body.appendChild(audio);
        this.audioElements.set(peerId, audio);
      }
      audio.srcObject = stream;
      void audio.play().catch((error) => {
        debugLog("voice", "audio.play blocked", error, "warn");
        this.options.onPeerStatus?.(peerId, "connecting", "Разрешите воспроизведение звука в системе");
      });
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      debugLog("voice", "connectionState", { peerId, state });
      if (state === "connected") {
        if (runtime.failTimer) window.clearTimeout(runtime.failTimer);
        runtime.failTimer = undefined;
        this.options.onPeerStatus?.(peerId, "connected");
        return;
      }
      if (state === "failed") {
        this.options.onPeerStatus?.(
          peerId,
          "failed",
          this.hasTurn()
            ? "Не удалось установить голосовой канал"
            : "Прямой путь недоступен — добавьте TURN в настройках",
        );
        this.removePeer(peerId);
        return;
      }
      if (state === "closed") {
        this.options.onPeerStatus?.(peerId, "closed");
        this.removePeer(peerId);
        return;
      }
      if (state === "disconnected") {
        this.options.onPeerStatus?.(peerId, "connecting", "Краткий обрыв, ждём восстановления…");
        if (runtime.failTimer) window.clearTimeout(runtime.failTimer);
        runtime.failTimer = window.setTimeout(() => {
          if (connection.connectionState === "disconnected" || connection.connectionState === "failed") {
            this.options.onPeerStatus?.(
              peerId,
              "failed",
              this.hasTurn()
                ? "Голосовое соединение потеряно"
                : "Нет прямого пути — нужен TURN для интернета",
            );
            this.removePeer(peerId);
          }
        }, 8000);
      }
    };

    if (initiator) {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      this.sendSignal(peerId, { kind: "offer", description: offer });
    }
  }

  async handleSignal(fromPeerId: string, data: unknown): Promise<void> {
    const signal = data as Partial<VoiceSignal>;
    if (!signal.kind) return;
    if (!this.peers.has(fromPeerId)) await this.addPeer(fromPeerId, false);
    const runtime = this.peers.get(fromPeerId);
    if (!runtime) return;
    const { connection } = runtime;

    if (signal.kind === "offer" && signal.description) {
      await connection.setRemoteDescription(signal.description);
      runtime.remoteReady = true;
      await this.flushIce(fromPeerId);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      this.sendSignal(fromPeerId, { kind: "answer", description: answer });
    } else if (signal.kind === "answer" && signal.description) {
      await connection.setRemoteDescription(signal.description);
      runtime.remoteReady = true;
      await this.flushIce(fromPeerId);
    } else if (signal.kind === "ice" && signal.candidate) {
      if (!runtime.remoteReady) {
        runtime.pendingIce.push(signal.candidate);
        return;
      }
      try {
        await connection.addIceCandidate(signal.candidate);
      } catch {
        // Stale candidates after renegotiation are ignored.
      }
    }
  }

  private async flushIce(peerId: string): Promise<void> {
    const runtime = this.peers.get(peerId);
    if (!runtime) return;
    const pending = runtime.pendingIce.splice(0, runtime.pendingIce.length);
    for (const candidate of pending) {
      try {
        await runtime.connection.addIceCandidate(candidate);
      } catch {
        // Ignore.
      }
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  setDeafened(deafened: boolean): void {
    for (const audio of this.audioElements.values()) audio.muted = deafened;
  }

  removePeer(peerId: string): void {
    const runtime = this.peers.get(peerId);
    if (runtime?.failTimer) window.clearTimeout(runtime.failTimer);
    runtime?.connection.close();
    this.peers.delete(peerId);
    const audio = this.audioElements.get(peerId);
    audio?.remove();
    this.audioElements.delete(peerId);
  }

  stop(): void {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}
