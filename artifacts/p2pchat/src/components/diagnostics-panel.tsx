import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Activity, ArrowRight, Check, ChevronDown, Clipboard, Download, Info, LockKeyhole, Network, RefreshCw, ShieldCheck, Signal, Trash2, Wifi, Zap } from 'lucide-react';
import { getPublicUrl, isCustomTurnConfigured, isTurnConfigured, getActiveVoiceMesh } from '@/lib/p2p-client';
import { getLastVoiceNatReport, iceConfigFlags } from '@/lib/voice-diagnostics';
import type { SessionStatus } from '@workspace/p2p-room';
import { clearDebugLogs, copyDebugReport, debugLog, downloadDebugReport, getDebugLogs, subscribeDebugLogs } from '@/lib/debug-log';
import { type Server, SERVER_KEY, CONNECTION_KEY, readStore, seedServer } from '@/lib/app-shared';
import { BrandName } from '@/components/app-brand';

export function Diagnostics({ onClose }: { onClose?: () => void }) {
  const [, setLocation] = useLocation();
  const server = readStore<Server>(SERVER_KEY, seedServer);
  const goBack = () => (onClose ? onClose() : setLocation(server.roomId ? '/server' : '/'));
  const [revealed, setRevealed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState('только что');
  const [logTick, setLogTick] = useState(0);
  const [logAction, setLogAction] = useState('');
  const [natBusy, setNatBusy] = useState(false);
  const [natSummary, setNatSummary] = useState(() => getLastVoiceNatReport()?.summary ?? '');
  const connectionStatus = readStore<SessionStatus>(CONNECTION_KEY, 'offline');
  const connectionLabel = connectionStatus === 'connected' ? 'Стабильно' : connectionStatus === 'reconnecting' ? 'Переподключение' : connectionStatus === 'connecting' ? 'Подключение' : 'Офлайн';
  const turnOk = isTurnConfigured();
  const customTurn = isCustomTurnConfigured();
  const iceFlags = iceConfigFlags();
  const publicUrl = getPublicUrl();
  const logs = getDebugLogs();
  const iceLabel = customTurn
    ? 'Свой TURN'
    : iceFlags.meteredConfigured
      ? 'Metered'
      : iceFlags.iceSource === 'static-openrelay'
        ? 'OpenRelay?'
        : iceFlags.iceSource;
  const diagnostics = [
    ['Control plane / Signaling', connectionStatus === 'connected' ? 'OK' : connectionLabel, 'Текст и WebRTC signaling через peer-узел. Публичный доступ — туннель (чат ≠ голос).'],
    ['ICE / TURN', iceLabel, customTurn ? 'Кастомный relay из настроек.' : iceFlags.meteredConfigured ? `Metered (${iceFlags.meteredAppName || 'app'}), source=${iceFlags.iceSource}.` : 'Metered/свой TURN не заданы (опционально). В разных NAT голос может молчать — ключ в Настройки → Расширенные.'],
    ['Публичный URL', publicUrl ? 'Авто/задан' : 'Нет', publicUrl ? publicUrl : 'Туннель не поднялся — повторите в настройках.'],
    ['Переезд координатора', 'Защищён', 'При уходе хоста преемник — peer с публичным туннелем (иначе по peerId); сначала его public URL.'],
  ];
  useEffect(() => subscribeDebugLogs(() => setLogTick((n) => n + 1)), []);
  const check = () => { setChecking(true); window.setTimeout(() => { setChecking(false); setLastChecked('только что'); }, 1000); };
  const reportExtra = () => ({
    serverRole: server.role,
    hostName: server.hostName,
    roomId: server.roomId,
    connectionStatus,
    logCount: logs.length,
    iceFlags: iceConfigFlags(),
    voiceNat: getLastVoiceNatReport(),
  });
  const copyLogs = async () => {
    const ok = await copyDebugReport({ ...reportExtra(), logTick });
    setLogAction(ok ? 'Лог скопирован в буфер — отправьте в чат/мне' : 'Не удалось скопировать — скачайте файл');
    debugLog('diagnostics', ok ? 'report copied' : 'copy failed');
  };
  const downloadLogs = () => {
    downloadDebugReport(reportExtra());
    setLogAction('Файл p2pchat-debug-….txt скачан — перешлите его');
    debugLog('diagnostics', 'report downloaded');
  };
  const snapshotNat = async () => {
    setNatBusy(true);
    try {
      const mesh = getActiveVoiceMesh();
      if (mesh) {
        const report = await mesh.collectNatReport();
        setNatSummary(report.summary);
        setLogAction(
          report.peers.length
            ? `NAT-снимок: ${report.summary}. Теперь «Скачать .txt» и пришлите.`
            : 'Вы в голосе, но пиров нет — зайдите в канал с другом и повторите.',
        );
      } else {
        const last = getLastVoiceNatReport();
        setNatSummary(last?.summary ?? '');
        setLogAction(
          last
            ? `Нет активного голоса. Последний снимок: ${last.summary}. Скачайте .txt.`
            : 'Сначала зайдите в голосовой канал (лучше когда «не слышно»), затем снова «Снимок NAT».',
        );
        debugLog('voice-nat', 'no active mesh', { hadLast: Boolean(last), iceFlags: iceConfigFlags() });
      }
    } finally {
      setNatBusy(false);
    }
  };
  return <div className="noise h-full min-h-0 overflow-auto app-grid" style={{ background: 'hsl(var(--background))' }}>
    <header className="flex h-[76px] items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card)/.72)] px-5 backdrop-blur-md sm:px-10"><Link href="/server" className="flex items-center gap-3" data-testid="link-diagnostics-back" onClick={(event) => { if (onClose) { event.preventDefault(); onClose(); } }}><div className="server-mark" style={{ width: 35, height: 35, borderRadius: 10 }}><Signal size={17} /></div><BrandName className="text-lg" /></Link><button className="ghost-btn" onClick={goBack} data-testid="button-back-to-server"><ArrowRight size={15} className="rotate-180" /> Вернуться в комнату</button></header>
    <main className="mx-auto max-w-[900px] px-5 py-12 sm:px-10 sm:py-16">
       <div className="max-w-[650px] animate-rise"><div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[hsl(var(--primary)/.15)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.15em] text-[hsl(var(--secondary))]"><ShieldCheck size={13} /> Состояние комнаты</div><h1 className="font-display text-5xl font-bold tracking-[-.08em] sm:text-7xl">Связь,<br /><span style={{ color: 'hsl(var(--accent))' }}>которая держится.</span></h1><p className="mt-6 max-w-[570px] text-[15px] leading-7 text-[hsl(var(--muted-foreground))]">Control plane (чат + signaling) и медиа (WebRTC + TURN) — разные пути. Здесь видно оба слоя.</p></div>
      <section className="mt-12 grid gap-3 sm:grid-cols-3">
         <div className="metric-card animate-rise stagger-1"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Signaling</span><Wifi size={16} className="text-[hsl(var(--primary))]" /></div><div className="mt-4 font-display text-2xl font-bold">{connectionLabel}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">WebSocket control plane</div></div>
        <div className="metric-card animate-rise stagger-2"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">TURN</span><Zap size={16} className="text-[hsl(var(--accent))]" /></div><div className="mt-4 font-display text-2xl font-bold">{turnOk ? 'Да' : 'Опц.'}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{turnOk ? 'Metered/свой TURN' : 'не задан (по желанию)'}</div></div>
         <div className="metric-card animate-rise stagger-3"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Роль узла</span><Network size={16} className="text-[hsl(var(--secondary))]" /></div><div className="mt-4 font-display text-2xl font-bold">{server.role ?? 'Участник'}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">координатор: {server.hostName}</div></div>
      </section>
      <section className="mt-3 overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] animate-rise stagger-3">
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-5 py-5 sm:px-7"><div><h2 className="font-display text-xl font-bold tracking-[-.04em]">Состояние комнаты</h2><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Последняя проверка: {lastChecked}</p></div><button className="ghost-btn" onClick={check} disabled={checking} data-testid="button-refresh-diagnostics"><RefreshCw size={15} className={checking ? 'animate-spin' : ''} /> {checking ? 'Проверяем' : 'Проверить снова'}</button></div>
        <div className="divide-y divide-[hsl(var(--border))] px-5 sm:px-7">
           {diagnostics.map(([title, state, description], index) => <div className="flex items-center gap-4 py-5" key={title} data-testid={`diagnostic-row-${index}`}><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[hsl(var(--primary)/.14)] text-[hsl(var(--secondary))]"><Check size={17} /></div><div className="min-w-0 flex-1"><div className="text-sm font-bold">{title}</div><div className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">{description}</div></div><span className="hidden rounded-full bg-[hsl(var(--primary)/.18)] px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-[hsl(var(--secondary))] sm:block">{state}</span></div>)}
        </div>
        <button className="flex w-full items-center gap-2 border-t border-[hsl(var(--border))] px-5 py-4 text-left text-xs font-bold text-[hsl(var(--muted-foreground))] transition hover:bg-[hsl(var(--muted)/.55)] hover:text-[hsl(var(--foreground))] sm:px-7" onClick={() => setRevealed((value) => !value)} data-testid="button-reveal-diagnostics"><Info size={15} /> {revealed ? 'Скрыть технические детали' : 'Показать технические детали'}<ChevronDown size={15} className={`ml-auto transition ${revealed ? 'rotate-180' : ''}`} /></button>
         {revealed && <div className="grid gap-3 border-t border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] px-5 py-5 font-mono text-[10px] text-[hsl(var(--muted-foreground))] sm:grid-cols-2 sm:px-7 animate-rise"><div>transport <span className="float-right text-[hsl(var(--foreground))]">local coordinator + websocket</span></div><div>public url <span className="float-right text-[hsl(var(--foreground))]">{publicUrl || '—'}</span></div><div>identity <span className="float-right text-[hsl(var(--foreground))]">Ed25519 peerId</span></div><div>ice <span className="float-right text-[hsl(var(--foreground))]">{turnOk ? 'stun+turn' : 'stun only'}</span></div></div>}
      </section>

      <section className="mt-3 overflow-hidden rounded-2xl border border-[hsl(var(--accent)/.35)] bg-[hsl(var(--card))]" data-testid="section-debug-logs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--border))] px-5 py-5 sm:px-7">
          <div>
            <h2 className="font-display text-xl font-bold tracking-[-.04em]">Временные логи (тест с друзьями)</h2>
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Туннель, session, голос/ICE/NAT. Записей: {logs.length}{natSummary ? ` · NAT: ${natSummary}` : ''}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="ghost-btn" onClick={() => void snapshotNat()} disabled={natBusy} data-testid="button-nat-snapshot"><Activity size={15} /> {natBusy ? 'Снимок…' : 'Снимок NAT/голос'}</button>
            <button className="ghost-btn" onClick={() => void copyLogs()} data-testid="button-copy-debug-log"><Clipboard size={15} /> Копировать</button>
            <button className="ghost-btn" onClick={downloadLogs} data-testid="button-download-debug-log"><Download size={15} /> Скачать .txt</button>
            <button className="ghost-btn" onClick={() => { clearDebugLogs(); setLogAction('Лог очищен'); }} data-testid="button-clear-debug-log"><Trash2 size={15} /> Очистить</button>
          </div>
        </div>
        {logAction && <p className="px-5 pt-3 text-xs text-[hsl(var(--primary))] sm:px-7" data-testid="text-log-action">{logAction}</p>}
        <pre className="max-h-[320px] overflow-auto px-5 py-4 font-mono text-[10px] leading-5 text-[hsl(var(--muted-foreground))] sm:px-7" data-testid="pre-debug-log">
          {logs.length === 0
            ? 'Пока пусто — зайдите в комнату, напишите в чат, зайдите в голос (когда «не слышно»), нажмите «Снимок NAT/голос», затем скачайте лог.'
            : logs.slice(-120).map((entry) => `${entry.ts.slice(11, 19)} ${entry.level[0]} [${entry.scope}] ${entry.message}`).join('\n')}
        </pre>
        <p className="border-t border-[hsl(var(--border))] px-5 py-3 text-xs leading-5 text-[hsl(var(--muted-foreground))] sm:px-7">
          Баги и пожелания:{' '}
          <a href="mailto:maximrus96@gmail.com" className="font-semibold text-[hsl(var(--primary))] underline">maximrus96@gmail.com</a>
        </p>
      </section>

      <div className="mt-7 flex items-start gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.55)] p-4 text-xs leading-5 text-[hsl(var(--muted-foreground))]"><LockKeyhole size={15} className="mt-0.5 shrink-0 text-[hsl(var(--secondary))]" /><span><strong className="text-[hsl(var(--foreground))]">Голос не слышно, чат работает:</strong> останьтесь в голосовом канале → Диагностика → «Снимок NAT/голос» → «Скачать .txt» → на <a href="mailto:maximrus96@gmail.com" className="font-semibold text-[hsl(var(--foreground))] underline">maximrus96@gmail.com</a>. В отчёте коды вроде <span className="font-mono text-[hsl(var(--foreground))]">NO_RELAY_NO_METERED</span> / <span className="font-mono text-[hsl(var(--foreground))]">CONNECTED_NO_AUDIO_BYTES</span>, без текста чата и без IP.</span></div>
    </main>
  </div>;
}

