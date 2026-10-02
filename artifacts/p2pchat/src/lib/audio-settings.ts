const INPUT_KEY = "p2pchat-audio-input";
const OUTPUT_KEY = "p2pchat-audio-output";

export function loadAudioInputId(): string {
  return window.localStorage.getItem(INPUT_KEY)?.trim() ?? "";
}

export function loadAudioOutputId(): string {
  return window.localStorage.getItem(OUTPUT_KEY)?.trim() ?? "";
}

export function saveAudioInputId(deviceId: string): void {
  if (deviceId) window.localStorage.setItem(INPUT_KEY, deviceId);
  else window.localStorage.removeItem(INPUT_KEY);
}

export function saveAudioOutputId(deviceId: string): void {
  if (deviceId) window.localStorage.setItem(OUTPUT_KEY, deviceId);
  else window.localStorage.removeItem(OUTPUT_KEY);
}

export async function listAudioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
  } catch {
    // labels may stay empty without permission
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === "audioinput"),
    outputs: devices.filter((d) => d.kind === "audiooutput"),
  };
}
