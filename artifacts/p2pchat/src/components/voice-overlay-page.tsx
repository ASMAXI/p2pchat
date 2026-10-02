import { useEffect, useState } from "react";
import {
  type VoiceOverlayPayload,
  VOICE_OVERLAY_PAYLOAD_KEY,
} from "@/lib/voice-settings";
import { isDesktopShell } from "@/lib/p2p-client";

const emptyPayload: VoiceOverlayPayload = {
  channelName: "",
  opacity: 0.75,
  peers: [],
};

function parsePayload(raw: string | null): VoiceOverlayPayload | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as VoiceOverlayPayload;
    if (!data || typeof data.channelName !== "string" || !Array.isArray(data.peers)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function VoiceOverlayPage() {
  const [payload, setPayload] = useState<VoiceOverlayPayload>(emptyPayload);

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

    if (isDesktopShell()) {
      void import("@tauri-apps/api/event").then(({ listen }) => {
        void listen<VoiceOverlayPayload>("voice-overlay-state", (event) => {
          apply(event.payload);
        }).then((fn) => {
          unlisten = fn;
        });
      });
    }

    const fromStorage = () => {
      apply(parsePayload(window.localStorage.getItem(VOICE_OVERLAY_PAYLOAD_KEY)));
    };
    fromStorage();

    const onStorage = (event: StorageEvent) => {
      if (event.key === VOICE_OVERLAY_PAYLOAD_KEY || event.key === "p2pchat-voice-overlay-state") {
        apply(parsePayload(event.newValue ?? window.localStorage.getItem(VOICE_OVERLAY_PAYLOAD_KEY)));
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      unlisten?.();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const bgAlpha = payload.opacity;

  return (
    <div className="voice-overlay-root">
      <div
        className="voice-overlay-panel"
        style={{ background: `rgba(10, 12, 16, ${bgAlpha})` }}
      >
        <div className="voice-overlay-channel">{payload.channelName || "Голос"}</div>
        <ul className="voice-overlay-peers">
          {payload.peers.map((peer) => (
            <li
              key={peer.id}
              className={`voice-overlay-peer${peer.speaking ? " speaking" : ""}${peer.muted ? " muted" : ""}`}
            >
              <span className="voice-overlay-peer-name">{peer.name}</span>
              {peer.muted && <span className="voice-overlay-peer-badge">🔇</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
