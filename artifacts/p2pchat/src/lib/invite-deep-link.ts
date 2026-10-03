import { parseInvite } from "@workspace/p2p-protocol";
import { debugLog } from "@/lib/debug-log";

const PENDING_INVITE_KEY = "p2pchat-pending-invite";
export const PENDING_INVITE_EVENT = "drift:pending-invite";

export function setPendingInvite(invite: string): void {
  try {
    window.sessionStorage.setItem(PENDING_INVITE_KEY, invite);
  } catch {
    /* ignore */
  }
}

export function peekPendingInvite(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

export function takePendingInvite(): string | null {
  const value = peekPendingInvite();
  if (!value) return null;
  try {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    /* ignore */
  }
  return value;
}

export function emitPendingInvite(invite: string): void {
  setPendingInvite(invite);
  window.dispatchEvent(new CustomEvent(PENDING_INVITE_EVENT, { detail: invite }));
}

/** Listen for drift:// / p2pchat:// invite opens from the OS. */
export async function installInviteDeepLinkHandler(
  onInvite: (invite: string) => void,
): Promise<() => void> {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const handleUrls = (urls: string[]) => {
      for (const url of urls) {
        if (!parseInvite(url)) {
          debugLog("invite", "ignored deep link", { url: url.slice(0, 80) }, "warn");
          continue;
        }
        debugLog("invite", "deep link open", { url: url.slice(0, 96) });
        onInvite(url);
      }
    };
    const current = await getCurrent();
    if (current?.length) handleUrls(current);
    return await onOpenUrl(handleUrls);
  } catch (error) {
    debugLog("invite", "deep-link plugin unavailable", error, "warn");
    return () => {};
  }
}

export function normalizeDisplayName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").slice(0, 32);
}

export function isValidDisplayName(value: string): boolean {
  return normalizeDisplayName(value).length >= 2;
}
