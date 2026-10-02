import { useEffect, useState } from "react";
import {
  type VoiceOverlayPayload,
  VOICE_OVERLAY_PAYLOAD_KEY,
  loadVoiceOverlayOpacity,
} from "@/lib/voice-settings";
import { isDesktopShell } from "@/lib/p2p-client";

const emptyPayload: VoiceOverlayPayload = {
  channelName: "",
  opacity: loadVoiceOverlayOpacity(),
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
    return { ...data, opacity };
  } catch {
    return null;
  }
}

function readPayload(): VoiceOverlayPayload {
  return parsePayload(window.localStorage.getItem(VOICE_OVERLAY_PAYLOAD_KEY)) ?? {
    ...emptyPayload,
    opacity: loadVoiceOverlayOpacity(),
  };
}

export function VoiceOverlayPage() {
  const [payload, setPayload] = useState<VoiceOverlayPayload>(readPayload);

  useEffect(() => {
    document.documentElement.classList.add("voice-overlay-mode");
    document.body.classList.add("voice-overlay-mode");
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
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
          apply(event.payload);
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
    window.addEventListener("p2pchat-voice-settings", refresh);
    window.addEventListener("p2pchat-voice-overlay-push", refresh);

    const timer = window.setInterval(refresh, 800);

    return () => {
      unlisten?.();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("p2pchat-voice-settings", refresh);
      window.removeEventListener("p2pchat-voice-overlay-push", refresh);
      window.clearInterval(timer);
    };
  }, []);

  const bgAlpha = Math.min(1, Math.max(0.15, payload.opacity));

  return (
    <div className="voice-overlay-root">
      <div className="voice-overlay-panel" style={{ background: `rgba(12, 14, 18, ${bgAlpha})` }}>
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
