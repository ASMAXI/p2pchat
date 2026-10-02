/**
 * Shared joke soundboard — synthesized locally (no asset files / licenses).
 * Played by every peer when a [[drift-sfx]] chat event arrives.
 */

export type FunSoundId =
  | "fart"
  | "cry"
  | "quack"
  | "trombone"
  | "boom"
  | "gachi"
  | "airhorn"
  | "laugh"
  | "crickets"
  | "bruh";

export const FUN_SOUNDS: Array<{ id: FunSoundId; label: string; emoji: string }> = [
  { id: "fart", label: "Пердёж", emoji: "💨" },
  { id: "cry", label: "Плач", emoji: "😭" },
  { id: "quack", label: "Кря", emoji: "🦆" },
  { id: "trombone", label: "Тромбо́н", emoji: "🎺" },
  { id: "boom", label: "Бадабум", emoji: "💥" },
  { id: "gachi", label: "Гачи", emoji: "😈" },
  { id: "airhorn", label: "Хорн", emoji: "📢" },
  { id: "laugh", label: "Смех", emoji: "😂" },
  { id: "crickets", label: "Сверчки", emoji: "🦗" },
  { id: "bruh", label: "Bruh", emoji: "😐" },
];

const FUN_SOUND_SET = new Set(FUN_SOUNDS.map((item) => item.id));

export function isFunSoundId(value: string): value is FunSoundId {
  return FUN_SOUND_SET.has(value as FunSoundId);
}

let sharedCtx: AudioContext | null = null;

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
    gain = 0.12,
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
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), start + duration);
  }
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + Math.max(0.008, attack));
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.04);
}

function noiseBurst(ctx: AudioContext, start: number, duration: number, gain = 0.08): void {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 420;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(start);
  src.stop(start + duration + 0.02);
}

function playFart(ctx: AudioContext, t: number): void {
  tone(ctx, { freq: 120, start: t, duration: 0.18, type: "sawtooth", gain: 0.14, slideTo: 55, attack: 0.01 });
  noiseBurst(ctx, t + 0.05, 0.22, 0.07);
  tone(ctx, { freq: 90, start: t + 0.2, duration: 0.28, type: "triangle", gain: 0.1, slideTo: 40 });
}

function playCry(ctx: AudioContext, t: number): void {
  for (let i = 0; i < 5; i += 1) {
    const at = t + i * 0.22;
    tone(ctx, { freq: 620 + i * 18, start: at, duration: 0.28, type: "sine", gain: 0.07, slideTo: 480, attack: 0.04 });
    tone(ctx, { freq: 310, start: at + 0.05, duration: 0.2, type: "triangle", gain: 0.04, slideTo: 260 });
  }
}

function playQuack(ctx: AudioContext, t: number): void {
  for (let i = 0; i < 3; i += 1) {
    const at = t + i * 0.16;
    tone(ctx, { freq: 480, start: at, duration: 0.12, type: "square", gain: 0.06, slideTo: 220, attack: 0.01 });
    tone(ctx, { freq: 720, start: at + 0.02, duration: 0.1, type: "sawtooth", gain: 0.035, slideTo: 300 });
  }
}

function playTrombone(ctx: AudioContext, t: number): void {
  // Wah-wah-wah-waaah
  const notes = [392, 349, 311, 233];
  notes.forEach((freq, i) => {
    tone(ctx, {
      freq,
      start: t + i * 0.32,
      duration: i === 3 ? 0.85 : 0.3,
      type: "sawtooth",
      gain: 0.09,
      slideTo: freq * 0.92,
      attack: 0.05,
    });
  });
}

function playBoom(ctx: AudioContext, t: number): void {
  tone(ctx, { freq: 90, start: t, duration: 0.55, type: "sine", gain: 0.2, slideTo: 35, attack: 0.01 });
  noiseBurst(ctx, t, 0.35, 0.14);
  tone(ctx, { freq: 180, start: t + 0.08, duration: 0.4, type: "triangle", gain: 0.1, slideTo: 60 });
}

function playGachi(ctx: AudioContext, t: number): void {
  // Cartoon “oh yeah” moan parody — synth only
  tone(ctx, { freq: 220, start: t, duration: 0.35, type: "sawtooth", gain: 0.08, slideTo: 340, attack: 0.08 });
  tone(ctx, { freq: 330, start: t + 0.28, duration: 0.45, type: "sine", gain: 0.1, slideTo: 520, attack: 0.1 });
  tone(ctx, { freq: 440, start: t + 0.65, duration: 0.55, type: "triangle", gain: 0.09, slideTo: 280, attack: 0.12 });
}

function playAirhorn(ctx: AudioContext, t: number): void {
  for (let i = 0; i < 3; i += 1) {
    const at = t + i * 0.22;
    tone(ctx, { freq: 740, start: at, duration: 0.2, type: "sawtooth", gain: 0.11, attack: 0.01 });
    tone(ctx, { freq: 880, start: at, duration: 0.2, type: "square", gain: 0.05 });
  }
}

function playLaugh(ctx: AudioContext, t: number): void {
  const hops = [520, 600, 540, 640, 560, 680, 520];
  hops.forEach((freq, i) => {
    tone(ctx, { freq, start: t + i * 0.09, duration: 0.1, type: "triangle", gain: 0.07, slideTo: freq * 0.85, attack: 0.01 });
  });
}

function playCrickets(ctx: AudioContext, t: number): void {
  for (let i = 0; i < 8; i += 1) {
    const at = t + i * 0.18 + (i % 2) * 0.04;
    tone(ctx, { freq: 4200 + (i % 3) * 180, start: at, duration: 0.05, type: "sine", gain: 0.035, attack: 0.005 });
  }
}

function playBruh(ctx: AudioContext, t: number): void {
  tone(ctx, { freq: 140, start: t, duration: 0.7, type: "sine", gain: 0.18, slideTo: 55, attack: 0.01 });
  tone(ctx, { freq: 90, start: t + 0.05, duration: 0.65, type: "triangle", gain: 0.1, slideTo: 40 });
  noiseBurst(ctx, t, 0.25, 0.06);
}

export function playFunSound(id: FunSoundId): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  void ctx.resume();
  const t = ctx.currentTime + 0.01;
  switch (id) {
    case "fart":
      playFart(ctx, t);
      break;
    case "cry":
      playCry(ctx, t);
      break;
    case "quack":
      playQuack(ctx, t);
      break;
    case "trombone":
      playTrombone(ctx, t);
      break;
    case "boom":
      playBoom(ctx, t);
      break;
    case "gachi":
      playGachi(ctx, t);
      break;
    case "airhorn":
      playAirhorn(ctx, t);
      break;
    case "laugh":
      playLaugh(ctx, t);
      break;
    case "crickets":
      playCrickets(ctx, t);
      break;
    case "bruh":
      playBruh(ctx, t);
      break;
    default:
      break;
  }
}

export function funSoundLabel(id: FunSoundId): string {
  return FUN_SOUNDS.find((item) => item.id === id)?.label ?? id;
}
