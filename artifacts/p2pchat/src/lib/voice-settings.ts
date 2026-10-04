const MODE_KEY = "p2pchat-voice-mode";
const PTT_KEY = "p2pchat-ptt-key";
const MUTE_HOTKEY_KEY = "p2pchat-mute-hotkey";
const DEAFEN_HOTKEY_KEY = "p2pchat-deafen-hotkey";
const OVERLAY_KEY = "p2pchat-voice-overlay";
const OVERLAY_OPACITY_KEY = "p2pchat-voice-overlay-opacity";
const OVERLAY_INTERACTIVE_KEY = "p2pchat-voice-overlay-interactive";
/** JSON payload for overlay window (storage fallback when not using Tauri events). */
export const VOICE_OVERLAY_PAYLOAD_KEY = "p2pchat-voice-overlay-state";

export type VoiceTalkMode = "vad" | "ptt";

/** Browser KeyboardEvent.code values (and a few aliases). Empty string = unbound. */
export type PttKeyCode = string;

export const PTT_KEY_OPTIONS: Array<{ code: PttKeyCode; label: string; vk: number }> = [
  { code: "Space", label: "Пробел", vk: 0x20 },
  { code: "KeyV", label: "V", vk: 0x56 },
  { code: "KeyB", label: "B", vk: 0x42 },
  { code: "KeyT", label: "T", vk: 0x54 },
  { code: "KeyM", label: "M", vk: 0x4d },
  { code: "KeyD", label: "D", vk: 0x44 },
  { code: "Backquote", label: "` (тильда)", vk: 0xc0 },
  { code: "ControlLeft", label: "Ctrl", vk: 0x11 },
  { code: "AltLeft", label: "Alt", vk: 0x12 },
  { code: "ShiftLeft", label: "Shift", vk: 0x10 },
  { code: "F1", label: "F1", vk: 0x70 },
  { code: "F2", label: "F2", vk: 0x71 },
  { code: "F3", label: "F3", vk: 0x72 },
  { code: "F4", label: "F4", vk: 0x73 },
  { code: "Mouse4", label: "Мышь 4 (боковая)", vk: 0x05 },
  { code: "Mouse5", label: "Мышь 5 (боковая)", vk: 0x06 },
];

export const HOTKEY_NONE = "";

export const MUTE_DEAFEN_KEY_OPTIONS: Array<{ code: PttKeyCode; label: string; vk: number }> = [
  { code: HOTKEY_NONE, label: "Не назначена", vk: 0 },
  ...PTT_KEY_OPTIONS,
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

export function hotkeyVkForCode(code: PttKeyCode): number {
  if (!code) return 0;
  return MUTE_DEAFEN_KEY_OPTIONS.find((item) => item.code === code)?.vk ?? 0;
}

function loadOptionalHotkey(storageKey: string): PttKeyCode {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return HOTKEY_NONE;
    if (raw === HOTKEY_NONE) return HOTKEY_NONE;
    if (MUTE_DEAFEN_KEY_OPTIONS.some((item) => item.code === raw)) return raw;
  } catch {
    // ignore
  }
  return HOTKEY_NONE;
}

export function loadMuteHotkeyCode(): PttKeyCode {
  return loadOptionalHotkey(MUTE_HOTKEY_KEY);
}

export function saveMuteHotkeyCode(code: PttKeyCode): void {
  window.localStorage.setItem(MUTE_HOTKEY_KEY, code || HOTKEY_NONE);
}

export function loadDeafenHotkeyCode(): PttKeyCode {
  return loadOptionalHotkey(DEAFEN_HOTKEY_KEY);
}

export function saveDeafenHotkeyCode(code: PttKeyCode): void {
  window.localStorage.setItem(DEAFEN_HOTKEY_KEY, code || HOTKEY_NONE);
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

/** When false (default): clicks pass through the overlay to the game/app behind. */
export function loadVoiceOverlayInteractive(): boolean {
  try {
    return window.localStorage.getItem(OVERLAY_INTERACTIVE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveVoiceOverlayInteractive(interactive: boolean): void {
  window.localStorage.setItem(OVERLAY_INTERACTIVE_KEY, interactive ? "1" : "0");
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
  /** Allow drag / hit-test; when false, cursor events are ignored. */
  interactive?: boolean;
  peers: VoiceOverlayPeer[];
};
