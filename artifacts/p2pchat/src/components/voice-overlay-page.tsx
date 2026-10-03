import { useEffect, useRef, useState } from "react";
import {
  type VoiceOverlayPayload,
  VOICE_OVERLAY_PAYLOAD_KEY,
  loadVoiceOverlayInteractive,
  loadVoiceOverlayOpacity,
} from "@/lib/voice-settings";
import { isDesktopShell } from "@/lib/p2p-client";

const emptyPayload: VoiceOverlayPayload = {
  channelName: "",
  opacity: loadVoiceOverlayOpacity(),
  interactive: loadVoiceOverlayInteractive(),
  peers: [],
};

function parsePayload(raw: string | null): VoiceOverlayPayload | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as VoiceOverlayPayload;
    if (!data || typeof data.channelName !== "string" || !Array.isArray(data.peers)) {
      return null;
    }
    const opacity =
      typeof data.opacity === "number" && data.opacity >= 0.15 && data.opacity <= 1
        ? data.opacity
        : loadVoiceOverlayOpacity();
    const interactive =
      typeof data.interactive === "boolean" ? data.interactive : loadVoiceOverlayInteractive();
    const seen = new Set<string>();
    const peers = data.peers.filter((peer) => {
      const key = `${peer.id}|${peer.name}`;
      if (seen.has(key) || seen.has(peer.name)) return false;
      seen.add(key);
      seen.add(peer.name);
      return true;
    });
    return { ...data, opacity, interactive, peers };
  } catch {
    return null;
  }
}

function readPayload(): VoiceOverlayPayload {
  return (
    parsePayload(window.localStorage.getItem(VOICE_OVERLAY_PAYLOAD_KEY)) ?? {
      ...emptyPayload,
      opacity: loadVoiceOverlayOpacity(),
      interactive: loadVoiceOverlayInteractive(),
    }
  );
}

async function applyClickThrough(interactive: boolean): Promise<void> {
  if (!isDesktopShell()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // ignore=true → clicks pass through to whatever is behind
    await getCurrentWindow().setIgnoreCursorEvents(!interactive);
  } catch {
    // ignore
  }
}

export function VoiceOverlayPage() {
  const [payload, setPayload] = useState<VoiceOverlayPayload>(readPayload);
  const panelRef = useRef<HTMLDivElement>(null);
  const interactive = Boolean(payload.interactive);

  useEffect(() => {
    document.documentElement.classList.add("voice-overlay-mode");
    document.body.classList.add("voice-overlay-mode");
    return () => {
      document.documentElement.classList.remove("voice-overlay-mode");
      document.body.classList.remove("voice-overlay-mode");
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const apply = (next: VoiceOverlayPayload | null) => {
      if (next) setPayload(next);
    };

    apply(readPayload());

    if (isDesktopShell()) {
      void import("@tauri-apps/api/event").then(({ listen }) => {
        void listen<VoiceOverlayPayload>("voice-overlay-state", (event) => {
          apply(parsePayload(JSON.stringify(event.payload)));
        }).then((fn) => {
          unlisten = fn;
        });
      });
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void invoke("focus_voice_overlay").catch(() => {});
      });
    }

    const refresh = () => apply(readPayload());
    const onStorage = (event: StorageEvent) => {
      if (event.key === VOICE_OVERLAY_PAYLOAD_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(refresh, 800);

    return () => {
      unlisten?.();
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void applyClickThrough(interactive);
  }, [interactive]);

  // Shrink the native window to the panel so there is no empty frame around it.
  useEffect(() => {
    if (!isDesktopShell()) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    if (width < 40 || height < 20) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow, LogicalSize }) => {
      void getCurrentWindow().setSize(new LogicalSize(width, height)).catch(() => {});
    });
  }, [payload]);

  const bgAlpha = Math.min(1, Math.max(0.15, payload.opacity));

  return (
    <div className="voice-overlay-root">
      <div
        ref={panelRef}
        className={`voice-overlay-panel${interactive ? " is-interactive" : " is-clickthrough"}`}
        style={{ background: `rgba(12, 14, 18, ${bgAlpha})` }}
      >
        <div className="voice-overlay-channel">{payload.channelName || "Голосовой канал"}</div>
        {payload.peers.length === 0 ? (
          <div className="voice-overlay-empty">Никого в канале</div>
        ) : (
          <ul className="voice-overlay-peers">
            {payload.peers.map((peer) => (
              <li
                key={peer.id}
                className={`voice-overlay-peer${peer.speaking ? " speaking" : ""}${peer.muted ? " muted" : ""}`}
              >
                <span className={`voice-overlay-dot${peer.speaking ? " on" : ""}`} aria-hidden />
                <span className="voice-overlay-peer-name">{peer.name}</span>
                {peer.muted && <span className="voice-overlay-peer-badge">🔇</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
