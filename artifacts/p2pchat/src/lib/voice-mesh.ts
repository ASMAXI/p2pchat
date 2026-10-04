import { createNoiseGateNode, ensureNoiseWorklet } from "@/lib/noise-gate";
import { loadAudioInputId, loadAudioOutputId } from "@/lib/audio-settings";
import {
  buildIceServers,
  clearIceCache,
  getLastIceSource,
  isCustomTurnConfigured,
  isTurnConfigured,
  loadIceSettings,
  warmIceServers,
} from "@/lib/network-settings";
import { debugLog } from "@/lib/debug-log";
import {
  buildVoiceNatReport,
  rememberIceServerSummary,
  snapshotPeerConnection,
  summarizeCandidate,
  summarizeIceServers,
  type VoiceNatReport,
} from "@/lib/voice-diagnostics";

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type VoiceSignal =
  | { kind: "offer"; description: RTCSessionDescriptionInit }
  | { kind: "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "voice-state"; muted: boolean; deafened: boolean }
  | { kind: "screen-share"; active: boolean };

export type VoicePeerStatus = "connecting" | "connected" | "failed" | "closed";

export type MicProcessing = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Stronger DSP noise gate (AudioWorklet) on top of browser NS. */
  enhancedNoise: boolean;
};

export type VoiceMeshOptions = {
  onPeerStatus?: (peerId: string, status: VoicePeerStatus, detail?: string) => void;
  onSpeaking?: (peerId: string, speaking: boolean) => void;
  onPeerVoiceState?: (peerId: string, state: { muted: boolean; deafened: boolean }) => void;
  /** Remote (or self) screen stream; null when share ends. */
  onScreenShare?: (peerId: string, stream: MediaStream | null) => void;
};

type PeerRuntime = {
  connection: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  remoteReady: boolean;
  failTimer?: number;
  connectTimer?: number;
  natTimer?: number;
  restartAttempted: boolean;
  sawRelay: boolean;
  sawRemoteRelay: boolean;
  candidateTypes: Set<string>;
  remoteCandidateTypes: Set<string>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  gain?: GainNode;
  analyser?: AnalyserNode;
  source?: MediaStreamAudioSourceNode;
  speakTimer?: number;
  speaking: boolean;
  remoteAudioStream?: MediaStream;
  remoteScreenStream?: MediaStream;
};

let activeVoiceMesh: VoiceMesh | null = null;

/** Active voice mesh for Diagnostics NAT snapshot (at most one). */
export function getActiveVoiceMesh(): VoiceMesh | null {
  return activeVoiceMesh;
}

const DEFAULT_MIC: MicProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  enhancedNoise: false,
};

/** Discord-like user-volume boost: 0..2 (200%). */
const MAX_PEER_GAIN = 2;

function failHint(runtime: PeerRuntime): string {
  const source = getLastIceSource();
  if (!runtime.sawRelay && (source === "static-openrelay" || source === "cache")) {
    return "TURN не выдал relay. Опционально: Metered API key или свой TURN в Настройки → Расширенные";
  }
  if (!runtime.sawRelay) {
    return "TURN не выдал relay-кандидат — проверьте TURN/Metered в настройках (по желанию)";
  }
  if (isCustomTurnConfigured() || source === "metered-api") {
    return "Не удалось установить голосовой канал (NAT/firewall). Попробуйте снова зайти в канал";
  }
  return "Не удалось установить голосовой канал";
}

export class VoiceMesh {
  private readonly selfId: string;
  private readonly sendSignal: (toPeerId: string, data: VoiceSignal) => boolean | void;
  private readonly options: VoiceMeshOptions;
  private rawStream: MediaStream | null = null;
  private outboundStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private micGain: GainNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private noiseGate: AudioWorkletNode | null = null;
  private selfAnalyser: AnalyserNode | null = null;
  private selfSpeakTimer: number | null = null;
  private selfSpeaking = false;
  private inputDeviceId = "";
  private outputDeviceId = "";
  private audioElements = new Map<string, HTMLAudioElement>();
  private peerVolumes = new Map<string, number>();
  private micVolume = 1;
  private micProcessing: MicProcessing = { ...DEFAULT_MIC };
  private muted = false;
  private deafened = false;
  private peers = new Map<string, PeerRuntime>();
  /** Same PC as voice: screen is an extra video track + renegotiation (not a second mesh). */
  private screenStream: MediaStream | null = null;
  private screenSharing = false;

  constructor(
    selfId: string,
    sendSignal: (toPeerId: string, data: VoiceSignal) => boolean | void,
    options: VoiceMeshOptions = {},
  ) {
    this.selfId = selfId;
    this.sendSignal = sendSignal;
    this.options = options;
    activeVoiceMesh = this;
  }

  private emitSignal(toPeerId: string, data: VoiceSignal): boolean {
    const ok = this.sendSignal(toPeerId, data);
    if (ok === false) {
      debugLog(
        "signal",
        "dropped",
        {
          to: toPeerId.slice(0, 8),
          kind: data.kind,
        },
        "warn",
      );
      return false;
    }
    return true;
  }

  private async applyOutputSink(ctx: AudioContext): Promise<void> {
    if (!this.outputDeviceId) return;
    const anyCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof anyCtx.setSinkId !== "function") return;
    try {
      await anyCtx.setSinkId(this.outputDeviceId);
      debugLog("voice", "audioContext setSinkId ok", { device: this.outputDeviceId.slice(0, 12) });
    } catch (error) {
      debugLog("voice", "audioContext setSinkId failed", error, "warn");
    }
  }

  /** Full NAT/voice snapshot for beta reports (getStats + ICE types + diagnosis codes). */
  async collectNatReport(): Promise<VoiceNatReport> {
    const peers = await Promise.all(
      [...this.peers.entries()].map(([peerId, runtime]) => this.snapshotRuntime(peerId, runtime)),
    );
    const report = buildVoiceNatReport(peers);
    debugLog("voice-nat", "manual snapshot", {
      summary: report.summary,
      iceSource: report.iceSource,
      meteredConfigured: report.meteredConfigured,
      peerCount: peers.length,
      peers: peers.map((p) => ({
        peerId: p.peerId.slice(0, 8),
        diagnosis: p.diagnosis,
        connectionState: p.connectionState,
        selected: p.selected,
        audio: p.audio,
      })),
    });
    return report;
  }

  private async snapshotRuntime(peerId: string, runtime: PeerRuntime) {
    return snapshotPeerConnection(peerId, runtime.connection, {
      localTypes: runtime.candidateTypes,
      remoteTypes: runtime.remoteCandidateTypes,
      sawLocalRelay: runtime.sawRelay,
      sawRemoteRelay: runtime.sawRemoteRelay,
      hasRemoteAudioTrack: Boolean(runtime.remoteAudioStream?.getAudioTracks().length),
    });
  }

  private async logPeerNatSnapshot(peerId: string, reason: string): Promise<void> {
    const runtime = this.peers.get(peerId);
    if (!runtime) return;
    try {
      const peer = await this.snapshotRuntime(peerId, runtime);
      const report = buildVoiceNatReport([peer]);
      debugLog("voice-nat", reason, {
        peerId: peerId.slice(0, 8),
        diagnosis: peer.diagnosis,
        hint: peer.hint,
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        localTypes: peer.localTypes,
        remoteTypes: peer.remoteTypes,
        sawLocalRelay: peer.sawLocalRelay,
        sawRemoteRelay: peer.sawRemoteRelay,
        selected: peer.selected,
        audio: peer.audio,
        iceSource: report.iceSource,
        meteredConfigured: report.meteredConfigured,
        iceServerSummary: report.iceServerSummary,
      });
    } catch (error) {
      debugLog("voice-nat", "snapshot failed", { peerId, reason, error }, "warn");
    }
  }

  private noteRemoteCandidate(runtime: PeerRuntime, candidate: RTCIceCandidateInit): void {
    const summary = summarizeCandidate(candidate);
    if (!summary) return;
    runtime.remoteCandidateTypes.add(summary.type);
    if (summary.type === "relay") runtime.sawRemoteRelay = true;
    debugLog("voice", "remote ice", {
      type: summary.type,
      protocol: summary.protocol,
      family: summary.family,
      scope: summary.scope,
    });
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
    this.inputDeviceId = loadAudioInputId();
    this.outputDeviceId = loadAudioOutputId();
    await this.acquireMic();
    this.startSelfSpeakingMonitor();
  }

  setInputDevice(deviceId: string): void {
    this.inputDeviceId = deviceId;
    if (this.rawStream) void this.acquireMic();
  }

  setOutputDevice(deviceId: string): void {
    this.outputDeviceId = deviceId;
    if (this.audioContext) void this.applyOutputSink(this.audioContext);
    void this.applyOutputDeviceToAll();
  }

  private async applyOutputDeviceToAll(): Promise<void> {
    if (!this.outputDeviceId) return;
    for (const audio of this.audioElements.values()) {
      const el = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === "function") {
        try {
          await el.setSinkId(this.outputDeviceId);
        } catch (error) {
          debugLog("voice", "audio element setSinkId failed", error, "warn");
        }
      }
    }
  }

  private startSelfSpeakingMonitor(): void {
    if (this.selfSpeakTimer) window.clearInterval(this.selfSpeakTimer);
    if (!this.selfAnalyser) return;
    const data = new Uint8Array(this.selfAnalyser.frequencyBinCount);
    this.selfSpeakTimer = window.setInterval(() => {
      this.selfAnalyser!.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i]!;
      const speaking = sum / data.length > 18 && !this.muted;
      if (speaking !== this.selfSpeaking) {
        this.selfSpeaking = speaking;
        this.options.onSpeaking?.(this.selfId, speaking);
      }
    }, 120);
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    void this.applyOutputSink(this.audioContext);
    return this.audioContext;
  }

  private async acquireMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Браузер не поддерживает доступ к микрофону");
    }
    debugLog("voice", "requesting microphone", {
      inputDeviceId: this.inputDeviceId || null,
      processing: this.micProcessing,
    });
    const baseConstraints: MediaTrackConstraints = {
      echoCancellation: this.micProcessing.echoCancellation,
      noiseSuppression: this.micProcessing.noiseSuppression,
      autoGainControl: this.micProcessing.autoGainControl,
    };
    const requestMic = (constraints: MediaTrackConstraints) =>
      withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: constraints }),
        20_000,
        "Нет ответа от микрофона (таймаут 20 с). Разрешите доступ в Windows/приложении и попробуйте снова.",
      );

    let nextRaw: MediaStream;
    try {
      const constraints: MediaTrackConstraints = { ...baseConstraints };
      if (this.inputDeviceId) constraints.deviceId = { exact: this.inputDeviceId };
      nextRaw = await requestMic(constraints);
    } catch (error) {
      if (this.inputDeviceId) {
        debugLog("voice", "exact input device failed, retrying default", error, "warn");
        this.inputDeviceId = "";
        nextRaw = await requestMic(baseConstraints);
      } else {
        throw error;
      }
    }
    for (const track of this.rawStream?.getTracks() ?? []) track.stop();
    this.rawStream = nextRaw;

    const ctx = this.ensureAudioContext();
    if (ctx.state === "suspended") await ctx.resume();

    this.micSource?.disconnect();
    this.noiseGate?.disconnect();
    this.noiseGate = null;
    this.selfAnalyser?.disconnect();

    const source = ctx.createMediaStreamSource(nextRaw);
    this.micSource = source;
    if (!this.micGain) this.micGain = ctx.createGain();
    this.micGain.gain.value = this.muted ? 0 : this.micVolume;
    const dest = ctx.createMediaStreamDestination();
    const selfAnalyser = ctx.createAnalyser();
    selfAnalyser.fftSize = 512;
    selfAnalyser.smoothingTimeConstant = 0.5;

    let chainTail: AudioNode = source;
    if (this.micProcessing.enhancedNoise) {
      const ok = await ensureNoiseWorklet(ctx);
      if (ok) {
        const gate = createNoiseGateNode(ctx);
        if (gate) {
          this.noiseGate = gate;
          source.connect(gate);
          chainTail = gate;
        }
      }
    }
    chainTail.connect(this.micGain);
    this.micGain.connect(dest);
    this.micGain.connect(selfAnalyser);
    this.selfAnalyser = selfAnalyser;
    this.outboundStream = dest.stream;

    for (const track of this.outboundStream.getAudioTracks()) {
      track.enabled = !this.muted;
    }

    await this.replaceOutboundTracks();
    this.startSelfSpeakingMonitor();
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
    this.micProcessing.autoGainControl = false;
    if (this.micGain && this.audioContext) {
      this.micGain.gain.setTargetAtTime(this.muted ? 0 : this.micVolume, this.audioContext.currentTime, 0.04);
    }
  }

  getMicVolume(): number {
    return this.micVolume;
  }

  isScreenSharing(): boolean {
    return this.screenSharing;
  }

  getLocalScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  /**
   * Capture display and publish as a video track on existing peer connections.
   * Prefer this over a second RTCPeerConnection: one ICE/DTLS/TURN path, less glare.
   */
  async startScreenShare(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Демонстрация экрана не поддерживается в этой сборке");
    }
    if (this.screenSharing) return;
    if (!this.outboundStream) await this.start();

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 15, max: 30 },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
      },
      audio: false,
    });
    const [track] = stream.getVideoTracks();
    if (!track) {
      for (const item of stream.getTracks()) item.stop();
      throw new Error("Не удалось получить дорожку экрана");
    }
    track.contentHint = "detail";
    track.onended = () => {
      void this.stopScreenShare();
    };

    this.screenStream = stream;
    this.screenSharing = true;
    this.options.onScreenShare?.(this.selfId, stream);

    for (const [peerId, runtime] of this.peers) {
      try {
        runtime.connection.addTrack(track, stream);
        await this.tuneScreenSender(runtime.connection, track);
        await this.renegotiate(peerId);
      } catch (error) {
        debugLog("voice", "screen addTrack/renegotiate failed", { peerId, error }, "warn");
      }
    }
    this.broadcastScreenShare(true);
    debugLog("voice", "screen share started", { peers: this.peers.size });
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenSharing && !this.screenStream) return;
    const track = this.screenStream?.getVideoTracks()[0] ?? null;
    for (const [peerId, runtime] of this.peers) {
      for (const sender of runtime.connection.getSenders()) {
        if (sender.track && sender.track === track) {
          try {
            runtime.connection.removeTrack(sender);
          } catch {
            // ignore
          }
        }
      }
      if (track) {
        try {
          await this.renegotiate(peerId);
        } catch (error) {
          debugLog("voice", "screen stop renegotiate failed", { peerId, error }, "warn");
        }
      }
    }
    for (const item of this.screenStream?.getTracks() ?? []) item.stop();
    this.screenStream = null;
    this.screenSharing = false;
    this.options.onScreenShare?.(this.selfId, null);
    this.broadcastScreenShare(false);
    debugLog("voice", "screen share stopped");
  }

  private broadcastScreenShare(active: boolean): void {
    for (const peerId of this.peers.keys()) {
      this.emitSignal(peerId, { kind: "screen-share", active });
    }
  }

  private async renegotiate(peerId: string): Promise<void> {
    const runtime = this.peers.get(peerId);
    if (!runtime) return;
    const { connection } = runtime;
    if (connection.signalingState === "closed") return;
    // Don't offer while answering a remote offer.
    if (connection.signalingState === "have-remote-offer") return;
    try {
      runtime.makingOffer = true;
      await connection.setLocalDescription(await connection.createOffer());
      if (connection.localDescription) {
        this.emitSignal(peerId, { kind: "offer", description: connection.localDescription });
      }
    } catch (error) {
      debugLog("voice", "renegotiate failed", { peerId, error }, "warn");
    } finally {
      runtime.makingOffer = false;
    }
  }

  private async tuneScreenSender(connection: RTCPeerConnection, track: MediaStreamTrack): Promise<void> {
    const sender = connection.getSenders().find((item) => item.track === track);
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0] = {
        ...params.encodings[0],
        maxBitrate: 1_500_000,
        maxFramerate: 15,
      };
      await sender.setParameters(params);
    } catch {
      // Some engines reject setParameters before negotiation.
    }
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
    // Keep the hidden <audio> silent forever — loudness is only via GainNode.
    // Setting volume=1 here used to double the peer's voice with the Web Audio path.
    const audio = this.audioElements.get(peerId);
    if (audio) {
      audio.volume = 0;
      audio.muted = true;
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
    audio.volume = 0;
    audio.muted = true; // never play element + GainNode together
    void this.applyOutputDeviceToAll();
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
    if (peerId === this.selfId) return;
    const existing = this.peers.get(peerId);
    if (existing) {
      const state = existing.connection.connectionState;
      if (state === "connected" || state === "connecting") return;
      debugLog(
        "voice",
        "recreate stale peer",
        { peerId: peerId.slice(0, 8), state, ice: existing.connection.iceConnectionState },
        "warn",
      );
      this.removePeer(peerId);
    }
    if (!this.outboundStream) await this.start();
    const iceServers = await warmIceServers();
    const iceSummary = summarizeIceServers(iceServers.length > 0 ? iceServers : buildIceServers());
    rememberIceServerSummary(iceSummary);
    debugLog("voice", "addPeer", {
      peerId,
      initiator,
      turn: this.hasTurn(),
      iceSource: getLastIceSource(),
      iceServers: iceServers.length,
      iceSummary,
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
      sawRemoteRelay: false,
      candidateTypes: new Set(),
      remoteCandidateTypes: new Set(),
      makingOffer: false,
      ignoreOffer: false,
      speaking: false,
    };
    this.peers.set(peerId, runtime);
    this.options.onPeerStatus?.(peerId, "connecting");

    for (const track of this.outboundStream?.getTracks() ?? []) {
      connection.addTrack(track, this.outboundStream!);
    }
    const screenTrack = this.screenStream?.getVideoTracks()[0];
    if (screenTrack && this.screenStream) {
      connection.addTrack(screenTrack, this.screenStream);
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      const summary = summarizeCandidate(event.candidate);
      const type = summary?.type || event.candidate.type || "unknown";
      runtime.candidateTypes.add(type);
      if (type === "relay") runtime.sawRelay = true;
      debugLog("voice", "local ice", {
        peerId,
        type,
        protocol: summary?.protocol || event.candidate.protocol,
        family: summary?.family,
        scope: summary?.scope,
        tcpType: summary?.tcpType,
      });
      this.emitSignal(peerId, { kind: "ice", candidate: event.candidate.toJSON() });
    };

    connection.onicegatheringstatechange = () => {
      if (connection.iceGatheringState !== "complete") return;
      debugLog("voice", "ice gathering complete", {
        peerId,
        localTypes: [...runtime.candidateTypes],
        remoteTypes: [...runtime.remoteCandidateTypes],
        sawLocalRelay: runtime.sawRelay,
        sawRemoteRelay: runtime.sawRemoteRelay,
        iceSource: getLastIceSource(),
        iceSummary,
      });
    };

    connection.oniceconnectionstatechange = () => {
      debugLog("voice", "iceConnectionState", {
        peerId,
        state: connection.iceConnectionState,
        sawLocalRelay: runtime.sawRelay,
        sawRemoteRelay: runtime.sawRemoteRelay,
      });
    };

    connection.ontrack = (event) => {
      const track = event.track;
      const [stream] = event.streams;
      debugLog("voice", "ontrack", {
        peerId,
        kind: track.kind,
        streams: event.streams.length,
        muted: track.muted,
        enabled: track.enabled,
        readyState: track.readyState,
      });
      if (track.kind === "video") {
        const videoStream = stream ?? new MediaStream([track]);
        runtime.remoteScreenStream = videoStream;
        this.options.onScreenShare?.(peerId, videoStream);
        track.onended = () => {
          if (runtime.remoteScreenStream === videoStream) {
            runtime.remoteScreenStream = undefined;
            this.options.onScreenShare?.(peerId, null);
          }
        };
        return;
      }
      if (track.kind === "audio") {
        const audioStream = stream ?? new MediaStream([track]);
        runtime.remoteAudioStream = audioStream;
        this.attachRemoteAudio(peerId, audioStream);
        this.emitSignal(peerId, { kind: "voice-state", muted: this.muted, deafened: this.deafened });
        if (this.screenSharing) {
          this.emitSignal(peerId, { kind: "screen-share", active: true });
        }
      }
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      debugLog("voice", "connectionState", {
        peerId,
        state,
        sawLocalRelay: runtime.sawRelay,
        sawRemoteRelay: runtime.sawRemoteRelay,
        localTypes: [...runtime.candidateTypes],
        remoteTypes: [...runtime.remoteCandidateTypes],
      });
      if (state === "connected") {
        if (runtime.failTimer) window.clearTimeout(runtime.failTimer);
        runtime.failTimer = undefined;
        if (runtime.connectTimer) window.clearTimeout(runtime.connectTimer);
        runtime.connectTimer = undefined;
        this.options.onPeerStatus?.(peerId, "connected");
        this.emitSignal(peerId, { kind: "voice-state", muted: this.muted, deafened: this.deafened });
        // Delayed getStats so inbound audio bytes can accumulate (chat OK / media silent).
        if (runtime.natTimer) window.clearTimeout(runtime.natTimer);
        runtime.natTimer = window.setTimeout(() => {
          void this.logPeerNatSnapshot(peerId, "connected-stats");
        }, 2500);
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

    runtime.connectTimer = window.setTimeout(() => {
      const state = connection.connectionState;
      if (state === "connected" || state === "closed") return;
      debugLog("voice", "connect timeout", { peerId, state }, "warn");
      void this.handleFailed(peerId, runtime, initiator);
    }, 45_000);

    if (initiator) {
      try {
        runtime.makingOffer = true;
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        this.emitSignal(peerId, { kind: "offer", description: offer });
      } finally {
        runtime.makingOffer = false;
      }
    }
  }

  private async handleFailed(peerId: string, runtime: PeerRuntime, initiator: boolean): Promise<void> {
    if (!this.peers.has(peerId)) return;
    if (!runtime.restartAttempted) {
      runtime.restartAttempted = true;
      debugLog("voice", "iceRestart", { peerId, sawRelay: runtime.sawRelay, initiator }, "warn");
      this.options.onPeerStatus?.(peerId, "connecting", "Переподключаем голос…");
      try {
        clearIceCache();
        const iceServers = await warmIceServers();
        runtime.connection.setConfiguration({
          iceServers: iceServers.length > 0 ? iceServers : buildIceServers(),
        });
        if (initiator || this.selfId > peerId) {
          runtime.makingOffer = true;
          const offer = await runtime.connection.createOffer({ iceRestart: true });
          await runtime.connection.setLocalDescription(offer);
          this.emitSignal(peerId, { kind: "offer", description: offer });
          return;
        }
      } catch (error) {
        debugLog("voice", "iceRestart failed", error, "warn");
      } finally {
        runtime.makingOffer = false;
      }
    }

    await this.logPeerNatSnapshot(peerId, "failed-stats");
    const detail = failHint(runtime);
    this.options.onPeerStatus?.(peerId, "failed", detail);
    this.removePeer(peerId);
  }

  async handleSignal(fromPeerId: string, data: unknown): Promise<void> {
    const signal = data as Partial<VoiceSignal> & { kind?: string };
    if (!signal.kind) return;
    if (signal.kind === "voice-state") {
      this.options.onPeerVoiceState?.(fromPeerId, {
        muted: Boolean((signal as { muted?: boolean }).muted),
        deafened: Boolean((signal as { deafened?: boolean }).deafened),
      });
      return;
    }
    if (signal.kind === "screen-share") {
      const active = Boolean((signal as { active?: boolean }).active);
      if (!active) {
        const runtime = this.peers.get(fromPeerId);
        if (runtime?.remoteScreenStream) {
          runtime.remoteScreenStream = undefined;
        }
        this.options.onScreenShare?.(fromPeerId, null);
      }
      return;
    }
    if (!this.peers.has(fromPeerId)) await this.addPeer(fromPeerId, false);
    const runtime = this.peers.get(fromPeerId);
    if (!runtime) return;
    const { connection } = runtime;
    const polite = this.selfId > fromPeerId;

    if (signal.kind === "offer" && signal.description) {
      const offerCollision = runtime.makingOffer || connection.signalingState !== "stable";
      runtime.ignoreOffer = !polite && offerCollision;
      if (runtime.ignoreOffer) {
        debugLog("voice", "ignoring glare offer", { fromPeerId }, "warn");
        return;
      }
      try {
        await connection.setRemoteDescription(signal.description);
        runtime.remoteReady = true;
        await this.flushIce(fromPeerId);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        this.emitSignal(fromPeerId, { kind: "answer", description: answer });
      } catch (error) {
        debugLog(
          "voice",
          "setRemoteDescription offer failed",
          { fromPeerId, signalingState: connection.signalingState, error },
          "warn",
        );
      }
    } else if (signal.kind === "answer" && signal.description) {
      try {
        await connection.setRemoteDescription(signal.description);
        runtime.remoteReady = true;
        await this.flushIce(fromPeerId);
      } catch (error) {
        debugLog("voice", "setRemoteDescription answer failed", error, "warn");
      }
    } else if (signal.kind === "ice" && signal.candidate) {
      this.noteRemoteCandidate(runtime, signal.candidate);
      if (!runtime.remoteReady) {
        runtime.pendingIce.push(signal.candidate);
        return;
      }
      try {
        await connection.addIceCandidate(signal.candidate);
      } catch (error) {
        debugLog("voice", "addIceCandidate failed", { fromPeerId, error }, "warn");
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
      } catch (error) {
        debugLog("voice", "flushIce candidate failed", { peerId, error }, "warn");
      }
    }
  }

  private broadcastVoiceState(): void {
    for (const peerId of this.peers.keys()) {
      this.emitSignal(peerId, { kind: "voice-state", muted: this.muted, deafened: this.deafened });
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
    if (runtime?.connectTimer) window.clearTimeout(runtime.connectTimer);
    if (runtime?.natTimer) window.clearTimeout(runtime.natTimer);
    if (runtime?.speakTimer) window.clearInterval(runtime.speakTimer);
    runtime?.source?.disconnect();
    runtime?.analyser?.disconnect();
    runtime?.gain?.disconnect();
    if (runtime?.remoteScreenStream) {
      this.options.onScreenShare?.(peerId, null);
    }
    runtime?.connection.close();
    this.peers.delete(peerId);
    const audio = this.audioElements.get(peerId);
    audio?.remove();
    this.audioElements.delete(peerId);
    this.options.onSpeaking?.(peerId, false);
  }

  stop(): void {
    for (const track of this.screenStream?.getTracks() ?? []) track.stop();
    this.screenStream = null;
    if (this.screenSharing) {
      this.screenSharing = false;
      this.options.onScreenShare?.(this.selfId, null);
    }
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    if (this.selfSpeakTimer) window.clearInterval(this.selfSpeakTimer);
    this.selfSpeakTimer = null;
    this.micSource?.disconnect();
    this.micSource = null;
    this.noiseGate?.disconnect();
    this.noiseGate = null;
    this.selfAnalyser?.disconnect();
    this.selfAnalyser = null;
    for (const track of this.rawStream?.getTracks() ?? []) track.stop();
    this.rawStream = null;
    this.outboundStream = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.micGain = null;
    if (activeVoiceMesh === this) activeVoiceMesh = null;
  }
}
