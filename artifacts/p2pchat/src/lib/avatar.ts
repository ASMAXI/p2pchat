/** Deterministic colorful avatar from a name/id. */
export function avatarHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export function avatarColors(seed: string): { background: string; color: string } {
  const hue = avatarHue(seed || "?");
  return {
    background: `hsl(${hue} 62% 46%)`,
    color: "hsl(0 0% 100%)",
  };
}

export function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

/** Prefix for image payloads in encrypted chat plaintext. */
export const IMAGE_MESSAGE_PREFIX = "[[drift-img:]]";

export function isImageMessage(text: string | null | undefined): boolean {
  return Boolean(text?.startsWith(IMAGE_MESSAGE_PREFIX));
}

export function imagePayload(text: string): string {
  return text.slice(IMAGE_MESSAGE_PREFIX.length);
}

/** Compress/resize a File to a JPEG data-URL under ~180KB for chat. */
export async function fileToChatImageDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas недоступен");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > 180_000 && quality > 0.4) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > 240_000) throw new Error("Картинка слишком большая — выберите файл поменьше");
  return dataUrl;
}
