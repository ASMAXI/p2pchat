import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight, Link2, LockKeyhole, Settings, ShieldCheck, Trash2 } from 'lucide-react';
import { activateSavedServer, createLocalRoom, getBootstrapOrigin, getPeerId, isDesktopShell, isLocalhostOrigin, loadSavedServers, parseInvite, prepareJoin, removeSavedServer, setBootstrapOrigin, type SavedServer } from '@/lib/p2p-client';
import { isValidDisplayName, normalizeDisplayName, PENDING_INVITE_EVENT, takePendingInvite } from '@/lib/invite-deep-link';
import { avatarColors, avatarInitials } from '@/lib/avatar';
import { type Server, SERVER_KEY, CHANNELS_KEY, MESSAGES_KEY, VOICE_KEY, PROFILE_NAME_KEY, readStore, writeStore, roomStateToClientState } from '@/lib/app-shared';
import { LogoMark, CreatorCredit, AppVersionLabel, Toast } from '@/components/app-brand';
import { SettingsPage } from '@/components/settings-page';

export function Home() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [displayName, setDisplayName] = useState(() => readStore(PROFILE_NAME_KEY, ''));
  const [apiOrigin, setApiOriginState] = useState(getBootstrapOrigin);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [savedServers, setSavedServers] = useState<SavedServer[]>(() => loadSavedServers());
  const nameOk = isValidDisplayName(displayName);

  const requireName = (): string | null => {
    const memberName = normalizeDisplayName(displayName);
    if (!isValidDisplayName(memberName)) {
      setToast('Сначала укажите имя (минимум 2 символа) — без него на сервер не пустим');
      return null;
    }
    return memberName;
  };

  const openSaved = (server: SavedServer) => {
    const memberName = requireName();
    if (!memberName) return;
    const meta = activateSavedServer(server);
    writeStore(PROFILE_NAME_KEY, memberName);
    writeStore(SERVER_KEY, {
      id: meta.roomId,
      roomId: meta.roomId,
      name: server.name,
      memberCount: 0,
      role: server.role,
      connectivityState: 'checking',
      hostName: server.hostName ?? '…',
      peerId: getPeerId(),
      inviteToken: meta.inviteToken,
      invite: meta.invite,
      roomKey: meta.roomKey,
    } satisfies Server);
    writeStore(CHANNELS_KEY, []);
    writeStore(MESSAGES_KEY, []);
    writeStore(VOICE_KEY, []);
    setLocation('/server');
  };

  const forgetSaved = (roomId: string) => {
    setSavedServers(removeSavedServer(roomId));
    setToast('Сервер убран из списка');
  };

  const createServer = async (event: FormEvent) => {
    event.preventDefault();
    const memberName = requireName();
    if (!memberName) return;
    setBusy(true);
    try {
      if (apiOrigin.trim()) setBootstrapOrigin(apiOrigin);
      const created = await createLocalRoom({
        name: name.trim() || 'Комната без названия',
        displayName: memberName,
        bootstrapOrigin: apiOrigin.trim() || undefined,
      });
      const clientState = roomStateToClientState(created.state, created.identity.peerId, created.meta.invite);
      clientState.server.inviteToken = created.meta.inviteToken;
      clientState.server.roomKey = created.meta.roomKey;
      writeStore(PROFILE_NAME_KEY, memberName);
      writeStore(SERVER_KEY, clientState.server);
      writeStore(CHANNELS_KEY, clientState.channels);
      writeStore(MESSAGES_KEY, []);
      writeStore(VOICE_KEY, clientState.voiceRooms);
      setSavedServers(loadSavedServers());
      setLocation('/server');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не удалось создать комнату');
    } finally {
      setBusy(false);
    }
  };

  const joinWithInvite = async (rawInvite: string, nameOverride?: string) => {
    const memberName = normalizeDisplayName(nameOverride ?? displayName);
    if (!isValidDisplayName(memberName)) {
      setMode('join');
      setInvite(rawInvite);
      setToast('Сначала укажите имя (минимум 2 символа) — без него на сервер не пустим');
      return;
    }
    const parsed = parseInvite(rawInvite);
    if (!parsed) {
      setToast('Вставьте ссылку приглашения Drift (drift://j/…)');
      return;
    }
    if (parsed.origins.every((origin) => isLocalhostOrigin(origin)) && parsed.origins.length > 0) {
      setToast('В ссылке только localhost — укажите LAN/публичный адрес или bootstrap ниже.');
    }
    setBusy(true);
    try {
      if (apiOrigin.trim()) setBootstrapOrigin(apiOrigin);
      const prepared = await prepareJoin({
        invite: rawInvite,
        displayName: memberName,
        bootstrapOrigin: apiOrigin.trim() || undefined,
      });
      writeStore(PROFILE_NAME_KEY, memberName);
      writeStore(SERVER_KEY, {
        id: prepared.meta.roomId,
        roomId: prepared.meta.roomId,
        name: 'Комната',
        memberCount: 0,
        role: 'Участник',
        connectivityState: 'checking',
        hostName: '…',
        peerId: prepared.identity.peerId,
        inviteToken: prepared.meta.inviteToken,
        invite: prepared.meta.invite,
        roomKey: prepared.meta.roomKey,
      } satisfies Server);
      writeStore(CHANNELS_KEY, []);
      writeStore(MESSAGES_KEY, []);
      writeStore(VOICE_KEY, []);
      setSavedServers(loadSavedServers());
      setLocation('/server');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не удалось войти в комнату');
    } finally {
      setBusy(false);
    }
  };

  const joinServer = async (event: FormEvent) => {
    event.preventDefault();
    await joinWithInvite(invite);
  };

  useEffect(() => {
    const applyInvite = (raw: string) => {
      setMode('join');
      setInvite(raw);
      const stored = normalizeDisplayName(readStore(PROFILE_NAME_KEY, ''));
      if (isValidDisplayName(stored)) {
        setDisplayName(stored);
        void joinWithInvite(raw, stored);
      } else {
        setToast('Ссылка получена — укажите имя и нажмите «Войти в комнату»');
      }
    };
    const pending = takePendingInvite();
    if (pending) applyInvite(pending);
    const onPending = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === 'string' && detail) {
        takePendingInvite();
        applyInvite(detail);
      }
    };
    window.addEventListener(PENDING_INVITE_EVENT, onPending);
    return () => window.removeEventListener(PENDING_INVITE_EVENT, onPending);
    // Mount + deep-link events only; join uses name from PROFILE_NAME_KEY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <main className="noise min-h-[100dvh] overflow-hidden app-grid" style={{ background: 'hsl(var(--background))' }}>
      <div className="mx-auto grid min-h-[100dvh] max-w-[1500px] grid-cols-1 lg:grid-cols-[1.05fr_.95fr]">
        <section className="relative flex min-h-[440px] flex-col overflow-hidden px-6 py-7 text-[#f5f0df] lg:min-h-[100dvh] lg:px-14 lg:py-10" style={{ background: 'hsl(var(--sidebar))' }}>
          <div className="absolute -right-24 top-24 h-72 w-72 rounded-full border border-[#d8fa67]/20" />
          <div className="absolute -right-8 top-40 h-56 w-56 rounded-full border border-[#d8fa67]/15" />
          <div className="absolute bottom-[-100px] left-[-70px] h-72 w-72 rounded-full" style={{ background: 'hsl(var(--accent) / .13)' }} />
          <LogoMark />
          <div className="relative z-10 mt-auto max-w-[590px] pb-3 pt-24 lg:pb-12">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#f5f0df]/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.18em] text-[#d8fa67]"><span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-[#d8fa67]" /> private by default</div>
            <h1 className="font-display text-[clamp(3.1rem,7vw,6.8rem)] font-bold leading-[.91] tracking-[-.08em]">Свои люди.<br /><span style={{ color: 'hsl(var(--primary))' }}>Своя комната.</span></h1>
            <p className="mt-7 max-w-[460px] text-[15px] leading-7 text-[#f5f0df]/63">В Drift нет постоянного сервера: роль хоста «дрейфует» между участниками. Ушёл один — комнату подхватывает следующий, и связь продолжается.</p>
            <div className="mt-12 grid max-w-[430px] grid-cols-3 gap-5 border-t border-[#f5f0df]/15 pt-5">
              <div><div className="font-display text-2xl font-bold">01</div><div className="mt-1 text-[11px] text-[#f5f0df]/48">Создать комнату</div></div>
              <div><div className="font-display text-2xl font-bold">02</div><div className="mt-1 text-[11px] text-[#f5f0df]/48">Позвать своих</div></div>
              <div><div className="font-display text-2xl font-bold">∞</div><div className="mt-1 text-[11px] text-[#f5f0df]/48">Остаться на связи</div></div>
            </div>
          </div>
          <div className="absolute right-[11%] top-[24%] hidden w-48 rotate-[-5deg] rounded-2xl border border-[#f5f0df]/15 bg-[#f5f0df]/[.06] p-4 backdrop-blur-md lg:block animate-float">
            <div className="mb-5 flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-widest text-[#f5f0df]/45">room / 17</span><span className="h-2 w-2 rounded-full bg-[#d8fa67]" /></div>
            <div className="space-y-3"><div className="h-2 w-24 rounded-full bg-[#f5f0df]/20" /><div className="h-2 w-32 rounded-full bg-[#f5f0df]/10" /><div className="h-2 w-20 rounded-full bg-[#d8fa67]/50" /></div>
            <div className="mt-5 flex items-center gap-1"><div className="h-5 w-5 rounded-md bg-[#d8fa67]"/><div className="h-5 w-5 rounded-md bg-[#f28262]"/><div className="h-5 w-5 rounded-md bg-[#f5f0df]/20"/><span className="ml-1 text-[9px] text-[#f5f0df]/50">18 здесь</span></div>
          </div>
        </section>
        <section className="flex max-h-[100dvh] items-start overflow-y-auto px-6 py-10 sm:px-12 lg:px-20">
          <div className="mx-auto w-full max-w-[440px] animate-rise">
            <div className="mb-8 flex items-center justify-between lg:hidden">
              <LogoMark small />
              <span className="font-mono text-[10px] uppercase tracking-widest text-[hsl(var(--muted-foreground))]">приватная комната</span>
            </div>
            <div className="mb-8"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">Вход в пространство</p><h2 className="font-display mt-3 text-4xl font-bold tracking-[-.06em]">Где собираемся?</h2><p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">Комната синхронизируется между приглашёнными участниками. Никаких аккаунтов и лишних шагов.</p></div>

            <div className="mb-5">
              <label className="field-label" htmlFor="display-name">Ваше имя / логин</label>
              <input
                id="display-name"
                className="field-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Например, Миша"
                data-testid="input-display-name"
                required
                minLength={2}
                maxLength={32}
              />
              {!nameOk && (
                <p className="mt-2 text-xs text-[hsl(var(--accent))]" data-testid="text-name-required">
                  Без имени создать сервер или войти по ссылке нельзя.
                </p>
              )}
            </div>

            <div className="mb-7 grid grid-cols-2 rounded-xl bg-[hsl(var(--muted))] p-1" role="tablist">
              <button className={`rounded-[9px] px-3 py-2.5 text-sm font-bold transition ${mode === 'create' ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm' : 'text-[hsl(var(--muted-foreground))]'}`} onClick={() => setMode('create')} data-testid="tab-create-server">Создать сервер</button>
              <button className={`rounded-[9px] px-3 py-2.5 text-sm font-bold transition ${mode === 'join' ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm' : 'text-[hsl(var(--muted-foreground))]'}`} onClick={() => setMode('join')} data-testid="tab-join-server">Войти по ссылке</button>
            </div>

            {mode === 'create' ? (
              <form onSubmit={createServer} className="animate-rise" data-testid="form-create-server">
                <label className="field-label" htmlFor="server-name">Название сервера</label>
                <input id="server-name" className="field-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, «Наши выходные»" data-testid="input-server-name" autoFocus />
                <div className="mt-4 flex items-start gap-2 rounded-xl bg-[hsl(var(--muted))] p-3.5 text-xs leading-5 text-[hsl(var(--muted-foreground))]"><LockKeyhole size={15} className="mt-0.5 shrink-0 text-[hsl(var(--secondary))]" /> Только вы решаете, кто получает приглашение. Сервер будет готов через секунду.</div>
                <button className="primary-btn mt-6 w-full" type="submit" disabled={busy || !nameOk} data-testid="button-create-server">{busy ? 'Подключаем комнату…' : 'Создать приватный сервер'} {!busy && <ArrowRight size={16} />}</button>
              </form>
            ) : (
              <form onSubmit={joinServer} className="animate-rise" data-testid="form-join-server">
                <label className="field-label" htmlFor="invite-code">Ссылка приглашения</label>
                <div className="relative"><Link2 size={17} className="absolute left-3.5 top-3.5 text-[hsl(var(--muted-foreground))]" /><input id="invite-code" className="field-input pl-10" value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="https://… или drift://j/…" data-testid="input-invite-code" autoFocus /></div>
                <p className="mt-3 text-xs leading-5 text-[hsl(var(--muted-foreground))]">В Steam шлите https-ссылку из «Пригласить» — она кликабельна. После перезапуска хоста попросите свежую: меняется адрес туннеля.</p>
                <button className="primary-btn mt-6 w-full" type="submit" disabled={busy || !nameOk || !invite.trim()} data-testid="button-join-server">{busy ? 'Проверяем приглашение…' : 'Войти в комнату'} {!busy && <ArrowRight size={16} />}</button>
              </form>
            )}

            <div className="mt-4 flex justify-center">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-2.5 text-sm font-semibold text-[hsl(var(--foreground))] transition hover:border-[hsl(var(--primary)/.45)] hover:bg-[hsl(var(--muted))]"
                onClick={() => setShowSettings(true)}
                data-testid="button-home-settings"
              >
                <Settings size={15} className="text-[hsl(var(--secondary))]" /> Настройки
              </button>
            </div>

            {savedServers.length > 0 && (
              <div className="mt-10" data-testid="saved-servers">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Ваши серверы</div>
                <div className="max-h-[min(280px,36vh)] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                  {savedServers.map((server) => (
                    <div key={server.roomId} className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] p-2.5">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => openSaved(server)}
                        data-testid={`button-open-server-${server.roomId}`}
                      >
                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[11px] font-extrabold" style={avatarColors(server.name)}>{avatarInitials(server.name)}</div>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-bold">{server.name}</span>
                          <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{server.role}{server.hostName ? ` · ${server.hostName}` : ''}</span>
                        </span>
                        <ArrowRight size={16} className="ml-auto shrink-0 text-[hsl(var(--muted-foreground))]" />
                      </button>
                      <button type="button" className="icon-btn shrink-0" aria-label="Убрать из списка" onClick={() => forgetSaved(server.roomId)} data-testid={`button-forget-server-${server.roomId}`}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isDesktopShell() && (
              <div className="mt-10 border-t border-[hsl(var(--border))] pt-6">
                <label className="field-label" htmlFor="api-origin">Резервный bootstrap (необязательно)</label>
                <input id="api-origin" className="field-input" value={apiOrigin} onChange={(event) => setApiOriginState(event.target.value)} placeholder="http://192.168.0.10:5000" data-testid="input-api-origin" />
                <p className="mt-2 text-xs leading-5 text-[hsl(var(--muted-foreground))]">При создании комнаты coordinator запускается на этом компьютере автоматически. Укажите адрес только если подключаетесь через интернет или к чужому узлу.</p>
              </div>
            )}

            <div className="mt-10 flex items-center gap-2 text-[11px] text-[hsl(var(--muted-foreground))]"><ShieldCheck size={14} /> Защищённая комната · без аккаунта</div>
            <CreatorCredit className="mt-3 block text-[hsl(var(--muted-foreground))]" />
            <AppVersionLabel className="mt-2 block" />
          </div>
        </section>
      </div>
      {toast && <Toast text={toast} onClose={() => setToast('')} />}
      {showSettings && (
        <div className="fixed inset-0 z-[80] overflow-auto bg-[hsl(var(--background))]">
          <SettingsPage onClose={() => setShowSettings(false)} />
        </div>
      )}
    </main>
  );
}

