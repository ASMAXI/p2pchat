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

/** Browser KeyboardEvent.code values (and Mouse4/Mouse5). Empty string = unbound. */
export type PttKeyCode = string;

export const HOTKEY_NONE = "";

/** Friendly labels for common codes; anything else is derived from the code. */
const HOTKEY_LABELS: Record<string, string> = {
  Space: "Пробел",
  Enter: "Enter",
  NumpadEnter: "Num Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Tab: "Tab",
  CapsLock: "Caps Lock",
  ShiftLeft: "Shift (L)",
  ShiftRight: "Shift (R)",
  ControlLeft: "Ctrl (L)",
  ControlRight: "Ctrl (R)",
  AltLeft: "Alt (L)",
  AltRight: "Alt (R)",
  MetaLeft: "Win (L)",
  MetaRight: "Win (R)",
  ContextMenu: "Menu",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  IntlBackslash: "\\ (Intl)",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowRight: "→",
  ArrowDown: "↓",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  PrintScreen: "Print Screen",
  ScrollLock: "Scroll Lock",
  Pause: "Pause",
  NumLock: "Num Lock",
  NumpadDivide: "Num /",
  NumpadMultiply: "Num *",
  NumpadSubtract: "Num -",
  NumpadAdd: "Num +",
  NumpadDecimal: "Num .",
  Mouse3: "Мышь 3 (колёсико)",
  Mouse4: "Мышь 4 (боковая)",
  Mouse5: "Мышь 5 (боковая)",
};

/** Explicit Windows VK overrides (when not derivable from letter / digit / F-key codes). */
const CODE_TO_VK: Record<string, number> = {
  Space: 0x20,
  Enter: 0x0d,
  NumpadEnter: 0x0d,
  Escape: 0x1b,
  Backspace: 0x08,
  Tab: 0x09,
  CapsLock: 0x14,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  ContextMenu: 0x5d,
  Backquote: 0xc0,
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
  IntlBackslash: 0xe2,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  PrintScreen: 0x2c,
  ScrollLock: 0x91,
  Pause: 0x13,
  NumLock: 0x90,
  NumpadDivide: 0x6f,
  NumpadMultiply: 0x6a,
  NumpadSubtract: 0x6d,
  NumpadAdd: 0x6b,
  NumpadDecimal: 0x6e,
  Numpad0: 0x60,
  Numpad1: 0x61,
  Numpad2: 0x62,
  Numpad3: 0x63,
  Numpad4: 0x64,
  Numpad5: 0x65,
  Numpad6: 0x66,
  Numpad7: 0x67,
  Numpad8: 0x68,
  Numpad9: 0x69,
  Mouse3: 0x04,
  Mouse4: 0x05,
  Mouse5: 0x06,
};

for (let i = 0; i < 26; i++) {
  CODE_TO_VK[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
  HOTKEY_LABELS[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(65 + i);
}
for (let i = 0; i < 10; i++) {
  CODE_TO_VK[`Digit${i}`] = 0x30 + i;
  HOTKEY_LABELS[`Digit${i}`] = String(i);
}
for (let i = 1; i <= 24; i++) {
  CODE_TO_VK[`F${i}`] = 0x6f + i;
  HOTKEY_LABELS[`F${i}`] = `F${i}`;
}

/** Quick presets still shown as hints in older UI; capture accepts any mappable key. */
export const PTT_KEY_OPTIONS: Array<{ code: PttKeyCode; label: string; vk: number }> = [
  { code: "Space", label: "Пробел", vk: 0x20 },
  { code: "KeyV", label: "V", vk: 0x56 },
  { code: "KeyB", label: "B", vk: 0x42 },
  { code: "KeyT", label: "T", vk: 0x54 },
  { code: "KeyM", label: "M", vk: 0x4d },
  { code: "KeyD", label: "D", vk: 0x44 },
  { code: "Backquote", label: "` (тильда)", vk: 0xc0 },
  { code: "ControlLeft", label: "Ctrl", vk: 0xa2 },
  { code: "AltLeft", label: "Alt", vk: 0xa4 },
  { code: "ShiftLeft", label: "Shift", vk: 0xa0 },
  { code: "F1", label: "F1", vk: 0x70 },
  { code: "F2", label: "F2", vk: 0x71 },
  { code: "F3", label: "F3", vk: 0x72 },
  { code: "F4", label: "F4", vk: 0x73 },
  { code: "Mouse4", label: "Мышь 4 (боковая)", vk: 0x05 },
  { code: "Mouse5", label: "Мышь 5 (боковая)", vk: 0x06 },
];

export const MUTE_DEAFEN_KEY_OPTIONS: Array<{ code: PttKeyCode; label: string; vk: number }> = [
  { code: HOTKEY_NONE, label: "Не назначена", vk: 0 },
  ...PTT_KEY_OPTIONS,
];

export function labelForHotkeyCode(code: PttKeyCode): string {
  if (!code) return "Не назначена";
  if (HOTKEY_LABELS[code]) return HOTKEY_LABELS[code];
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/** Windows virtual-key for GetAsyncKeyState. 0 = unbound / unknown. */
export function vkForHotkeyCode(code: PttKeyCode): number {
  if (!code) return 0;
  if (CODE_TO_VK[code] != null) return CODE_TO_VK[code];
  return 0;
}

export function isHotkeyCodeSupported(code: PttKeyCode): boolean {
  return Boolean(code) && vkForHotkeyCode(code) !== 0;
}

/** Map mouse button index from MouseEvent to our synthetic code. */
export function mouseButtonToHotkeyCode(button: number): PttKeyCode | null {
  if (button === 1) return "Mouse3";
  if (button === 3) return "Mouse4";
  if (button === 4) return "Mouse5";
  return null;
}

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
    if (raw && isHotkeyCodeSupported(raw)) return raw;
  } catch {
    // ignore
  }
  return "Space";
}

export function savePttKeyCode(code: PttKeyCode): void {
  window.localStorage.setItem(PTT_KEY, code);
}

export function pttVkForCode(code: PttKeyCode): number {
  return vkForHotkeyCode(code) || 0x20;
}

export function hotkeyVkForCode(code: PttKeyCode): number {
  return vkForHotkeyCode(code);
}

function loadOptionalHotkey(storageKey: string): PttKeyCode {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null || raw === HOTKEY_NONE) return HOTKEY_NONE;
    if (isHotkeyCodeSupported(raw)) return raw;
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
