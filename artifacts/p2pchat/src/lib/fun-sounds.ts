/**
 * Shared joke soundboard — real MP3 samples in /sfx (see public/sfx/CREDITS.txt).
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
  | "whistle";

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
];

const FUN_SOUND_SET = new Set(FUN_SOUNDS.map((item) => item.id));

export function isFunSoundId(value: string): value is FunSoundId {
  return FUN_SOUND_SET.has(value as FunSoundId);
}

export function funSoundLabel(id: FunSoundId): string {
  return FUN_SOUNDS.find((item) => item.id === id)?.label ?? id;
}

function sfxUrl(id: FunSoundId): string {
  return new URL(`/sfx/${id}.mp3`, window.location.origin).href;
}

let lastAudio: HTMLAudioElement | null = null;

/** Play a soundboard clip for everyone who receives the chat sfx event. */
export function playFunSound(id: FunSoundId): void {
  try {
    if (lastAudio) {
      lastAudio.pause();
      lastAudio.src = "";
      lastAudio = null;
    }
    const audio = new Audio(sfxUrl(id));
    audio.volume = 0.9;
    lastAudio = audio;
    void audio.play().catch(() => {
      // Autoplay may be blocked until a user gesture; ignore.
    });
  } catch {
    // ignore
  }
}
