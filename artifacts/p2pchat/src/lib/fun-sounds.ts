/**
 * Shared joke soundboard — real MP3 samples in /sfx (see public/sfx/CREDITS.txt).
 * Played by every peer when a [[drift-sfx]] chat event arrives.
 */

import { loadFunSoundsEnabled } from "@/lib/notify-settings";

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
  | "bruh"
  | "vineboom"
  | "error"
  | "applause"
  | "boo"
  | "scratch"
  | "buzzer"
  | "tada"
  | "pipe"
  | "sneeze"
  | "whistle"
  | "boing"
  | "wow"
  | "agentAlarm";

/** Classic alarm — separate button in chat, not in the soundboard grid. */
export const AGENT_ALARM_SOUND: FunSoundId = "agentAlarm";

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
  { id: "vineboom", label: "Vine Boom", emoji: "💣" },
  { id: "error", label: "Error", emoji: "💻" },
  { id: "applause", label: "Браво", emoji: "👏" },
  { id: "boo", label: "Буу", emoji: "👎" },
  { id: "scratch", label: "Scratch", emoji: "🎧" },
  { id: "buzzer", label: "Баззер", emoji: "🚨" },
  { id: "tada", label: "Tada", emoji: "🎉" },
  { id: "pipe", label: "Труба", emoji: "🔩" },
  { id: "sneeze", label: "Апчхи", emoji: "🤧" },
  { id: "whistle", label: "Свисток", emoji: "🫠" },
  { id: "boing", label: "Boing", emoji: "🪀" },
  { id: "wow", label: "Wow", emoji: "😮" },
];

const FUN_SOUND_SET = new Set<FunSoundId>([...FUN_SOUNDS.map((item) => item.id), AGENT_ALARM_SOUND]);

export function isFunSoundId(value: string): value is FunSoundId {
  return FUN_SOUND_SET.has(value as FunSoundId);
}

export function funSoundLabel(id: FunSoundId): string {
  if (id === AGENT_ALARM_SOUND) return "Будильник";
  return FUN_SOUNDS.find((item) => item.id === id)?.label ?? id;
}

export function funSoundEmoji(id: FunSoundId): string {
  if (id === AGENT_ALARM_SOUND) return "⏰";
  return FUN_SOUNDS.find((item) => item.id === id)?.emoji ?? "🔊";
}

function sfxFileBase(id: FunSoundId): string {
  if (id === AGENT_ALARM_SOUND) return "agent-alarm";
  return id;
}

function sfxUrl(id: FunSoundId): string {
  return new URL(`/sfx/${sfxFileBase(id)}.mp3`, window.location.origin).href;
}

let lastAudio: HTMLAudioElement | null = null;

/** Play a soundboard clip for everyone who receives the chat sfx event. */
export function playFunSound(id: FunSoundId): void {
  if (!loadFunSoundsEnabled()) return;
  try {
    if (lastAudio) {
      lastAudio.pause();
      lastAudio.src = "";
      lastAudio = null;
    }
    const audio = new Audio(sfxUrl(id));
    audio.volume = id === AGENT_ALARM_SOUND ? 0.55 : 0.45;
    lastAudio = audio;
    if (id === AGENT_ALARM_SOUND) {
      const stopAt = window.setTimeout(() => {
        audio.pause();
      }, 2250);
      audio.addEventListener(
        "ended",
        () => {
          window.clearTimeout(stopAt);
        },
        { once: true },
      );
    }
    void audio.play().catch(() => {
      // Autoplay may be blocked until a user gesture; ignore.
    });
  } catch {
    // ignore
  }
}
