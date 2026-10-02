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

const ENABLED_KEY = "p2pchat-ui-sounds";

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
  g.gain.exponentialRampToValueAtTime(gain, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** Soft logo sting: open fifths that gently float downward — “Drift”. */
function playDriftStartup(ctx: AudioContext, t: number): void {
  // Quiet undercurrent (the “current” you drift on)
  tone(ctx, { freq: 164.81, start: t, duration: 1.35, type: "sine", gain: 0.028, attack: 0.18 });
  tone(ctx, { freq: 246.94, start: t + 0.05, duration: 1.2, type: "sine", gain: 0.018, attack: 0.22 });

  // Soft rising hello
  tone(ctx, { freq: 392.0, start: t + 0.08, duration: 0.55, type: "triangle", gain: 0.045, attack: 0.06 });
  tone(ctx, { freq: 523.25, start: t + 0.22, duration: 0.62, type: "sine", gain: 0.05, attack: 0.07 });
  tone(ctx, { freq: 659.25, start: t + 0.4, duration: 0.75, type: "triangle", gain: 0.042, attack: 0.08 });

  // Gentle drift down — settle into calm
  tone(ctx, {
    freq: 783.99,
    start: t + 0.58,
    duration: 0.95,
    type: "sine",
    gain: 0.038,
    attack: 0.1,
    slideTo: 587.33,
  });
  tone(ctx, {
    freq: 493.88,
    start: t + 0.72,
    duration: 1.05,
    type: "triangle",
    gain: 0.03,
    attack: 0.12,
    slideTo: 392.0,
  });
}

/** Play a UI sound. Skips if disabled, rapid-fire, or AudioContext unavailable. */
export function playUiSound(id: UiSoundId): void {
  if (!loadUiSoundsEnabled()) return;
  const now = Date.now();
  // Soft debounce so snapshot bursts don't stack (startup is exempt).
  if (id !== "startup" && now - lastPlayAt < 80) return;
  lastPlayAt = now;

  const ctx = ensureCtx();
  if (!ctx) return;
  void ctx.resume();
  const t = ctx.currentTime + 0.01;

  switch (id) {
    case "startup":
      playDriftStartup(ctx, t);
      break;
    case "member-join":
      // Warm two-note “hello”
      tone(ctx, { freq: 523.25, start: t, duration: 0.12, type: "triangle", gain: 0.07 });
      tone(ctx, { freq: 659.25, start: t + 0.1, duration: 0.18, type: "triangle", gain: 0.08 });
      break;
    case "voice-join":
      // Soft rising blip (room enter)
      tone(ctx, { freq: 440, start: t, duration: 0.16, type: "sine", gain: 0.07, slideTo: 660 });
      tone(ctx, { freq: 330, start: t + 0.05, duration: 0.12, type: "triangle", gain: 0.04 });
      break;
    case "chat-text":
      // Short tick
      tone(ctx, { freq: 880, start: t, duration: 0.06, type: "square", gain: 0.035 });
      break;
    case "chat-image":
      // Fuller double pop
      tone(ctx, { freq: 740, start: t, duration: 0.07, type: "triangle", gain: 0.055 });
      tone(ctx, { freq: 980, start: t + 0.08, duration: 0.09, type: "sine", gain: 0.05 });
      break;
    case "mention":
      // Attention chime
      tone(ctx, { freq: 784, start: t, duration: 0.1, type: "triangle", gain: 0.09 });
      tone(ctx, { freq: 1046, start: t + 0.12, duration: 0.14, type: "sine", gain: 0.08 });
      tone(ctx, { freq: 1318, start: t + 0.26, duration: 0.16, type: "triangle", gain: 0.06 });
      break;
    default:
      break;
  }
}

/** Once per page/session load — soft Drift logo sting. */
export function playStartupSound(): void {
  if (startupPlayed) return;
  startupPlayed = true;
  // Slight delay so the window is visible and AudioContext can resume.
  window.setTimeout(() => playUiSound("startup"), 280);
}
