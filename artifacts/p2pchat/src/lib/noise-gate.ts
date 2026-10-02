/**
 * Enhanced mic noise reduction via AudioWorklet noise gate + high-pass.
 * Not full RNNoise model weights (would need large WASM assets); this is a
 * stronger DSP chain than browser getUserMedia noiseSuppression alone.
 */

const WORKLET_NAME = "drift-noise-gate";

const WORKLET_SOURCE = `
class DriftNoiseGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseFloor = 0.02;
    this.open = false;
    this.hold = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const inn = input[0];
    const out = output[0];
    let sum = 0;
    for (let i = 0; i < inn.length; i++) sum += inn[i] * inn[i];
    const rms = Math.sqrt(sum / Math.max(1, inn.length));
    this.noiseFloor = this.noiseFloor * 0.995 + Math.min(rms, 0.08) * 0.005;
    const threshold = Math.max(0.012, this.noiseFloor * 2.8);
    if (rms > threshold) {
      this.open = true;
      this.hold = 12;
    } else if (this.hold > 0) {
      this.hold--;
    } else {
      this.open = false;
    }
    const gain = this.open ? 1 : 0.04;
    for (let c = 0; c < output.length; c++) {
      const src = input[c] || inn;
      const dst = output[c];
      for (let i = 0; i < dst.length; i++) dst[i] = src[i] * gain;
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', DriftNoiseGate);
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
