import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { X, Monitor } from 'lucide-react';

export function ScreenShareStage({
  label,
  sharingScreen,
  onStopShare,
  videoRef,
  videoMuted,
}: {
  label: string;
  sharingScreen: boolean;
  onStopShare: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoMuted: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [viewMode, setViewMode] = useState<'docked' | 'pip' | 'fullscreen'>('docked');
  const [pipPos, setPipPos] = useState({ x: 24, y: 96 });

  const enterFullscreen = async () => {
    setViewMode('fullscreen');
    const el = stageRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement !== el && el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch {
      /* CSS overlay fallback */
    }
  };

  const exitFullscreen = async () => {
    setViewMode('docked');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ignore */
    }
  };

  const setDocked = () => {
    void exitFullscreen();
    setViewMode('docked');
  };

  const setPip = () => {
    void (async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        /* ignore */
      }
      setViewMode('pip');
    })();
  };

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && viewMode === 'fullscreen') setViewMode('docked');
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'pip') return;
    const onMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = event.clientX - dragRef.current.startX;
      const dy = event.clientY - dragRef.current.startY;
      setPipPos({
        x: Math.max(8, dragRef.current.originX + dx),
        y: Math.max(8, dragRef.current.originY + dy),
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [viewMode]);

  const onPipHeaderMouseDown = (event: ReactMouseEvent) => {
    if (viewMode !== 'pip') return;
    event.preventDefault();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pipPos.x,
      originY: pipPos.y,
    };
  };

  const isFullscreen = viewMode === 'fullscreen';
  const isPip = viewMode === 'pip';
  const isDocked = viewMode === 'docked';

  const modeButtons = (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className={`ghost-btn !h-8 !px-2 text-[10px] ${isDocked ? 'border-[hsl(var(--primary))]' : ''}`} onClick={setDocked} data-testid="button-screen-share-window-mode">В окне</button>
      <button type="button" className={`ghost-btn !h-8 !px-2 text-[10px] ${isPip ? 'border-[hsl(var(--primary))]' : ''}`} onClick={setPip} data-testid="button-screen-share-pip-mode">Мини</button>
      <button type="button" className={`ghost-btn !h-8 !px-2 text-[10px] ${isFullscreen ? 'border-[hsl(var(--primary))]' : ''}`} onClick={() => void enterFullscreen()} data-testid="button-screen-share-fullscreen-mode">На весь экран</button>
      {sharingScreen && (
        <button type="button" className="ghost-btn !h-8 !px-2 text-[10px]" onClick={onStopShare} data-testid="button-screen-share-stop-inline">Остановить</button>
      )}
      {isFullscreen && (
        <button type="button" className="icon-btn" onClick={() => void setDocked()} aria-label="Закрыть полноэкранный режим" data-testid="button-screen-share-close-fullscreen"><X size={16} /></button>
      )}
    </div>
  );

  const videoEl = (
    <video
      ref={videoRef}
      className={`screen-share-video w-full bg-black object-contain ${isFullscreen ? 'min-h-0 flex-1' : isPip ? 'max-h-[180px]' : 'max-h-[42vh]'}`}
      autoPlay
      playsInline
      muted={videoMuted}
      data-testid="screen-share-video"
    />
  );

  if (isPip) {
    return (
      <div
        className="screen-share-pip"
        style={{ left: pipPos.x, top: pipPos.y }}
        data-testid="screen-share-stage"
      >
        <div className="screen-share-pip-header" onMouseDown={onPipHeaderMouseDown}>
          <span className="flex min-w-0 items-center gap-2 truncate text-xs font-semibold"><Monitor size={14} className="shrink-0 text-[hsl(var(--primary))]" /> {label}</span>
          {modeButtons}
        </div>
        {videoEl}
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      className={
        isFullscreen
          ? 'screen-share-stage fixed inset-0 z-[100] flex flex-col bg-black'
          : 'screen-share-stage mx-4 mt-3 shrink-0 overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--secondary)/.08)]'
      }
      data-testid="screen-share-stage"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-semibold"><Monitor size={14} className="text-[hsl(var(--primary))]" /> {label}</span>
        {modeButtons}
      </div>
      {videoEl}
    </div>
  );
}

