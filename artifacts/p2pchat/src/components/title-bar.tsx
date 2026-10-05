import { useCallback, useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { BrandName } from "@/components/app-brand";
import { isDesktopShell } from "@/lib/p2p-client";

async function getMainWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const desktop = isDesktopShell();

  const refreshMaximized = useCallback(async () => {
    if (!desktop) return;
    try {
      const win = await getMainWindow();
      setMaximized(await win.isMaximized());
    } catch {
      // ignore
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    void refreshMaximized();
    let unlisten: (() => void) | undefined;
    void getMainWindow().then((win) =>
      win.onResized(() => {
        void refreshMaximized();
      }).then((stop) => {
        unlisten = stop;
      }),
    );
    return () => {
      unlisten?.();
    };
  }, [desktop, refreshMaximized]);

  if (!desktop) return null;

  return (
    <header className="app-titlebar" data-testid="app-titlebar">
      <div
        className="app-titlebar-drag"
        data-tauri-drag-region
        onDoubleClick={() => {
          void getMainWindow().then((win) => win.toggleMaximize());
        }}
      >
        <BrandName className="pointer-events-none text-[13px]" />
        <span className="pointer-events-none font-mono text-[9px] uppercase tracking-[.16em] text-[hsl(var(--muted-foreground))]">
          desktop
        </span>
      </div>
      <div className="app-titlebar-controls">
        <button
          type="button"
          className="app-titlebar-btn"
          aria-label="Свернуть"
          data-testid="button-window-minimize"
          onClick={() => {
            void getMainWindow().then((win) => win.minimize());
          }}
        >
          <Minus size={14} strokeWidth={2.25} />
        </button>
        <button
          type="button"
          className="app-titlebar-btn"
          aria-label={maximized ? "Восстановить" : "Развернуть"}
          data-testid="button-window-maximize"
          onClick={() => {
            void getMainWindow().then((win) => win.toggleMaximize());
          }}
        >
          {maximized ? <Copy size={12} strokeWidth={2.25} /> : <Square size={12} strokeWidth={2.25} />}
        </button>
        <button
          type="button"
          className="app-titlebar-btn app-titlebar-btn-close"
          aria-label="Свернуть в трей"
          title="Крестик сворачивает в трей"
          data-testid="button-window-close"
          onClick={() => {
            // CloseRequested on main window hides to tray (see lib.rs).
            void getMainWindow().then((win) => win.close());
          }}
        >
          <X size={14} strokeWidth={2.25} />
        </button>
      </div>
    </header>
  );
}
