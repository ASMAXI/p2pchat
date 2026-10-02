const MODE_KEY = "p2pchat-voice-mode";
const PTT_KEY = "p2pchat-ptt-key";
const OVERLAY_KEY = "p2pchat-voice-overlay";
const OVERLAY_OPACITY_KEY = "p2pchat-voice-overlay-opacity";
/** JSON payload for overlay window (storage fallback when not using Tauri events). */
export const VOICE_OVERLAY_PAYLOAD_KEY = "p2pchat-voice-overlay-state";

export type VoiceTalkMode = "vad" | "ptt";

/** Browser KeyboardEvent.code values (and a few aliases). */
export type PttKeyCode = string;

export const PTT_KEY_OPTIONS: Array<{ code: PttKeyCode; label: string; vk: number }> = [
  { code: "Space", label: "Пробел", vk: 0x20 },
  { code: "KeyV", label: "V", vk: 0x56 },
  { code: "KeyB", label: "B", vk: 0x42 },
  { code: "KeyT", label: "T", vk: 0x54 },
  { code: "Backquote", label: "` (тильда)", vk: 0xc0 },
  { code: "ControlLeft", label: "Ctrl", vk: 0x11 },
  { code: "AltLeft", label: "Alt", vk: 0x12 },
  { code: "ShiftLeft", label: "Shift", vk: 0x10 },
  { code: "Mouse4", label: "Мышь 4 (боковая)", vk: 0x05 },
  { code: "Mouse5", label: "Мышь 5 (боковая)", vk: 0x06 },
];

export function loadVoiceTalkMode(): VoiceTalkMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "ptt" ? "ptt" : "vad";
  } catch {
    return "vad";
  }
}

export function saveVoiceTalkMode(mode: VoiceTalkMode): void {
  window.localStorage.setItem(MODE_KEY, mode);
}

export function loadPttKeyCode(): PttKeyCode {
  try {
    const raw = window.localStorage.getItem(PTT_KEY);
    if (raw && PTT_KEY_OPTIONS.some((item) => item.code === raw)) return raw;
  } catch {
    // ignore
  }
  return "Space";
}

export function savePttKeyCode(code: PttKeyCode): void {
  window.localStorage.setItem(PTT_KEY, code);
}

export function pttVkForCode(code: PttKeyCode): number {
  return PTT_KEY_OPTIONS.find((item) => item.code === code)?.vk ?? 0x20;
}

export function loadVoiceOverlayEnabled(): boolean {
  try {
    return window.localStorage.getItem(OVERLAY_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveVoiceOverlayEnabled(enabled: boolean): void {
  window.localStorage.setItem(OVERLAY_KEY, enabled ? "1" : "0");
}

/** 0.15 … 1 */
export function loadVoiceOverlayOpacity(): number {
  try {
    const n = Number(window.localStorage.getItem(OVERLAY_OPACITY_KEY));
    if (Number.isFinite(n) && n >= 0.15 && n <= 1) return n;
  } catch {
    // ignore
  }
  return 0.75;
}

export function saveVoiceOverlayOpacity(opacity: number): void {
  const clamped = Math.min(1, Math.max(0.15, opacity));
  window.localStorage.setItem(OVERLAY_OPACITY_KEY, String(clamped));
}

export type VoiceOverlayPeer = {
  id: string;
  name: string;
  speaking: boolean;
  muted?: boolean;
};

export type VoiceOverlayPayload = {
  channelName: string;
  opacity: number;
  peers: VoiceOverlayPeer[];
};
