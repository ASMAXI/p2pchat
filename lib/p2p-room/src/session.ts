import {
  decryptContent,
  encryptContent,
  randomToken,
  signText,
  verifyPeerSignature,
  type StoredIdentity,
} from "@workspace/p2p-identity";
import {
  compareMessages,
  joinProofText,
  LIMITS,
  messageAad,
  messageProofText,
  PROTOCOL_VERSION,
  type ChannelType,
  type ClientCommand,
  type ErrorCode,
  type OutgoingMessage,
  type RoomStatus,
  type ServerEvent,
  type WireMessage,
  type WireRoomState,
} from "@workspace/p2p-protocol";
import { compareCoordinators } from "./election";
import { buildConnectPlan, type ConnectTarget } from "./migration";

export type SessionStatus = "connecting" | "connected" | "reconnecting" | "offline";
export type DeliveryState = "queued" | "sent" | "synced";

export type ChatMessage = {
  id: string;
  channelId: string;
  authorId: string;
  author: string;
  timestamp: string;
  /** `null` when the content could not be decrypted (missing or wrong room key). */
  text: string | null;
  delivery: DeliveryState;
};

export type OutboxItem = { message: OutgoingMessage; plaintext: string };

export type SessionSnapshot = {
  state: WireRoomState | null;
  outbox: OutboxItem[];
  lastOrigin?: string;
};

export type SessionView = {
  state: WireRoomState | null;
  messages: ChatMessage[];
  status: SessionStatus;
  origin?: string;
  isCoordinator: boolean;
  rttMs?: number;
  lastError?: string;
};

export type SessionTiming = {
  connectTimeoutMs: number;
  notCoordinatorRetryMs: number;
  notCoordinatorRetries: number;
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  probeIntervalMs: number;
  retryDelayMs: number;
  reconnectDelayMs: number;
};

export type RoomSessionOptions = {
  roomId: string;
  inviteToken: string;
  roomKey?: string;
  identity: StoredIdentity;
  /** Invite/bootstrap addresses. */
  bootstrapOrigins: string[];
  /** Our own node, when the runtime can host (desktop). */
  localNode?: { origin: string; endpoints: string[] } | null;
  /** When false, never self-host (fresh invite join until we have a real replica). */
  allowSelfHost?: boolean;
  initial?: SessionSnapshot | null;
  timing?: Partial<SessionTiming>;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  onView?: (view: SessionView) => void;
  onPersist?: (snapshot: SessionSnapshot) => void;
  onVoice?: (event: Extract<ServerEvent, { type: "voice" }>) => void;
  onSignal?: (event: Extract<ServerEvent, { type: "signal" }>) => void;
  onError?: (message: string) => void;
  /** Fired for every connect attempt — used by desktop debug logs. */
  onAttempt?: (event: {
    origin: string;
    host: boolean;
    outcome: "unreachable" | "rejected" | "connected" | "ended";
    code?: string;
    message?: string;
    ms: number;
    healthz?: "ok" | "fail" | "skip";
  }) => void;
};

type Outcome =
  | { kind: "unreachable" }
  | { kind: "rejected"; code: ErrorCode; message: string; redirect?: string[] }
  | { kind: "ended"; hostId: string; kicked: boolean; redirect?: string[] };

const DEFAULT_TIMING: SessionTiming = {
  connectTimeoutMs: 3000,
  notCoordinatorRetryMs: 500,
  notCoordinatorRetries: 8,
  heartbeatMs: 5000,
  heartbeatTimeoutMs: 15000,
  probeIntervalMs: 5000,
  retryDelayMs: 2000,
  reconnectDelayMs: 200,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function wsUrl(origin: string): string {
  return `${origin.replace(/^http/, "ws")}/api/ws`;
}

function isPublicOrigin(origin: string): boolean {
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

function connectTimeoutFor(origin: string, base: number): number {
  // Quick Tunnel / public HTTPS often needs longer than LAN.
  return isPublicOrigin(origin) ? Math.max(base, 10000) : base;
}

export class RoomSession {
  private readonly timing: SessionTiming;
  private state: WireRoomState | null;
  private readonly outbox = new Map<string, OutboxItem>();
  private readonly sentIds = new Set<string>();
  private readonly verified = new Map<string, ChatMessage | null>();
  private socket: WebSocket | null = null;
  private endConnection: ((outcome: Outcome) => void) | null = null;
  private status: SessionStatus = "connecting";
  private origin?: string;
  private lastOrigin?: string;
  private hosting = false;
  private closed = false;
  private voiceChannel: string | null = null;
  private stepDownRedirect?: string[];
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private rttMs?: number;
  private lastError?: string;

  constructor(private readonly options: RoomSessionOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.state = options.initial?.state ?? null;
    this.lastOrigin = options.initial?.lastOrigin;
    for (const item of options.initial?.outbox ?? []) this.outbox.set(item.message.id, item);
  }

  get selfId(): string {
    return this.options.identity.peerId;
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.send({ type: "leave" });
    this.endConnection?.({ kind: "ended", hostId: this.state?.hostId ?? "", kicked: false });
    this.setStatus("offline");
  }

  getView(): SessionView {
    return {
      state: this.state,
      messages: this.buildMessages(),
      status: this.status,
      origin: this.origin,
      isCoordinator: this.hosting,
      rttMs: this.rttMs,
      lastError: this.lastError,
    };
  }

  sendChat(channelId: string, text: string): boolean {
    const plaintext = text.normalize("NFC").trim();
    if (!plaintext || plaintext.length > LIMITS.maxPlainMessageLength || !this.options.roomKey) return false;
    const { roomId, identity, roomKey } = this.options;
    const id = `m-${randomToken(12)}`;
    const timestamp = new Date().toISOString();
    const content = encryptContent(roomKey, plaintext, messageAad(roomId, id));
    const signature = signText(
      identity,
      messageProofText(roomId, { id, channelId, authorId: identity.peerId, timestamp, content }),
    );
    const message: OutgoingMessage = { id, channelId, content, timestamp, signature };
    this.outbox.set(id, { message, plaintext });
    if (this.status === "connected" && this.send({ type: "message", message })) this.sentIds.add(id);
    this.persist();
    this.emit();
    return true;
  }

  createChannel(name: string, channelType: ChannelType): boolean {
    return this.status === "connected" && this.send({ type: "create_channel", name, channelType });
  }

  setVoiceChannel(channelId: string | null): void {
    if (this.voiceChannel && this.voiceChannel !== channelId) {
      this.send({ type: "voice_leave", channelId: this.voiceChannel });
    }
    this.voiceChannel = channelId;
    if (channelId) this.send({ type: "voice_join", channelId });
  }

  sendSignal(toPeerId: string, data: unknown): void {
    this.send({ type: "signal", toPeerId, data });
  }

  private send(command: ClientCommand): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(command));
    return true;
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private emit(): void {
    this.options.onView?.(this.getView());
  }

  private persist(): void {
    this.options.onPersist?.({
      state: this.state,
      outbox: [...this.outbox.values()],
      lastOrigin: this.lastOrigin,
    });
  }

  private async run(): Promise<void> {
    let startup = true;
    let failedHostId: string | null = null;
    let redirect: string[] | undefined;
    let retryOrigin: string | undefined = this.lastOrigin;
    let emptyPlanRounds = 0;

    while (!this.closed) {
      const plan = buildConnectPlan({
        state: this.state,
        selfId: this.selfId,
        localOrigin: this.options.localNode?.origin,
        selfOrigins: this.options.localNode?.endpoints,
        bootstrapOrigins: this.options.bootstrapOrigins,
        failedHostId,
        retryOrigin,
        redirect,
        startup,
        allowSelfHost: this.options.allowSelfHost,
      });
      redirect = undefined;
      retryOrigin = undefined;
      let ended: Extract<Outcome, { kind: "ended" }> | null = null;

      if (plan.length === 0) {
        emptyPlanRounds += 1;
        this.lastError =
          this.options.allowSelfHost === false
            ? "Не удалось достучаться до хоста по ссылке. Попросите свежее приглашение или проверьте, что у хоста открыт Drift."
            : "Нет доступных адресов для подключения";
        this.options.onError?.(this.lastError);
        this.setStatus("reconnecting");
        await sleep(Math.min(8000, this.timing.retryDelayMs * emptyPlanRounds));
        startup = false;
        continue;
      }
      emptyPlanRounds = 0;

      for (let index = 0; index < plan.length && !this.closed; index += 1) {
        const target = plan[index]!;
        let outcome = await this.attempt(target);
        let retries = 0;
        while (outcome.kind === "rejected" && outcome.code === "NOT_COORDINATOR" && !this.closed) {
          const hints = (outcome.redirect ?? []).filter((origin) => origin !== target.origin);
          if (hints.length > 0) {
            plan.splice(index + 1, 0, ...hints.map((origin) => ({ origin, host: false })));
            break;
          }
          retries += 1;
          if (retries > this.timing.notCoordinatorRetries) break;
          await sleep(this.timing.notCoordinatorRetryMs);
          outcome = await this.attempt(target);
        }
        if (outcome.kind === "ended") {
          ended = outcome;
          break;
        }
      }

      startup = false;
      if (this.closed) break;
      if (ended) {
        failedHostId = ended.redirect ? null : ended.hostId;
        redirect = ended.redirect;
        retryOrigin = ended.kicked || ended.redirect ? undefined : this.lastOrigin;
        this.setStatus("reconnecting");
        await sleep(ended.redirect ? Math.max(this.timing.reconnectDelayMs, 1500) : this.timing.reconnectDelayMs);
        continue;
      }
      if (this.options.allowSelfHost === false) {
        this.lastError =
          "Не удалось достучаться до хоста. Попросите свежее приглашение — адрес Cloudflare мог устареть.";
        this.options.onError?.(this.lastError);
      }
      this.setStatus("reconnecting");
      await sleep(this.timing.retryDelayMs);
    }
  }

  private joinCommand(target: ConnectTarget): ClientCommand {
    const { identity, roomId, inviteToken } = this.options;
    const ts = Date.now();
    return {
      type: "join",
      protocol: PROTOCOL_VERSION,
      roomId,
      inviteToken,
      peerId: identity.peerId,
      displayName: identity.displayName,
      publicKey: identity.publicKey,
      ts,
      proof: signText(identity, joinProofText(roomId, identity.peerId, ts)),
      endpoints: this.options.localNode?.endpoints ?? [],
      host: target.host,
      snapshot: this.state ?? undefined,
    };
  }

  private async attempt(target: ConnectTarget): Promise<Outcome> {
    if (this.closed || (target.host && !this.state)) {
      return { kind: "unreachable" };
    }
    const started = Date.now();
    let healthz: "ok" | "fail" | "skip" = "skip";
    if (!target.host) {
      healthz = await this.probeHealthz(target.origin);
      // LAN: healthz fail → skip WS (fast). Public/tunnel: soft — still try WS
      // (fetch/CORS/tunnel quirks can fail healthz while the socket works).
      if (healthz === "fail" && !isPublicOrigin(target.origin)) {
        const outcome = { kind: "unreachable" as const };
        this.reportAttempt(target, outcome, started, healthz);
        return outcome;
      }
    }

    return await new Promise<Outcome>((resolve) => {
      const WebSocketImpl = this.options.WebSocketImpl ?? WebSocket;
      let socket: WebSocket;
      try {
        socket = new WebSocketImpl(wsUrl(target.origin));
      } catch {
        const outcome = { kind: "unreachable" as const };
        this.reportAttempt(target, outcome, started, healthz);
        resolve(outcome);
        return;
      }
      if (this.status !== "connected") this.setStatus(this.state ? "reconnecting" : "connecting");

      let joined = false;
      let settled = false;
      let lastSeen = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (heartbeat) clearInterval(heartbeat);
        if (this.socket === socket) {
          this.socket = null;
          this.endConnection = null;
          this.hosting = false;
          this.stopProbe();
          this.sentIds.clear();
        }
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        this.reportAttempt(target, outcome, started, healthz);
        resolve(outcome);
      };

      const connectTimer = setTimeout(() => {
        if (!joined) finish({ kind: "unreachable" });
      }, connectTimeoutFor(target.origin, this.timing.connectTimeoutMs));

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify(this.joinCommand(target)));
        } catch {
          finish({ kind: "unreachable" });
        }
      };

      socket.onmessage = (message) => {
        lastSeen = Date.now();
        let event: ServerEvent;
        try {
          event = JSON.parse(String(message.data)) as ServerEvent;
        } catch {
          return;
        }
        if (!joined) {
          if (event.type === "error") {
            this.lastError = event.message;
            finish({ kind: "rejected", code: event.code, message: event.message, redirect: event.redirect });
          } else if (event.type === "state") {
            joined = true;
            clearTimeout(connectTimer);
            this.socket = socket;
            this.endConnection = finish;
            heartbeat = setInterval(() => {
              if (Date.now() - lastSeen > this.timing.heartbeatTimeoutMs) {
                finish({ kind: "ended", hostId: this.state?.hostId ?? "", kicked: false });
                return;
              }
              this.send({ type: "ping", nonce: Date.now() });
            }, this.timing.heartbeatMs);
            this.onJoined(target, event.state);
            this.options.onAttempt?.({
              origin: target.origin,
              host: target.host,
              outcome: "connected",
              ms: Date.now() - started,
              healthz,
            });
          }
          return;
        }
        if (event.type === "error" && event.code === "NOT_COORDINATOR") {
          finish({ kind: "ended", hostId: this.state?.hostId ?? "", kicked: true, redirect: event.redirect });
          return;
        }
        this.handleEvent(event);
      };

      socket.onclose = () => {
        if (!joined) {
          finish({ kind: "unreachable" });
          return;
        }
        const redirect = this.stepDownRedirect;
        this.stepDownRedirect = undefined;
        finish({ kind: "ended", hostId: this.state?.hostId ?? "", kicked: Boolean(redirect), redirect });
      };

      socket.onerror = () => {
        // `onclose` follows and settles the attempt.
      };
    });
  }

  private reportAttempt(
    target: ConnectTarget,
    outcome: Outcome,
    started: number,
    healthz: "ok" | "fail" | "skip",
  ): void {
    if (outcome.kind === "ended") {
      // Successful join already reported "connected"; later disconnects are status logs.
      return;
    }
    this.options.onAttempt?.({
      origin: target.origin,
      host: target.host,
      outcome: outcome.kind,
      code: outcome.kind === "rejected" ? outcome.code : undefined,
      message: outcome.kind === "rejected" ? outcome.message : undefined,
      ms: Date.now() - started,
      healthz,
    });
    if (outcome.kind === "rejected") {
      this.lastError = `${outcome.code}: ${outcome.message} @ ${target.origin}`;
    } else if (outcome.kind === "unreachable") {
      this.lastError = `unreachable ${target.origin}${healthz === "fail" ? " (healthz)" : ""}`;
    }
  }

  private async probeHealthz(origin: string): Promise<"ok" | "fail" | "skip"> {
    const fetchImpl = this.options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!fetchImpl) return "skip";
    try {
      const response = await fetchImpl(`${origin.replace(/\/$/, "")}/api/healthz`, {
        method: "GET",
        signal: AbortSignal.timeout(isPublicOrigin(origin) ? 8000 : 2000),
      });
      return response.ok ? "ok" : "fail";
    } catch {
      return "fail";
    }
  }

  private onJoined(target: ConnectTarget, state: WireRoomState): void {
    this.origin = target.origin;
    this.lastOrigin = target.origin;
    this.hosting = target.host;
    this.lastError = undefined;
    this.applyState(state, true);
    for (const item of this.outbox.values()) {
      if (this.send({ type: "message", message: item.message })) this.sentIds.add(item.message.id);
    }
    if (this.voiceChannel) this.send({ type: "voice_join", channelId: this.voiceChannel });
    if (this.hosting) this.startProbe();
    this.status = "connected";
    this.persist();
    this.emit();
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case "state":
        this.applyState(event.state, true);
        break;
      case "presence":
        this.applyState(event.state, false);
        break;
      case "message":
        this.applyMessage(event.message);
        break;
      case "voice":
        this.options.onVoice?.(event);
        break;
      case "signal":
        this.options.onSignal?.(event);
        break;
      case "pong":
        this.rttMs = Math.max(0, Date.now() - event.nonce);
        this.emit();
        break;
      case "error":
        this.lastError = event.message;
        this.options.onError?.(event.message);
        this.emit();
        break;
    }
  }

  /** `presence` omits messages; the replica keeps its own copy. */
  private applyState(state: WireRoomState, full: boolean): void {
    const messages = full ? state.messages : (this.state?.messages ?? []);
    this.state = { ...state, messages };
    for (const message of messages) this.settleOutbox(message.id);
    this.persist();
    this.emit();
  }

  private applyMessage(message: WireMessage): void {
    if (!this.state) return;
    this.settleOutbox(message.id);
    if (!this.state.messages.some((item) => item.id === message.id)) {
      const messages = [...this.state.messages, message].sort(compareMessages);
      this.state = { ...this.state, messages: messages.slice(-LIMITS.maxStoredMessages) };
    }
    this.persist();
    this.emit();
  }

  private settleOutbox(id: string): void {
    this.outbox.delete(id);
    this.sentIds.delete(id);
  }

  private verify(message: WireMessage): ChatMessage | null {
    const cacheKey = `${message.id}:${message.signature}`;
    const cached = this.verified.get(cacheKey);
    if (cached !== undefined) return cached;
    const { roomId, roomKey } = this.options;
    const valid = verifyPeerSignature(
      message.authorId,
      message.authorPublicKey,
      messageProofText(roomId, message),
      message.signature,
    );
    const result: ChatMessage | null = valid
      ? {
          id: message.id,
          channelId: message.channelId,
          authorId: message.authorId,
          author: message.author,
          timestamp: message.timestamp,
          text: roomKey ? decryptContent(roomKey, message.content, messageAad(roomId, message.id)) : null,
          delivery: "synced",
        }
      : null;
    this.verified.set(cacheKey, result);
    return result;
  }

  private buildMessages(): ChatMessage[] {
    const list: ChatMessage[] = [];
    const known = new Set<string>();
    for (const message of this.state?.messages ?? []) {
      const verified = this.verify(message);
      if (!verified) continue;
      known.add(verified.id);
      list.push(verified);
    }
    for (const item of this.outbox.values()) {
      if (known.has(item.message.id)) continue;
      list.push({
        id: item.message.id,
        channelId: item.message.channelId,
        authorId: this.selfId,
        author: this.options.identity.displayName,
        timestamp: item.message.timestamp,
        text: item.plaintext,
        delivery: this.sentIds.has(item.message.id) ? "sent" : "queued",
      });
    }
    return list.sort((left, right) =>
      left.timestamp === right.timestamp ? (left.id < right.id ? -1 : 1) : left.timestamp < right.timestamp ? -1 : 1,
    );
  }

  private startProbe(): void {
    this.stopProbe();
    this.probeTimer = setInterval(() => void this.probe(), this.timing.probeIntervalMs);
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** While coordinating, look for a competing coordinator and yield to it if it wins. */
  private async probe(): Promise<void> {
    if (this.probing || !this.hosting || !this.state) return;
    this.probing = true;
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      // Only probe live member endpoints — never invite/bootstrap history
      // (stale LAN/tunnels caused step-down reconnect storms).
      const origins = new Set<string>();
      for (const member of this.state.members) {
        if (member.id === this.selfId || !member.online) continue;
        for (const endpoint of member.endpoints ?? []) origins.add(endpoint);
      }
      origins.delete(this.options.localNode?.origin ?? "");
      for (const endpoint of this.options.localNode?.endpoints ?? []) origins.delete(endpoint);

      const mine = { epoch: this.state.epoch, hostId: this.selfId };
      for (const origin of origins) {
        if (!this.hosting) return;
        let status: RoomStatus;
        try {
          const response = await fetchImpl(
            `${origin}/api/rooms/${encodeURIComponent(this.options.roomId)}/status?token=${encodeURIComponent(this.options.inviteToken)}`,
            { signal: AbortSignal.timeout(2000) },
          );
          if (!response.ok) continue;
          status = (await response.json()) as RoomStatus;
        } catch {
          continue;
        }
        if (!status.hosting || status.hostId === this.selfId) continue;
        if (compareCoordinators(status, mine) > 0) {
          this.stepDown([origin]);
          return;
        }
      }
    } finally {
      this.probing = false;
    }
  }

  private stepDown(redirect: string[]): void {
    this.stepDownRedirect = redirect;
    this.send({ type: "leave", redirect: redirect[0] });
    this.endConnection?.({ kind: "ended", hostId: this.selfId, kicked: true, redirect });
  }
}
