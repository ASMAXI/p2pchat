import {
  buildIceServers,
  getLastIceSource,
  isCustomTurnConfigured,
  isTurnConfigured,
  loadIceSettings,
  warmIceServers,
} from "@/lib/network-settings";
import { debugLog } from "@/lib/debug-log";

type VoiceSignal =
  | { kind: "offer"; description: RTCSessionDescriptionInit }
  | { kind: "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "voice-state"; muted: boolean; deafened: boolean };

export type VoicePeerStatus = "connecting" | "connected" | "failed" | "closed";

export type MicProcessing = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export type VoiceMeshOptions = {
  onPeerStatus?: (peerId: string, status: VoicePeerStatus, detail?: string) => void;
  onSpeaking?: (peerId: string, speaking: boolean) => void;
  onPeerVoiceState?: (peerId: string, state: { muted: boolean; deafened: boolean }) => void;
};

type PeerRuntime = {
  connection: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  remoteReady: boolean;
  failTimer?: number;
  restartAttempted: boolean;
  sawRelay: boolean;
  candidateTypes: Set<string>;
  gain?: GainNode;
  analyser?: AnalyserNode;
  source?: MediaStreamAudioSourceNode;
  speakTimer?: number;
  speaking: boolean;
};

const DEFAULT_MIC: MicProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Discord-like user-volume boost: 0..2 (200%). */
const MAX_PEER_GAIN = 2;

function failHint(runtime: PeerRuntime): string {
  const source = getLastIceSource();
  if (!runtime.sawRelay && (source === "static-openrelay" || source === "cache")) {
    return "TURN не выдал relay — в разных сетях нужен Metered API key или свой TURN в настройках";
  }
  if (!runtime.sawRelay) {
    return "TURN не выдал relay-кандидат — проверьте TURN/Metered в настройках";
  }
  if (isCustomTurnConfigured() || source === "metered-api") {
    return "Не удалось установить голосовой канал (NAT/firewall). Попробуйте снова зайти в канал";
  }
  return "Не удалось установить голосовой канал";
}

export class VoiceMesh {
  private readonly selfId: string;
  private readonly sendSignal: (toPeerId: string, data: VoiceSignal) => void;
  private readonly options: VoiceMeshOptions;
  private rawStream: MediaStream | null = null;
  private outboundStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private micGain: GainNode | null = null;
  private peers = new Map<string, PeerRuntime>();
  private audioElements = new Map<string, HTMLAudioElement>();
  private peerVolumes = new Map<string, number>();
  private micVolume = 1;
  private micProcessing: MicProcessing = { ...DEFAULT_MIC };
  private muted = false;
  private deafened = false;

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

  getMicProcessing(): MicProcessing {
    return { ...this.micProcessing };
  }

  /** Restore slider values after leave/rejoin (bug: UI.min + audio.max). */
  hydratePeerVolumes(volumes: Record<string, number>): void {
    for (const [peerId, volume] of Object.entries(volumes)) {
      this.peerVolumes.set(peerId, Math.min(MAX_PEER_GAIN, Math.max(0, volume)));
    }
  }

  async start(): Promise<void> {
    if (this.outboundStream) return;
    await this.acquireMic();
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  private async acquireMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Браузер не поддерживает доступ к микрофону");
    }
    const nextRaw = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: this.micProcessing.echoCancellation,
        noiseSuppression: this.micProcessing.noiseSuppression,
        autoGainControl: this.micProcessing.autoGainControl,
      },
    });
    for (const track of this.rawStream?.getTracks() ?? []) track.stop();
    this.rawStream = nextRaw;

    const ctx = this.ensureAudioContext();
    if (ctx.state === "suspended") await ctx.resume();

    const source = ctx.createMediaStreamSource(nextRaw);
    if (!this.micGain) this.micGain = ctx.createGain();
    this.micGain.gain.value = this.muted ? 0 : this.micVolume;
    const dest = ctx.createMediaStreamDestination();
    source.connect(this.micGain);
    this.micGain.connect(dest);
    this.outboundStream = dest.stream;

    for (const track of this.outboundStream.getAudioTracks()) {
      track.enabled = !this.muted;
    }

    await this.replaceOutboundTracks();
    debugLog("voice", "microphone acquired", this.micProcessing);
  }

  private async replaceOutboundTracks(): Promise<void> {
    const track = this.outboundStream?.getAudioTracks()[0];
    if (!track) return;
    for (const runtime of this.peers.values()) {
      const sender = runtime.connection.getSenders().find((item) => item.track?.kind === "audio");
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch (error) {
          debugLog("voice", "replaceTrack failed", error, "warn");
        }
      }
    }
  }

  async setMicProcessing(partial: Partial<MicProcessing>): Promise<void> {
    this.micProcessing = { ...this.micProcessing, ...partial };
    if (!this.rawStream) return;
    await this.acquireMic();
  }

  setMicVolume(volume: number): void {
    this.micVolume = Math.min(1, Math.max(0, volume));
    if (this.micGain) this.micGain.gain.value = this.muted ? 0 : this.micVolume;
  }

  getMicVolume(): number {
    return this.micVolume;
  }

  setPeerVolume(peerId: string, volume: number): void {
    const next = Math.min(MAX_PEER_GAIN, Math.max(0, volume));
    this.peerVolumes.set(peerId, next);
    this.applyPeerGain(peerId);
  }

  getPeerVolume(peerId: string): number {
    return this.peerVolumes.get(peerId) ?? 1;
  }

  private applyPeerGain(peerId: string): void {
    const runtime = this.peers.get(peerId);
    const gain = this.deafened ? 0 : this.getPeerVolume(peerId);
    if (runtime?.gain) runtime.gain.gain.value = gain;
    const audio = this.audioElements.get(peerId);
    if (audio) {
      // Keep element unmuted; loudness comes from GainNode (supports >100%).
      audio.volume = 1;
      audio.muted = false;
    }
  }

  private attachRemoteAudio(peerId: string, stream: MediaStream): void {
    const ctx = this.ensureAudioContext();
    const runtime = this.peers.get(peerId);
    if (!runtime) return;

    runtime.source?.disconnect();
    runtime.analyser?.disconnect();
    runtime.gain?.disconnect();
    if (runtime.speakTimer) window.clearInterval(runtime.speakTimer);

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    const gain = ctx.createGain();
    gain.gain.value = this.deafened ? 0 : this.getPeerVolume(peerId);
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    runtime.source = source;
    runtime.analyser = analyser;
    runtime.gain = gain;
    runtime.speaking = false;

    // Keep a silent <audio> so autoplay policies stay happy on some platforms.
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
    audio.volume = 0; // playback via Web Audio graph
    void audio.play().catch((error) => {
      debugLog("voice", "audio.play blocked", error, "warn");
      this.options.onPeerStatus?.(peerId, "connecting", "Разрешите воспроизведение звука в системе");
    });
    void ctx.resume();

    const data = new Uint8Array(analyser.frequencyBinCount);
    runtime.speakTimer = window.setInterval(() => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i]!;
      const avg = sum / data.length;
      const speaking = avg > 18;
      if (speaking !== runtime.speaking) {
        runtime.speaking = speaking;
        this.options.onSpeaking?.(peerId, speaking);
      }
    }, 120);
  }

  async addPeer(peerId: string, initiator: boolean): Promise<void> {
    if (peerId === this.selfId || this.peers.has(peerId)) return;
    if (!this.outboundStream) await this.start();
    const iceServers = await warmIceServers();
    debugLog("voice", "addPeer", {
      peerId,
      initiator,
      turn: this.hasTurn(),
      iceSource: getLastIceSource(),
      iceServers: iceServers.length,
      volume: this.getPeerVolume(peerId),
    });

    const connection = new RTCPeerConnection({
      iceServers: iceServers.length > 0 ? iceServers : buildIceServers(),
      iceCandidatePoolSize: 4,
    });
    const runtime: PeerRuntime = {
      connection,
      pendingIce: [],
      remoteReady: false,
      restartAttempted: false,
      sawRelay: false,
      candidateTypes: new Set(),
      speaking: false,
    };
    this.peers.set(peerId, runtime);
    this.options.onPeerStatus?.(peerId, "connecting");

    for (const track of this.outboundStream?.getTracks() ?? []) {
      connection.addTrack(track, this.outboundStream!);
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      const type = event.candidate.type || "unknown";
      runtime.candidateTypes.add(type);
      if (type === "relay") runtime.sawRelay = true;
      debugLog("voice", "local ice", { peerId, type, protocol: event.candidate.protocol });
      this.sendSignal(peerId, { kind: "ice", candidate: event.candidate.toJSON() });
    };

    connection.onicegatheringstatechange = () => {
      if (connection.iceGatheringState !== "complete") return;
      debugLog("voice", "ice gathering complete", {
        peerId,
        types: [...runtime.candidateTypes],
        sawRelay: runtime.sawRelay,
        iceSource: getLastIceSource(),
      });
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
      debugLog("voice", "ontrack", { peerId, tracks: stream.getTracks().length, volume: this.getPeerVolume(peerId) });
      this.attachRemoteAudio(peerId, stream);
      // Share our mute/deaf so peer can show icons.
      this.sendSignal(peerId, { kind: "voice-state", muted: this.muted, deafened: this.deafened });
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      debugLog("voice", "connectionState", { peerId, state });
      if (state === "connected") {
        if (runtime.failTimer) window.clearTimeout(runtime.failTimer);
        runtime.failTimer = undefined;
        this.options.onPeerStatus?.(peerId, "connected");
        this.sendSignal(peerId, { kind: "voice-state", muted: this.muted, deafened: this.deafened });
        return;
      }
      if (state === "failed") {
        void this.handleFailed(peerId, runtime, initiator);
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
            void this.handleFailed(peerId, runtime, initiator);
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

  private async handleFailed(peerId: string, runtime: PeerRuntime, initiator: boolean): Promise<void> {
    if (!this.peers.has(peerId)) return;
    if (!runtime.restartAttempted && initiator) {
      runtime.restartAttempted = true;
      debugLog("voice", "iceRestart", { peerId, sawRelay: runtime.sawRelay }, "warn");
      this.options.onPeerStatus?.(peerId, "connecting", "Переподключаем голос…");
      try {
        const offer = await runtime.connection.createOffer({ iceRestart: true });
        await runtime.connection.setLocalDescription(offer);
        this.sendSignal(peerId, { kind: "offer", description: offer });
        return;
      } catch (error) {
        debugLog("voice", "iceRestart failed", error, "warn");
      }
    }

    const detail = failHint(runtime);
    this.options.onPeerStatus?.(peerId, "failed", detail);
    this.removePeer(peerId);
  }

  async handleSignal(fromPeerId: string, data: unknown): Promise<void> {
    const signal = data as Partial<VoiceSignal>;
    if (!signal.kind) return;
    if (signal.kind === "voice-state") {
      this.options.onPeerVoiceState?.(fromPeerId, {
        muted: Boolean(signal.muted),
        deafened: Boolean(signal.deafened),
      });
      return;
    }
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

  private broadcastVoiceState(): void {
    for (const peerId of this.peers.keys()) {
      this.sendSignal(peerId, { kind: "voice-state", muted: this.muted, deafened: this.deafened });
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.micGain) this.micGain.gain.value = muted ? 0 : this.micVolume;
    for (const track of this.outboundStream?.getAudioTracks() ?? []) track.enabled = !muted;
    for (const track of this.rawStream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.broadcastVoiceState();
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const peerId of this.peers.keys()) this.applyPeerGain(peerId);
    this.broadcastVoiceState();
  }

  removePeer(peerId: string): void {
    const runtime = this.peers.get(peerId);
    if (runtime?.failTimer) window.clearTimeout(runtime.failTimer);
    if (runtime?.speakTimer) window.clearInterval(runtime.speakTimer);
    runtime?.source?.disconnect();
    runtime?.analyser?.disconnect();
    runtime?.gain?.disconnect();
    runtime?.connection.close();
    this.peers.delete(peerId);
    const audio = this.audioElements.get(peerId);
    audio?.remove();
    this.audioElements.delete(peerId);
    this.options.onSpeaking?.(peerId, false);
  }

  stop(): void {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    for (const track of this.rawStream?.getTracks() ?? []) track.stop();
    this.rawStream = null;
    this.outboundStream = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.micGain = null;
  }
}
