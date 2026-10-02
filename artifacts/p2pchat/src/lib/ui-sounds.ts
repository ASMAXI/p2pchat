/**
 * Short UI notification tones (Web Audio) — no asset files.
 * Distinct per scenario so they stay recognizable at low volume.
 */

export type UiSoundId =
  | "startup"
  | "member-join"
  | "voice-join"
  | "chat-text"
  | "chat-image"
  | "mention";

/** Startup logo motifs (~2s). Pick in settings. */
export type StartupSoundId = "tide" | "chime" | "signal";

export const STARTUP_SOUND_OPTIONS: Array<{ id: StartupSoundId; label: string; hint: string }> = [
  { id: "tide", label: "1 · Прилив", hint: "мягкий дрон и плавное всплытие" },
  { id: "chime", label: "2 · Колокольчик", hint: "лёгкие переливы, как ветер" },
  { id: "signal", label: "3 · Сигнал", hint: "тёплый логотипный мотив" },
];

const ENABLED_KEY = "p2pchat-ui-sounds";
const STARTUP_KEY = "p2pchat-startup-sound";

let sharedCtx: AudioContext | null = null;
let lastPlayAt = 0;
let startupPlayed = false;

export function loadUiSoundsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(ENABLED_KEY);
    if (raw === null) return true;
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

export function saveUiSoundsEnabled(enabled: boolean): void {
  window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
}

export function loadStartupSoundId(): StartupSoundId {
  try {
    const raw = window.localStorage.getItem(STARTUP_KEY);
    if (raw === "tide" || raw === "chime" || raw === "signal") return raw;
  } catch {
    // ignore
  }
  return "tide";
}

export function saveStartupSoundId(id: StartupSoundId): void {
  window.localStorage.setItem(STARTUP_KEY, id);
}

function ensureCtx(): AudioContext | null {
  try {
    if (!sharedCtx) sharedCtx = new AudioContext();
    return sharedCtx;
  } catch {
    return null;
  }
}

function tone(
  ctx: AudioContext,
  {
    freq,
    start,
    duration,
    type = "sine",
    gain = 0.08,
    slideTo,
    attack = 0.02,
  }: {
    freq: number;
    start: number;
    duration: number;
    type?: OscillatorType;
    gain?: number;
    slideTo?: number;
    attack?: number;
  },
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), start + duration);
  }
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + Math.max(0.01, attack));
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/** 1 — soft underwater swell, ~2s */
function playTide(ctx: AudioContext, t: number): void {
  tone(ctx, { freq: 110, start: t, duration: 2.0, type: "sine", gain: 0.032, attack: 0.35 });
  tone(ctx, { freq: 164.81, start: t + 0.12, duration: 1.85, type: "sine", gain: 0.022, attack: 0.4 });
  tone(ctx, { freq: 220, start: t + 0.35, duration: 1.55, type: "triangle", gain: 0.038, attack: 0.2, slideTo: 246.94 });
  tone(ctx, { freq: 329.63, start: t + 0.7, duration: 1.2, type: "sine", gain: 0.04, attack: 0.18 });
  tone(ctx, { freq: 440, start: t + 1.05, duration: 0.95, type: "sine", gain: 0.03, attack: 0.2, slideTo: 392 });
}

/** 2 — airy chime cascade, ~2s */
function playChime(ctx: AudioContext, t: number): void {
  const notes = [
    { f: 523.25, at: 0.0, d: 1.4, g: 0.045 },
    { f: 659.25, at: 0.28, d: 1.35, g: 0.038 },
    { f: 783.99, at: 0.55, d: 1.3, g: 0.034 },
    { f: 987.77, at: 0.85, d: 1.1, g: 0.028 },
    { f: 880.0, at: 1.15, d: 0.85, g: 0.024 },
  ];
  tone(ctx, { freq: 196, start: t, duration: 2.0, type: "sine", gain: 0.018, attack: 0.3 });
  for (const n of notes) {
    tone(ctx, { freq: n.f, start: t + n.at, duration: n.d, type: "triangle", gain: n.g, attack: 0.04 });
    tone(ctx, { freq: n.f * 2.01, start: t + n.at + 0.01, duration: n.d * 0.7, type: "sine", gain: n.g * 0.25, attack: 0.03 });
  }
}

/** 3 — warm brand interval + settle, ~2s */
function playSignal(ctx: AudioContext, t: number): void {
  tone(ctx, { freq: 146.83, start: t, duration: 2.0, type: "sine", gain: 0.026, attack: 0.25 });
  tone(ctx, { freq: 293.66, start: t + 0.08, duration: 0.55, type: "triangle", gain: 0.055, attack: 0.05 });
  tone(ctx, { freq: 440.0, start: t + 0.28, duration: 0.65, type: "sine", gain: 0.05, attack: 0.06 });
  tone(ctx, { freq: 587.33, start: t + 0.55, duration: 0.9, type: "triangle", gain: 0.048, attack: 0.08 });
  tone(ctx, { freq: 698.46, start: t + 0.85, duration: 1.1, type: "sine", gain: 0.036, attack: 0.12, slideTo: 523.25 });
  tone(ctx, { freq: 349.23, start: t + 1.1, duration: 0.9, type: "triangle", gain: 0.028, attack: 0.15 });
}

function playStartupVariant(ctx: AudioContext, t: number, id: StartupSoundId): void {
  if (id === "chime") playChime(ctx, t);
  else if (id === "signal") playSignal(ctx, t);
  else playTide(ctx, t);
}

/** Preview any startup motif (ignores mute + once-per-session). */
export function previewStartupSound(id: StartupSoundId): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  void ctx.resume();
  playStartupVariant(ctx, ctx.currentTime + 0.02, id);
}

/** Play a UI sound. Skips if disabled, rapid-fire, or AudioContext unavailable. */
export function playUiSound(id: UiSoundId): void {
  if (!loadUiSoundsEnabled()) return;
  const now = Date.now();
  if (id !== "startup" && now - lastPlayAt < 80) return;
  lastPlayAt = now;

  const ctx = ensureCtx();
  if (!ctx) return;
  void ctx.resume();
  const t = ctx.currentTime + 0.01;

  switch (id) {
    case "startup":
      playStartupVariant(ctx, t, loadStartupSoundId());
      break;
    case "member-join":
      tone(ctx, { freq: 523.25, start: t, duration: 0.12, type: "triangle", gain: 0.07 });
      tone(ctx, { freq: 659.25, start: t + 0.1, duration: 0.18, type: "triangle", gain: 0.08 });
      break;
    case "voice-join":
      tone(ctx, { freq: 440, start: t, duration: 0.16, type: "sine", gain: 0.07, slideTo: 660 });
      tone(ctx, { freq: 330, start: t + 0.05, duration: 0.12, type: "triangle", gain: 0.04 });
      break;
    case "chat-text":
      tone(ctx, { freq: 880, start: t, duration: 0.06, type: "square", gain: 0.035 });
      break;
    case "chat-image":
      tone(ctx, { freq: 740, start: t, duration: 0.07, type: "triangle", gain: 0.055 });
      tone(ctx, { freq: 980, start: t + 0.08, duration: 0.09, type: "sine", gain: 0.05 });
      break;
    case "mention":
      tone(ctx, { freq: 784, start: t, duration: 0.1, type: "triangle", gain: 0.09 });
      tone(ctx, { freq: 1046, start: t + 0.12, duration: 0.14, type: "sine", gain: 0.08 });
      tone(ctx, { freq: 1318, start: t + 0.26, duration: 0.16, type: "triangle", gain: 0.06 });
      break;
    default:
      break;
  }
}

/** Once per page/session load — selected Drift startup motif. */
export function playStartupSound(): void {
  if (startupPlayed) return;
  startupPlayed = true;
  window.setTimeout(() => playUiSound("startup"), 280);
}
