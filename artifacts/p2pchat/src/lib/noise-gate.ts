/**
 * Optional mic cleanup: soft expander (not a hard gate).
 * Hard on/off gates sounded robotic over WebRTC — use smooth gain instead.
 */

const WORKLET_NAME = "drift-noise-soft";

const WORKLET_SOURCE = `
class DriftNoiseSoft extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseFloor = 0.008;
    this.gain = 1;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const inn = input[0];
    let sum = 0;
    for (let i = 0; i < inn.length; i++) sum += inn[i] * inn[i];
    const rms = Math.sqrt(sum / Math.max(1, inn.length));
    // Slow floor estimate (ignore loud speech spikes)
    if (rms < 0.05) {
      this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
    }
    const floor = Math.max(0.004, this.noiseFloor);
    // Soft knee: full gain above ~4x floor, gentle attenuate toward floor
    const target = rms <= floor * 1.2
      ? 0.55
      : rms >= floor * 4
        ? 1
        : 0.55 + 0.45 * ((rms - floor * 1.2) / (floor * 2.8));
    // Smooth to avoid choppy / robotic artifacts
    this.gain = this.gain * 0.85 + target * 0.15;
    for (let c = 0; c < output.length; c++) {
      const src = input[c] || inn;
      const dst = output[c];
      for (let i = 0; i < dst.length; i++) dst[i] = src[i] * this.gain;
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', DriftNoiseSoft);
`;

let workletReady: Promise<void> | null = null;

export async function ensureNoiseWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    if (!workletReady) {
      const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      workletReady = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    await workletReady;
    return true;
  } catch {
    workletReady = null;
    return false;
  }
}

export function createNoiseGateNode(ctx: AudioContext): AudioWorkletNode | null {
  try {
    return new AudioWorkletNode(ctx, WORKLET_NAME);
  } catch {
    return null;
  }
}
