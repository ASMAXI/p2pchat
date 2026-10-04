import { useEffect, useState } from 'react';
import { Check, Signal, X } from 'lucide-react';
import { currentAppVersion, getPublicUrl, isTurnConfigured, statusLabel } from '@/lib/p2p-client';
import type { SessionStatus } from '@workspace/p2p-room';
import { useAppTheme } from '@/lib/theme';
import { rfRankFor } from '@/lib/patriot-ranks';
import { inviteLooksLocal } from '@/lib/app-shared';

export function LogoMark({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? 'server-mark' : 'flex items-center gap-3'}>
      <div className="server-mark" style={small ? undefined : { width: 38, height: 38, borderRadius: 11 }}>
        <Signal size={20} strokeWidth={2.5} />
      </div>
      {!small && <BrandName className="text-[20px]" />}
    </div>
  );
}

export function BrandName({ className = '' }: { className?: string }) {
  return <span className={`font-display font-bold tracking-[-.05em] ${className}`}>Dri<span style={{ color: 'hsl(var(--accent))' }}>ft</span></span>;
}

export function CreatorCredit({ className = '' }: { className?: string }) {
  return <span className={`font-mono text-[10px] uppercase tracking-[.14em] ${className}`} data-testid="text-creator">Drift · создатель ASMAXI</span>;
}

export function AppVersionLabel({ className = '' }: { className?: string }) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void currentAppVersion().then(setVersion);
  }, []);
  if (!version) return null;
  return (
    <span className={`font-mono text-[10px] tracking-[.12em] text-[hsl(var(--muted-foreground))] ${className}`} data-testid="text-app-version">
      v{version}
    </span>
  );
}

export function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 3300);
    return () => window.clearTimeout(timer);
  }, [onClose]);
  return <div className="toast" data-testid="status-toast"><Check size={16} color="hsl(var(--primary))" /><span>{text}</span><button className="icon-btn ml-auto" onClick={onClose} aria-label="Закрыть уведомление" data-testid="button-close-toast"><X size={15} /></button></div>;
}


export function ConnectionStatusChips({
  connectionStatus,
  isCoordinator,
  invite,
}: {
  connectionStatus: SessionStatus;
  isCoordinator: boolean;
  invite?: string;
}) {
  if (connectionStatus !== 'connected') {
    const offline = connectionStatus === 'offline';
    const dotColor = offline ? 'hsl(var(--muted-foreground))' : 'hsl(var(--accent))';
    return (
      <span className="connection-chip text-[hsl(var(--muted-foreground))]" data-testid="chip-connection-status">
        <span className="connection-dot" style={{ background: dotColor }} />
        {statusLabel(connectionStatus)}
      </span>
    );
  }
  const lanLocal = inviteLooksLocal(invite);
  const publicUrl = getPublicUrl();
  const turnOk = isTurnConfigured();
  const chips: Array<{ key: string; label: string; dot: string; muted?: boolean }> = [
    {
      key: 'lan',
      label: lanLocal ? 'LAN' : 'LAN?',
      dot: lanLocal ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
      muted: !lanLocal,
    },
    isCoordinator
      ? {
          key: 'tunnel',
          label: publicUrl ? 'Туннель' : 'нет туннеля',
          dot: publicUrl ? 'hsl(var(--primary))' : 'hsl(var(--accent))',
          muted: !publicUrl,
        }
      : {
          key: 'tunnel',
          label: lanLocal ? 'локально' : 'удалённый',
          dot: lanLocal ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
          muted: !lanLocal,
        },
    {
      key: 'turn',
      label: turnOk ? 'TURN' : 'TURN?',
      dot: turnOk ? 'hsl(var(--primary))' : 'hsl(var(--accent))',
      muted: !turnOk,
    },
  ];
  return (
    <div className="hidden items-center gap-1.5 sm:flex" data-testid="connection-chips">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`connection-chip ${chip.muted ? 'text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--foreground))]'}`}
          data-testid={`chip-connection-${chip.key}`}
        >
          <span className="connection-dot" style={{ background: chip.dot }} />
          {chip.label}
        </span>
      ))}
    </div>
  );
}


export function PatriotName({ name, seed }: { name: string; seed?: string }) {
  const theme = useAppTheme();
  if (theme !== 'patriot') return <>{name}</>;
  const rank = rfRankFor(seed || name);
  return (
    <>
      <span className="patriot-rank">{rank}</span>{' '}
      {name}
    </>
  );
}

