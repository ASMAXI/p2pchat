import { useEffect, useRef, useState, useMemo, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Route, Switch, Link, useLocation, Router as WouterRouter } from 'wouter';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  Hash,
  Headphones,
  Info,
  Link2,
  LockKeyhole,
  Menu,
  Mic,
  MicOff,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Signal,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  X,
  Zap,
  ImageIcon,
  Monitor,
  MonitorOff,
  Music2,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { VoiceOverlayPage } from '@/components/voice-overlay-page';
import { PatriotJoinPopup, shouldShowPatriotPopup } from '@/components/patriot-join-popup';
import {
  activateSavedServer,
  createLocalRoom,
  checkForAppUpdate,
  currentAppVersion,
  installAppUpdate,
  getBootstrapOrigin,
  getPeerId,
  getPublicUrl,
  isCustomTurnConfigured,
  isDesktopShell,
  isLocalhostOrigin,
  isTurnConfigured,
  leaveCurrentRoom,
  loadIceSettings,
  loadSavedServers,
  openRoomSession,
  parseInvite,
  prepareJoin,
  refreshCoordinatorInvite,
  removeSavedServer,
  restartPublicTunnel,
  saveIceSettings,
  setBootstrapOrigin,
  setPublicUrl,
  statusLabel,
  VoiceMesh,
  getActiveVoiceMesh,
  warmIceServers,
  type AppUpdateInfo,
  type RoomMember as ApiRoomMember,
  type RoomState as ApiRoomState,
  type SavedServer,
  type VoicePeerStatus,
} from '@/lib/p2p-client';
import { getLastVoiceNatReport, iceConfigFlags } from '@/lib/voice-diagnostics';
import type { RoomSession } from '@workspace/p2p-room';
import type { SessionStatus } from '@workspace/p2p-room';
import {
  clearDebugLogs,
  copyDebugReport,
  debugLog,
  downloadDebugReport,
  getDebugLogs,
  subscribeDebugLogs,
} from '@/lib/debug-log';
import {
  emitPendingInvite,
  installInviteDeepLinkHandler,
  isValidDisplayName,
  normalizeDisplayName,
  PENDING_INVITE_EVENT,
  takePendingInvite,
} from '@/lib/invite-deep-link';
import {
  avatarColors,
  avatarInitials,
  fileToChatImageDataUrl,
} from '@/lib/avatar';
import {
  encodeRichMessage,
  encodeReact,
  encodeEdit,
  encodeDelete,
  encodePin,
  encodeSfx,
  foldChatMessages,
  extractMentions,
  mentionSuggestions,
  applyMentionSuggestion,
  splitMentionSpans,
  fileToChatAttachment,
  parseWireText,
  IMAGE_MESSAGE_PREFIX,
} from '@/lib/chat-payload';
import { notifyDesktop } from '@/lib/desktop-notify';
import { cacheRoomMessages, loadCachedRoomMessages, mergeMessagesWithCache } from '@/lib/message-cache';
import { getAutostartEnabled, setAutostartEnabled } from '@/lib/autostart';
import { APP_THEMES, loadTheme, saveTheme, useAppTheme, type AppThemeId } from '@/lib/theme';
import { refreshPatriotRankSalt, rfRankFor } from '@/lib/patriot-ranks';
import {
  FUN_SOUNDS,
  funSoundLabel,
  isFunSoundId,
  playFunSound,
  type FunSoundId,
} from '@/lib/fun-sounds';
import {
  loadChannelPaneWidth,
  loadMemberPaneCollapsed,
  loadMemberPaneWidth,
  saveMemberPaneCollapsed,
  saveChannelPaneWidth,
  saveMemberPaneWidth,
} from '@/lib/layout-settings';
import {
  listAudioDevices,
  loadAudioInputId,
  loadAudioOutputId,
  saveAudioInputId,
  saveAudioOutputId,
} from '@/lib/audio-settings';
import {
  STARTUP_SOUND_OPTIONS,
  loadStartupSoundId,
  loadUiSoundsEnabled,
  playUiSound,
  previewStartupSound,
  saveStartupSoundId,
  saveUiSoundsEnabled,
  type StartupSoundId,
} from '@/lib/ui-sounds';
import {
  loadPttKeyCode,
  loadVoiceOverlayEnabled,
  loadVoiceOverlayInteractive,
  loadVoiceOverlayOpacity,
  loadVoiceTalkMode,
  pttVkForCode,
  PTT_KEY_OPTIONS,
  savePttKeyCode,
  saveVoiceOverlayEnabled,
  saveVoiceOverlayInteractive,
  saveVoiceOverlayOpacity,
  saveVoiceTalkMode,
  VOICE_OVERLAY_PAYLOAD_KEY,
  type PttKeyCode,
  type VoiceOverlayPayload,
  type VoiceTalkMode,
} from '@/lib/voice-settings';
import {
  TUNNEL_PROVIDER_OPTIONS,
  loadNgrokAuthToken,
  loadTunnelProvider,
  loadZrokToken,
  saveNgrokAuthToken,
  saveTunnelProvider,
  saveZrokToken,
  type TunnelProviderId,
} from '@/lib/tunnel-settings';

type ConnectivityState = 'connected' | 'checking' | 'offline';
type ChannelType = 'text' | 'voice';
type Server = {
  id: string;
  name: string;
  memberCount: number;
  role: string;
  connectivityState: ConnectivityState;
  hostName: string;
  roomId?: string;
  inviteToken?: string;
  invite?: string;
  peerId?: string;
  roomKey?: string;
};
type Channel = { id: string; name: string; type: ChannelType; unreadCount: number; members: number };
type Message = {
  id: string;
  author: string;
  authorId?: string;
  content: string;
  timestamp: string;
  timestampIso?: string;
  avatar: string;
  isCurrentUser: boolean;
  channelId?: string;
  delivery?: 'queued' | 'sent' | 'synced';
};
type VoiceRoom = {
  id: string;
  name: string;
  participantCount: number;
  state: 'ready' | 'live';
  participants: string[];
};
type StoredVoice = VoiceRoom & { muted?: boolean; deafened?: boolean };

const queryClient = new QueryClient();
const SERVER_KEY = 'p2pchat-server';
const CHANNELS_KEY = 'p2pchat-channels';
const MESSAGES_KEY = 'p2pchat-messages';
const VOICE_KEY = 'p2pchat-voice';
const PROFILE_NAME_KEY = 'p2pchat-profile-name';
const CONNECTION_KEY = 'p2pchat-connection-status';

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
const readStore = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};
const writeStore = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

const inviteLooksLocal = (invite?: string): boolean => {
  const haystack = `${invite ?? ''} ${getBootstrapOrigin()}`;
  if (isLocalhostOrigin(haystack)) return true;
  return /192\.168\.|(^|[^\d])10\.|172\.(1[6-9]|2\d|3[01])\./.test(haystack);
};

const mergeChannelUnread = (prev: Channel[], incoming: Channel[]): Channel[] => {
  const unreadById = new Map(prev.map((channel) => [channel.id, channel.unreadCount]));
  return incoming.map((channel) => ({
    ...channel,
    unreadCount: unreadById.get(channel.id) ?? channel.unreadCount ?? 0,
  }));
};

const roomStateToClientState = (state: ApiRoomState, peerId: string, invite?: string) => {
  const onlineMembers = state.members.filter((member) => member.online);
  const server: Server = {
    id: state.id,
    roomId: state.id,
    name: state.name,
    memberCount: onlineMembers.length,
    role: state.ownerId === peerId ? 'Владелец' : 'Участник',
    connectivityState: 'connected',
    hostName: state.hostName,
    peerId,
    invite,
  };
  const voiceRooms: StoredVoice[] = state.channels
    .filter((channel) => channel.type === 'voice')
    .map((channel) => {
      const participants = state.voiceParticipants[channel.id] ?? [];
      return {
        id: channel.id,
        name: channel.name,
        participantCount: participants.length,
        state: participants.length > 0 ? 'live' : 'ready',
        participants: participants.map((participant) => participant.name),
      };
    });
  return {
    server,
    channels: state.channels,
    voiceRooms,
  };
};

const seedServer: Server = {
  id: 'server-orbit',
  name: 'Комната',
  memberCount: 0,
  role: 'Участник',
  connectivityState: 'offline',
  hostName: '—',
};
const seedChannels: Channel[] = [
  { id: 'general', name: 'общий', type: 'text', unreadCount: 0, members: 0 },
  { id: 'lounge', name: 'голосовой', type: 'voice', unreadCount: 0, members: 0 },
];
const seedMessages: Message[] = [];
const seedVoice: StoredVoice[] = [
  { id: 'lounge', name: 'голосовой', participantCount: 0, state: 'ready', participants: [] },
];

function LogoMark({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? 'server-mark' : 'flex items-center gap-3'}>
      <div className="server-mark" style={small ? undefined : { width: 38, height: 38, borderRadius: 11 }}>
        <Signal size={20} strokeWidth={2.5} />
      </div>
      {!small && <BrandName className="text-[20px]" />}
    </div>
  );
}

function BrandName({ className = '' }: { className?: string }) {
  return <span className={`font-display font-bold tracking-[-.05em] ${className}`}>Dri<span style={{ color: 'hsl(var(--accent))' }}>ft</span></span>;
}

function CreatorCredit({ className = '' }: { className?: string }) {
  return <span className={`font-mono text-[10px] uppercase tracking-[.14em] ${className}`} data-testid="text-creator">Drift · создатель ASMAXI</span>;
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 3300);
    return () => window.clearTimeout(timer);
  }, [onClose]);
  return <div className="toast" data-testid="status-toast"><Check size={16} color="hsl(var(--primary))" /><span>{text}</span><button className="icon-btn ml-auto" onClick={onClose} aria-label="Закрыть уведомление" data-testid="button-close-toast"><X size={15} /></button></div>;
}

function Home() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [displayName, setDisplayName] = useState(() => readStore(PROFILE_NAME_KEY, ''));
  const [apiOrigin, setApiOriginState] = useState(getBootstrapOrigin);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
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
            <div className="mb-8 flex items-center justify-between lg:hidden"><LogoMark small /><span className="font-mono text-[10px] uppercase tracking-widest text-[hsl(var(--muted-foreground))]">приватная комната</span></div>
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
          </div>
        </section>
      </div>
      {toast && <Toast text={toast} onClose={() => setToast('')} />}
    </main>
  );
}

function ConnectionStatusChips({
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

function WorkspaceNav({
  unreadTotal,
  onDiagnostics,
  onSettings,
}: {
  unreadTotal: number;
  onDiagnostics: () => void;
  onSettings: () => void;
}) {
  const [location, setLocation] = useLocation();
  const theme = useAppTheme();
  const isPatriot = theme === 'patriot';
  const unreadLabel = unreadTotal > 99 ? '99+' : String(unreadTotal);
  return (
    <aside className="workspace-nav" aria-label="Навигация">
      <Link href="/server" className={`relative ${isPatriot ? 'patriot-crest' : 'server-mark'}`} aria-label="Drift · создатель ASMAXI" title="Drift · создатель ASMAXI" data-testid="link-server-home">
        {unreadTotal > 0 && (
          <span className="nav-unread-badge" data-testid="badge-nav-unread">{unreadLabel}</span>
        )}
        {isPatriot ? (
          <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
            <ellipse cx="32" cy="34" rx="18" ry="20" fill="#1a2a6c" opacity=".9" />
            <path d="M20 28c4-8 20-8 24 0-2 10-6 16-12 20-6-4-10-10-12-20z" fill="#c9a227" />
            <circle cx="32" cy="22" r="5" fill="#f4d35e" />
            <path d="M18 30c2 1 4 0 6-2M46 30c-2 1-4 0-6-2" stroke="#f4d35e" strokeWidth="2" fill="none" />
            <path d="M26 40h12M28 46h8" stroke="#f4d35e" strokeWidth="2" />
            <text x="32" y="58" textAnchor="middle" fontSize="7" fontWeight="800" fill="#1a2a6c">РФ</text>
          </svg>
        ) : (
          <Signal size={20} strokeWidth={2.5} />
        )}
      </Link>
      <div className="nav-divider" />
      <button className={`nav-icon ${location === '/server' ? 'active' : ''}`} onClick={() => setLocation('/server')} aria-label="Чаты" data-testid="button-nav-chat"><Hash size={18} /></button>
      <button className="nav-icon" onClick={onDiagnostics} aria-label="Диагностика" data-testid="button-nav-diagnostics"><Activity size={18} /></button>
      <div className="mt-auto flex flex-col gap-3">
        <button className="nav-icon" onClick={onSettings} aria-label="Настройки" data-testid="button-nav-settings"><Settings size={18} /></button>
        <div className="member-avatar" style={{ width: 38, height: 38, background: isPatriot ? 'linear-gradient(180deg,#fff 0 33%,#0039a6 33% 66%,#d52b1e 66%)' : 'hsl(var(--accent))', color: isPatriot ? '#111' : 'hsl(var(--accent-foreground))' }}>ВЫ</div>
      </div>
    </aside>
  );
}

function PatriotName({ name, seed }: { name: string; seed?: string }) {
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

function CreateChannelDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, type: ChannelType) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ChannelType>('text');
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim()) onCreate(name.trim(), type); };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="dialog-card" onSubmit={submit} data-testid="form-create-channel">
        <div className="mb-6 flex items-start justify-between"><div><div className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">Новое пространство</div><h3 className="font-display mt-2 text-2xl font-bold tracking-[-.05em]">Добавить канал</h3></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть" data-testid="button-close-channel-dialog"><X size={18} /></button></div>
        <label className="field-label" htmlFor="channel-name">Название</label><input id="channel-name" className="field-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="например, кино" autoFocus data-testid="input-channel-name" />
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setType('text')} className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${type === 'text' ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.12)]' : 'border-[hsl(var(--border))]'}`} data-testid="button-channel-type-text"><Hash size={17} /><span><strong className="block text-sm">Текстовый</strong><small className="text-[11px] text-[hsl(var(--muted-foreground))]">Сообщения</small></span></button>
          <button type="button" onClick={() => setType('voice')} className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${type === 'voice' ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.12)]' : 'border-[hsl(var(--border))]'}`} data-testid="button-channel-type-voice"><Volume2 size={17} /><span><strong className="block text-sm">Голосовой</strong><small className="text-[11px] text-[hsl(var(--muted-foreground))]">Разговор</small></span></button>
        </div>
        <button className="primary-btn mt-6 w-full" type="submit" data-testid="button-submit-channel">Создать канал <Plus size={16} /></button>
      </form>
    </div>
  );
}

function InviteDialog({ server, onClose, onNotify }: { server: Server; onClose: () => void; onNotify: (text: string) => void }) {
  const link = server.invite ?? '';
  const isLocal = isLocalhostOrigin(server.invite ?? '');
  const copy = async () => {
    if (!link) {
      onNotify('Ссылка ещё не готова — подождите туннель');
      return;
    }
    try { await navigator.clipboard.writeText(link); } catch { /* clipboard can be unavailable in local previews */ }
    onNotify('Ссылка скопирована — друг может нажать её и открыть Drift');
    onClose();
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-card">
    <div className="mb-6 flex items-start justify-between"><div><div className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">Доступ в комнату</div><h3 className="font-display mt-2 text-2xl font-bold tracking-[-.05em]">Позвать своих</h3></div><button className="icon-btn" onClick={onClose} aria-label="Закрыть" data-testid="button-close-invite-dialog"><X size={18} /></button></div>
    <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))]">Ссылка <span className="font-mono text-[11px]">https://…</span> кликабельна в Steam и мессенджерах: откроет страницу → Drift. У друга должно быть установлено приложение. После перезапуска хоста или смены туннеля скопируйте свежую ссылку.</p>
    {isLocal && <div className="mt-4 rounded-xl border border-[hsl(var(--accent))]/30 bg-[hsl(var(--accent)/.08)] p-3 text-xs leading-5 text-[hsl(var(--accent))]">
      <strong>Внимание:</strong> в ссылке только localhost. Друзья в другой сети не подключатся.
      <div className="mt-2 font-mono text-[10px]">В одной Wi‑Fi приглашение должно содержать LAN-адрес (его подставит desktop-клиент). Между сетями нужен публичный bootstrap или туннель.</div>
    </div>}
    <div className="mt-5 max-h-40 overflow-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.55)] p-3"><div className="break-all font-mono text-[11px] leading-5 tracking-tight text-[hsl(var(--foreground))]" data-testid="text-invite-link">{link || 'Ссылка появится после поднятия туннеля'}</div></div>
    <button className="primary-btn mt-5 w-full" onClick={copy} data-testid="button-copy-invite"><Copy size={16} /> Скопировать ссылку</button>
  </div></div>;
}

function ChannelPane({
  server,
  channels,
  voiceRooms,
  selectedId,
  onSelect,
  onAdd,
  onInvite,
  onLeaveServer,
  selfPeerId,
  selfDisplayName,
  selfMuted,
  selfDeafened,
  activeVoiceChannelId,
  voicePeers,
  peerVoiceStates,
  speakingPeers,
  muted,
  deafened,
  onMute,
  onDeafen,
  micVolume,
  onMicVolume,
  noiseSuppression,
  echoCancellation,
  onToggleNoise,
  onToggleEcho,
  enhancedNoise,
  onToggleEnhancedNoise,
  onLeaveVoice,
  onPeerContextMenu,
  onChannelResizeMouseDown,
}: {
  server: Server;
  channels: Channel[];
  voiceRooms: StoredVoice[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onInvite: () => void;
  onLeaveServer: () => void;
  selfPeerId?: string;
  selfDisplayName?: string;
  selfMuted?: boolean;
  selfDeafened?: boolean;
  activeVoiceChannelId?: string | null;
  voicePeers?: Array<{ id: string; name: string }>;
  peerVoiceStates?: Record<string, { muted: boolean; deafened: boolean }>;
  speakingPeers?: Record<string, boolean>;
  muted?: boolean;
  deafened?: boolean;
  onMute?: () => void;
  onDeafen?: () => void;
  micVolume?: number;
  onMicVolume?: (value: number) => void;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  onToggleNoise?: () => void;
  onToggleEcho?: () => void;
  enhancedNoise?: boolean;
  onToggleEnhancedNoise?: () => void;
  onLeaveVoice?: () => void;
  onPeerContextMenu?: (event: ReactMouseEvent, peerId: string) => void;
  onChannelResizeMouseDown?: (event: ReactMouseEvent) => void;
}) {
  const textChannels = channels.filter((channel) => channel.type === 'text');
  const voiceChannels = channels.filter((channel) => channel.type === 'voice');
  const voiceById = Object.fromEntries(voiceRooms.map((room) => [room.id, room]));
  const theme = useAppTheme();
  return <aside className="channel-pane">
    <div className="channel-header">
      <button className="flex w-full items-center justify-between text-left" onClick={onInvite} data-testid="button-server-menu">
        <span>
          <span className="block font-display text-[17px] font-bold tracking-[-.04em]">{server.name}</span>
          <span className="mt-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))]" /> {server.memberCount} участников
          </span>
          {theme === 'patriot' && (
            <span className="patriot-flag-chip mt-2">
              <span className="patriot-flag-bars" aria-hidden />
              Россия · Drift
            </span>
          )}
        </span>
        <ChevronDown size={16} className="text-[hsl(var(--muted-foreground))]" />
      </button>
    </div>
    <div className="channel-scroll scrollbar-thin">
      <div className="mb-5"><div className="mb-2 flex items-center justify-between px-2 text-[10px] font-bold uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]"><span>Текстовые</span><button className="icon-btn" style={{ width: 22, height: 22 }} onClick={onAdd} aria-label="Добавить канал" data-testid="button-add-text-channel"><Plus size={14} /></button></div>{textChannels.map((channel) => <button key={channel.id} className={`channel-row ${channel.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(channel.id)} data-testid={`button-channel-${channel.id}`}><Hash size={17} /><span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold">{channel.name}</span>{channel.unreadCount > 0 && <span className="rounded-full bg-[hsl(var(--accent))] px-1.5 py-0.5 text-[10px] font-bold text-[hsl(var(--accent-foreground))]">{channel.unreadCount}</span>}</button>)}</div>
      <div><div className="mb-2 flex items-center justify-between px-2 text-[10px] font-bold uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]"><span>Голосовые</span><button className="icon-btn" style={{ width: 22, height: 22 }} onClick={onAdd} aria-label="Добавить голосовой канал" data-testid="button-add-voice-channel"><Plus size={14} /></button></div>
        {voiceChannels.map((channel) => {
          const room = voiceById[channel.id];
          const people = room?.participants ?? [];
          return (
            <div key={channel.id} className="mb-1">
              <button className={`channel-row ${channel.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(channel.id)} data-testid={`button-voice-room-${channel.id}`}>
                <Volume2 size={17} />
                <span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold">{channel.name}</span>
                {people.length > 0 && <span className="font-mono text-[10px]">{people.length}</span>}
              </button>
              {people.length > 0 && (
                <div className="mb-1 ml-2 space-y-0.5 border-l border-[hsl(var(--border))] pl-2" data-testid={`voice-members-${channel.id}`}>
                  {people.map((person) => {
                    const voiceUi = channel.id === activeVoiceChannelId;
                    const peer = voiceUi ? voicePeers?.find((item) => item.name === person) : undefined;
                    const isSelf = person === selfDisplayName;
                    const voiceState = voiceUi
                      ? isSelf
                        ? { muted: selfMuted ?? false, deafened: selfDeafened ?? false }
                        : peer ? peerVoiceStates?.[peer.id] : undefined
                      : undefined;
                    const speaking = voiceUi
                      ? isSelf
                        ? Boolean(speakingPeers?.[selfPeerId ?? ''])
                        : peer ? Boolean(speakingPeers?.[peer.id]) : false
                      : false;
                    const rowPeerId = isSelf ? undefined : peer?.id;
                    return (
                      <div
                        key={`${channel.id}-${person}`}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-[hsl(var(--foreground)/.85)]"
                        onContextMenu={rowPeerId && onPeerContextMenu ? (event) => { event.preventDefault(); onPeerContextMenu(event, rowPeerId); } : undefined}
                      >
                        <div
                          className={`member-avatar ${speaking ? 'ring-2 ring-[hsl(var(--primary))] ring-offset-1 ring-offset-[hsl(var(--background))]' : ''}`}
                          style={{ width: 22, height: 22, fontSize: 8, ...avatarColors(person) }}
                        >
                          {avatarInitials(person)}
                        </div>
                        <span className="min-w-0 flex-1 truncate font-semibold"><PatriotName name={person} seed={peer?.id ?? person} /></span>
                        {voiceState?.muted && <MicOff size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" aria-label="Микрофон выкл" />}
                        {voiceState?.deafened && <Headphones size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" aria-label="Звук выкл" />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
    {onChannelResizeMouseDown && (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину панели каналов"
        className="panel-resizer panel-resizer-right"
        onMouseDown={onChannelResizeMouseDown}
        data-testid="resizer-channel-pane"
      />
    )}
    <div className="channel-footer space-y-1">
      {activeVoiceChannelId && onMute && onDeafen && (
        <div className="mb-2 space-y-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.35)] p-2" data-testid="channel-voice-controls">
          <div className="flex flex-wrap gap-1">
            <button className={`icon-btn ${muted ? 'bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent))]' : ''}`} onClick={onMute} aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'} data-testid="button-toggle-mute">{muted ? <MicOff size={15} /> : <Mic size={15} />}</button>
            <button className={`icon-btn ${deafened ? 'bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent))]' : ''}`} onClick={onDeafen} aria-label={deafened ? 'Включить звук' : 'Отключить звук'} data-testid="button-toggle-deafen">{deafened ? <VolumeX size={15} /> : <Headphones size={15} />}</button>
            {onToggleNoise && (
              <button className={`ghost-btn !h-8 !px-2 text-[10px] ${noiseSuppression ? '' : 'opacity-50'}`} onClick={onToggleNoise} data-testid="button-toggle-noise">Шум {noiseSuppression ? 'вкл' : 'выкл'}</button>
            )}
            {onToggleEcho && (
              <button className={`ghost-btn !h-8 !px-2 text-[10px] ${echoCancellation ? '' : 'opacity-50'}`} onClick={onToggleEcho} data-testid="button-toggle-echo">Эхо {echoCancellation ? 'вкл' : 'выкл'}</button>
            )}
            {onToggleEnhancedNoise && (
              <button className={`ghost-btn !h-8 !px-2 text-[10px] ${enhancedNoise ? '' : 'opacity-50'}`} onClick={onToggleEnhancedNoise} title="Мягкий доп. фильтр (может чуть «съедать» тихую речь)" data-testid="button-toggle-enhanced-noise">Шумодав+ {enhancedNoise ? 'вкл' : 'выкл'}</button>
            )}
          </div>
          {onMicVolume && micVolume !== undefined && (
            <label className="block text-[10px] text-[hsl(var(--muted-foreground))]">Громкость микрофона
              <input type="range" min={0} max={100} value={Math.round(micVolume * 100)} onChange={(e) => onMicVolume(Number(e.target.value) / 100)} className="mt-1 w-full" data-testid="input-mic-volume" />
            </label>
          )}
        </div>
      )}
      {activeVoiceChannelId && onLeaveVoice && (
        <button className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-[hsl(var(--primary))] transition hover:bg-[hsl(var(--primary)/.12)]" onClick={onLeaveVoice} data-testid="button-leave-voice-channel"><VolumeX size={15} /> Покинуть голосовой канал</button>
      )}
      <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-[hsl(var(--muted-foreground))] transition hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]" onClick={onInvite} data-testid="button-invite-members"><UserPlus size={15} /> Пригласить друзей</button>
      <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-[hsl(var(--accent))] transition hover:bg-[hsl(var(--accent)/.12)]" onClick={onLeaveServer} data-testid="button-leave-server"><X size={15} /> Покинуть сервер</button>
      <CreatorCredit className="block px-2 pt-1 text-[8px] text-[hsl(var(--muted-foreground)/.7)]" />
    </div>
  </aside>;
}

type PeerVolumeMenuState = { peerId: string; x: number; y: number };

function PeerVolumeContextMenu({
  menu,
  peerName,
  volume,
  onVolume,
  onClose,
}: {
  menu: PeerVolumeMenuState;
  peerName: string;
  volume: number;
  onVolume: (peerId: string, value: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);
  return (
    <div
      className="fixed z-[95] min-w-[220px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(event) => event.stopPropagation()}
      data-testid="peer-volume-context-menu"
    >
      <div className="text-xs font-bold">Громкость: {peerName}</div>
      <p className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">Только у вас · 0–200%</p>
      <input
        type="range"
        min={0}
        max={200}
        value={Math.round(volume * 100)}
        onChange={(event) => onVolume(menu.peerId, Number(event.target.value) / 100)}
        className="mt-2 w-full"
        data-testid={`context-peer-volume-${menu.peerId}`}
      />
    </div>
  );
}

const REACTION_EMOJIS = ['👍', '😂', '🔥', '❤️'] as const;

function messagePreview(content: string): string {
  const parsed = parseWireText(content);
  if (parsed.kind === 'image') return 'Изображение';
  if (parsed.kind === 'sfx') {
    return isFunSoundId(parsed.id) ? `🔊 ${funSoundLabel(parsed.id)}` : '🔊 звук';
  }
  if (parsed.kind === 'text') {
    if (parsed.file) return `Файл: ${parsed.file.name}`;
    return parsed.body.slice(0, 120) || 'Сообщение';
  }
  return content.slice(0, 120);
}

function renderMessageBody(content: string, memberNames: string[], deleted?: boolean) {
  const spans = splitMentionSpans(content, memberNames);
  return (
    <p className={`mt-1 text-[14px] leading-6 ${deleted ? 'italic text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--foreground)/.82)]'}`}>
      {spans.map((part, index) =>
        part.mention ? (
          <span key={index} className="mention-chip">{part.text}</span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function MessageList({
  messages,
  memberNames,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onPin,
}: {
  messages: Message[];
  memberNames: string[];
  onReply: (id: string) => void;
  onReact: (targetId: string, emoji: string) => void;
  onEdit: (targetId: string, body: string) => void;
  onDelete: (targetId: string) => void;
  onPin: (targetId: string, pinned: boolean) => void;
}) {
  const folded = useMemo(
    () =>
      foldChatMessages(
        messages.map((message) => ({
          id: message.id,
          channelId: message.channelId,
          author: message.author,
          authorId: message.authorId,
          avatar: message.avatar,
          content: message.content,
          timestamp: message.timestamp,
          isCurrentUser: message.isCurrentUser,
          delivery: message.delivery,
        })),
      ),
    [messages],
  );
  const byId = useMemo(() => new Map(folded.map((item) => [item.id, item])), [folded]);
  const pinned = folded.filter((item) => item.pinned && !item.deleted);

  if (!folded.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-[hsl(var(--primary)/.18)] text-[hsl(var(--secondary))]"><Sparkles size={25} /></div>
        <h3 className="font-display mt-5 text-xl font-bold">Здесь пока тихо</h3>
        <p className="mt-2 max-w-xs text-sm leading-6 text-[hsl(var(--muted-foreground))]">Начните разговор — первое сообщение задаст настроение комнате.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {pinned.length > 0 && (
        <div className="mb-4 space-y-2 rounded-xl border border-[hsl(var(--primary)/.35)] bg-[hsl(var(--primary)/.08)] p-3" data-testid="banner-pinned-messages">
          <div className="font-mono text-[9px] font-bold uppercase tracking-[.14em] text-[hsl(var(--primary))]">Закреплено</div>
          {pinned.map((item) => (
            <div key={`pin-${item.id}`} className="text-xs leading-5">
              <strong><PatriotName name={item.author} /></strong>: {item.deleted ? item.content : item.imageUrl ? 'Изображение' : item.content.slice(0, 160)}
            </div>
          ))}
        </div>
      )}
      <div className="mb-7 flex items-center gap-3 text-[11px] text-[hsl(var(--muted-foreground))]"><div className="diag-line" /><span>Сегодня</span><div className="diag-line" /></div>
      {folded.map((message, index) => {
        const reply = message.replyTo ? byId.get(message.replyTo) : undefined;
        return (
          <article className="message-item group" key={message.id} style={{ animationDelay: `${index * 45}ms` }} data-testid={`message-${message.id}`}>
            <div className="message-avatar" style={avatarColors(message.author)}>{message.avatar}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <strong className="text-[13px]"><PatriotName name={message.author} /></strong>
                <time className="font-mono text-[9px] text-[hsl(var(--muted-foreground))]">{message.timestamp}</time>
                {message.edited && <span className="font-mono text-[8px] text-[hsl(var(--muted-foreground))]">изм.</span>}
                {message.pinned && <span className="font-mono text-[8px] text-[hsl(var(--primary))]">📌</span>}
              </div>
              {reply && !reply.deleted && (
                <div className="mt-1 border-l-2 border-[hsl(var(--border))] pl-2 text-[11px] text-[hsl(var(--muted-foreground))]" data-testid={`message-reply-${message.id}`}>
                  <span className="font-semibold text-[hsl(var(--foreground)/.7)]"><PatriotName name={reply.author} /></span>
                  <span className="ml-1">{reply.imageUrl ? 'Изображение' : reply.content.slice(0, 100)}</span>
                </div>
              )}
              {message.imageUrl ? (
                <img src={message.imageUrl} alt="Изображение в чате" className="mt-2 max-h-80 max-w-full rounded-xl border border-[hsl(var(--border))]" data-testid={`message-image-${message.id}`} />
              ) : message.file ? (
                <a href={message.file.dataUrl} download={message.file.name} className="mt-2 inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs font-semibold hover:bg-[hsl(var(--muted)/.5)]" data-testid={`message-file-${message.id}`}>
                  <Download size={14} /> {message.file.name}
                </a>
              ) : message.sfxId ? (
                <div className="mt-1 inline-flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.92)] px-3 py-1.5 text-xs font-semibold" data-testid={`message-sfx-${message.id}`}>
                  <span>{FUN_SOUNDS.find((s) => s.id === message.sfxId)?.emoji ?? '🔊'}</span>
                  <span>{isFunSoundId(message.sfxId) ? funSoundLabel(message.sfxId) : message.sfxId}</span>
                </div>
              ) : (
                renderMessageBody(message.content, memberNames, message.deleted)
              )}
              {message.reactions && Object.keys(message.reactions).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1" data-testid={`message-reactions-${message.id}`}>
                  {Object.entries(message.reactions).map(([emoji, authors]) => (
                    <button key={emoji} type="button" className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] px-2 py-0.5 text-[11px]" onClick={() => onReact(message.id, emoji)} title={authors.join(', ')}>
                      {emoji} {authors.length}
                    </button>
                  ))}
                </div>
              )}
              {!message.deleted && !message.sfxId && (
                <div className="mt-1 flex flex-wrap gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100" data-testid={`message-actions-${message.id}`}>
                  <button type="button" className="ghost-btn !h-7 !px-2 text-[10px]" onClick={() => onReply(message.id)} data-testid={`button-reply-${message.id}`}>Ответить</button>
                  {REACTION_EMOJIS.map((emoji) => (
                    <button key={emoji} type="button" className="ghost-btn !h-7 !w-7 !p-0 text-sm" onClick={() => onReact(message.id, emoji)} aria-label={`Реакция ${emoji}`}>{emoji}</button>
                  ))}
                  {message.isCurrentUser && (
                    <button type="button" className="ghost-btn !h-7 !px-2 text-[10px]" onClick={() => { const next = window.prompt('Новый текст сообщения', message.content); if (next != null && next.trim()) onEdit(message.id, next.trim()); }} data-testid={`button-edit-${message.id}`}>Изменить</button>
                  )}
                  {message.isCurrentUser && (
                    <button type="button" className="ghost-btn !h-7 !px-2 text-[10px] text-[hsl(var(--accent))]" onClick={() => { if (window.confirm('Удалить сообщение?')) onDelete(message.id); }} data-testid={`button-delete-${message.id}`}>Удалить</button>
                  )}
                  <button type="button" className="ghost-btn !h-7 !px-2 text-[10px]" onClick={() => onPin(message.id, !message.pinned)} data-testid={`button-pin-${message.id}`}>{message.pinned ? 'Открепить' : 'Закрепить'}</button>
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ScreenShareStage({
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

function ChatComposer({
  draft,
  memberNames,
  onDraftChange,
  onKeyDown,
  onSend,
  onPickFile,
  fileInputRef,
  placeholder,
  replyToLabel,
  onClearReply,
  outboxCount,
  footerHint,
  fileInputTestId,
  attachTestId,
  onPlayFunSound,
}: {
  draft: string;
  memberNames: string[];
  onDraftChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onPickFile: (file: File | undefined) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  replyToLabel?: string | null;
  onClearReply?: () => void;
  outboxCount: number;
  footerHint: string;
  fileInputTestId: string;
  attachTestId: string;
  onPlayFunSound?: (id: FunSoundId) => void;
}) {
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [sfxOpen, setSfxOpen] = useState(false);
  const mentionState = mentionSuggestions(draft, memberNames);
  const showMentionMenu = Boolean(mentionState && mentionState.matches.length > 0 && !mentionDismissed);

  useEffect(() => {
    setMentionDismissed(false);
  }, [draft]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionMenu && mentionState?.matches[0]) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionDismissed(true);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        onDraftChange(applyMentionSuggestion(draft, mentionState.matches[0]));
        setMentionDismissed(true);
        return;
      }
    }
    onKeyDown(event);
  };

  return (
    <div className="composer relative">
      {showMentionMenu && mentionState && (
        <div className="mention-menu" role="listbox" aria-label="Упоминания" data-testid="mention-menu">
          {mentionState.matches.map((name) => (
            <button
              key={name}
              type="button"
              role="option"
              className="flex w-full px-3 py-2 text-left text-sm font-semibold hover:bg-[hsl(var(--muted)/.55)]"
              onMouseDown={(event) => {
                event.preventDefault();
                onDraftChange(applyMentionSuggestion(draft, name));
                setMentionDismissed(true);
              }}
              data-testid={`mention-option-${name}`}
            >
              @{name}
            </button>
          ))}
        </div>
      )}
      {outboxCount > 0 && (
        <div className="mb-2 rounded-lg border border-[hsl(var(--accent)/.35)] bg-[hsl(var(--accent)/.08)] px-3 py-2 text-xs" data-testid="banner-outbox">
          В очереди: {outboxCount} {outboxCount === 1 ? 'сообщение' : outboxCount < 5 ? 'сообщения' : 'сообщений'} — уйдут при связи
        </div>
      )}
      {replyToLabel && onClearReply && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.35)] px-2 py-1.5 text-xs" data-testid="chip-reply-to">
          <span className="min-w-0 flex-1 truncate">Ответ: {replyToLabel}</span>
          <button type="button" className="icon-btn !h-7 !w-7" onClick={onClearReply} aria-label="Отменить ответ" data-testid="button-clear-reply"><X size={14} /></button>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="image/*,application/pdf,application/zip,.pdf,.zip" className="hidden" onChange={(e) => { void onPickFile(e.target.files?.[0]); }} data-testid={fileInputTestId} />
      {sfxOpen && onPlayFunSound && (
        <div className="soundboard-panel mb-2 grid grid-cols-5 gap-1.5" data-testid="soundboard-panel">
          {FUN_SOUNDS.map((sound) => (
            <button
              key={sound.id}
              type="button"
              className="flex flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-semibold hover:bg-[hsl(var(--muted)/.55)]"
              onClick={() => {
                onPlayFunSound(sound.id);
                setSfxOpen(false);
              }}
              data-testid={`button-sfx-${sound.id}`}
            >
              <span className="text-base leading-none">{sound.emoji}</span>
              <span className="truncate max-w-full">{sound.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-inner">
        <button type="button" className="icon-btn shrink-0" onClick={() => fileInputRef.current?.click()} aria-label="Прикрепить файл" data-testid={attachTestId}><ImageIcon size={18} /></button>
        {onPlayFunSound && (
          <button
            type="button"
            className={`icon-btn shrink-0 ${sfxOpen ? 'border-[hsl(var(--primary))] text-[hsl(var(--primary))]' : ''}`}
            onClick={() => setSfxOpen((open) => !open)}
            aria-label="Звуковая панель"
            data-testid="button-soundboard"
          >
            <Music2 size={18} />
          </button>
        )}
        <textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={handleKeyDown} placeholder={placeholder} aria-label="Новое сообщение" data-testid="input-message" rows={1} />
        <button className="primary-btn !h-9 !w-9 !p-0" onClick={onSend} aria-label="Отправить сообщение" data-testid="button-send-message"><Send size={15} /></button>
      </div>
      <div className="mt-2 flex items-center gap-1.5 px-1 font-mono text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]"><LockKeyhole size={10} /> {footerHint} <span className="ml-auto">enter — отправить</span></div>
    </div>
  );
}

function Workspace() {
  const [, setLocation] = useLocation();
  const [server, setServer] = useState<Server>(() => readStore(SERVER_KEY, seedServer));
  const [channels, setChannels] = useState<Channel[]>(() => readStore(CHANNELS_KEY, seedChannels));
  const [messages, setMessages] = useState<Message[]>(() => readStore(MESSAGES_KEY, seedMessages));
  const [voiceRooms, setVoiceRooms] = useState<StoredVoice[]>(() => readStore(VOICE_KEY, seedVoice));
  const [selectedId, setSelectedId] = useState('general');
  const [draft, setDraft] = useState('');
  const [showChannelDialog, setShowChannelDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [overlay, setOverlay] = useState<null | 'diagnostics' | 'settings'>(null);
  const [toast, setToast] = useState('');
  const [activeVoice, setActiveVoice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [micVolume, setMicVolume] = useState(1);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [enhancedNoise, setEnhancedNoise] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({});
  const [speakingPeers, setSpeakingPeers] = useState<Record<string, boolean>>({});
  const [peerVoiceStates, setPeerVoiceStates] = useState<Record<string, { muted: boolean; deafened: boolean }>>({});
  const [showMeteredHint, setShowMeteredHint] = useState(false);
  const [voicePeers, setVoicePeers] = useState<Array<{ id: string; name: string }>>([]);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [screenSharePeerId, setScreenSharePeerId] = useState<string | null>(null);
  const [screenShareStream, setScreenShareStream] = useState<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [members, setMembers] = useState<ApiRoomMember[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<SessionStatus>('offline');
  const [connectionError, setConnectionError] = useState('');
  const [isCoordinator, setIsCoordinator] = useState(false);
  const [peerId] = useState(getPeerId);
  const [voiceHint, setVoiceHint] = useState('');
  const [voicePeerStatus, setVoicePeerStatus] = useState<VoicePeerStatus | null>(null);
  const [channelPaneWidth, setChannelPaneWidth] = useState(loadChannelPaneWidth);
  const [memberPaneWidth, setMemberPaneWidth] = useState(loadMemberPaneWidth);
  const [memberPaneCollapsed, setMemberPaneCollapsed] = useState(loadMemberPaneCollapsed);
  const [peerVolumeMenu, setPeerVolumeMenu] = useState<PeerVolumeMenuState | null>(null);
  const layoutDragRef = useRef<'channel' | 'member' | null>(null);
  const channelWidthRef = useRef(channelPaneWidth);
  const memberWidthRef = useRef(memberPaneWidth);
  channelWidthRef.current = channelPaneWidth;
  memberWidthRef.current = memberPaneWidth;
  const sessionRef = useRef<RoomSession | null>(null);
  const voiceMeshRef = useRef<VoiceMesh | null>(null);
  const voiceChannelRef = useRef<string | null>(null);
  const [voiceTalkMode, setVoiceTalkMode] = useState<VoiceTalkMode>(() => loadVoiceTalkMode());
  const [pttKeyCode, setPttKeyCode] = useState<PttKeyCode>(() => loadPttKeyCode());
  const [pttHeld, setPttHeld] = useState(false);
  const pttHeldRef = useRef(false);
  const voiceTalkModeRef = useRef(voiceTalkMode);
  const pttKeyCodeRef = useRef(pttKeyCode);
  const userMutedRef = useRef(false);
  const [voiceOverlayEnabled, setVoiceOverlayEnabled] = useState(() => loadVoiceOverlayEnabled());
  const [voiceOverlayOpacity, setVoiceOverlayOpacity] = useState(() => loadVoiceOverlayOpacity());
  const [voiceOverlayInteractive, setVoiceOverlayInteractive] = useState(() => loadVoiceOverlayInteractive());
  const [patriotPopupToken, setPatriotPopupToken] = useState(0);
  const triggerPatriotPopup = () => {
    if (shouldShowPatriotPopup()) setPatriotPopupToken((n) => n + 1);
  };
  voiceTalkModeRef.current = voiceTalkMode;
  pttKeyCodeRef.current = pttKeyCode;
  userMutedRef.current = muted;
  pttHeldRef.current = pttHeld;

  const effectiveMicMuted = (userMuted: boolean, held: boolean, mode: VoiceTalkMode) =>
    userMuted || (mode === 'ptt' && !held);
  const applyEffectiveMicMute = (userMuted = userMutedRef.current, held = pttHeldRef.current, mode = voiceTalkModeRef.current) => {
    voiceMeshRef.current?.setMuted(effectiveMicMuted(userMuted, held, mode));
  };
  const selectedIdRef = useRef(selectedId);
  const knownMemberIdsRef = useRef<Set<string> | null>(null);
  const knownMessageIdsRef = useRef<Set<string> | null>(null);
  const deafenedRef = useRef(false);
  deafenedRef.current = deafened;
  const displayName = readStore(PROFILE_NAME_KEY, 'Вы');
  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? channels[0];
  const channelMessages = messages.filter((message) => message.channelId === selectedId || (!message.channelId && selectedId === 'general'));
  const outboxCount = channelMessages.filter((message) => message.delivery === 'queued' || message.delivery === 'sent').length;
  const memberNames = useMemo(
    () => [...new Set([displayName, ...members.map((member) => member.name)].filter(Boolean))],
    [displayName, members],
  );
  const unreadTotal = useMemo(() => channels.reduce((sum, channel) => sum + channel.unreadCount, 0), [channels]);
  const replyToPreview = replyToId
    ? (() => {
        const raw = messages.find((message) => message.id === replyToId);
        return raw ? `${raw.author}: ${messagePreview(raw.content)}` : null;
      })()
    : null;
  const selectedVoice = voiceRooms.find((room) => room.id === selectedId);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const onVoiceSettings = () => {
      const mode = loadVoiceTalkMode();
      const key = loadPttKeyCode();
      setVoiceTalkMode(mode);
      setPttKeyCode(key);
      setVoiceOverlayEnabled(loadVoiceOverlayEnabled());
      setVoiceOverlayOpacity(loadVoiceOverlayOpacity());
      setVoiceOverlayInteractive(loadVoiceOverlayInteractive());
      if (activeVoice) applyEffectiveMicMute(userMutedRef.current, pttHeldRef.current, mode);
    };
    window.addEventListener('p2pchat-voice-settings', onVoiceSettings);
    return () => window.removeEventListener('p2pchat-voice-settings', onVoiceSettings);
  }, [activeVoice]);

  useEffect(() => {
    if (!activeVoice || voiceTalkMode !== 'ptt' || !isDesktopShell()) {
      if (isDesktopShell()) {
        void import('@tauri-apps/api/core').then(({ invoke }) => {
          void invoke('stop_ptt_watch').catch(() => {});
        });
      }
      setPttHeld(false);
      pttHeldRef.current = false;
      return;
    }
    const vk = pttVkForCode(pttKeyCode);
    let unlistenDown: (() => void) | undefined;
    let unlistenUp: (() => void) | undefined;
    let closed = false;

    const setHeld = (held: boolean) => {
      pttHeldRef.current = held;
      setPttHeld(held);
      applyEffectiveMicMute(userMutedRef.current, held, 'ptt');
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code !== pttKeyCodeRef.current || event.repeat) return;
      if (event.code === 'Mouse4' || event.code === 'Mouse5') return;
      event.preventDefault();
      setHeld(true);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code !== pttKeyCodeRef.current) return;
      event.preventDefault();
      setHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    void import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('start_ptt_watch', { vk }).catch(() => {});
    });
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen('ptt-down', () => {
        if (!closed) setHeld(true);
      }).then((fn) => {
        unlistenDown = fn;
      });
      void listen('ptt-up', () => {
        if (!closed) setHeld(false);
      }).then((fn) => {
        unlistenUp = fn;
      });
    });

    applyEffectiveMicMute(userMutedRef.current, false, 'ptt');

    return () => {
      closed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      unlistenDown?.();
      unlistenUp?.();
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void invoke('stop_ptt_watch').catch(() => {});
      });
    };
  }, [activeVoice, voiceTalkMode, pttKeyCode]);

  useEffect(() => {
    if (!activeVoice) return;
    if (voiceTalkMode === 'vad') {
      applyEffectiveMicMute(userMutedRef.current, true, 'vad');
    }
  }, [activeVoice, voiceTalkMode, muted]);

  useEffect(() => {
    if (!isDesktopShell()) return;
    const show = Boolean(activeVoice && voiceOverlayEnabled);
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      if (show) {
        void invoke('show_voice_overlay').catch(() => {});
        void invoke('focus_voice_overlay').catch(() => {});
      } else {
        void invoke('hide_voice_overlay').catch(() => {});
      }
    });
  }, [activeVoice, voiceOverlayEnabled]);

  useEffect(() => {
    if (!isDesktopShell() || !activeVoice || !voiceOverlayEnabled) return;
    const timer = window.setInterval(() => {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void invoke('focus_voice_overlay').catch(() => {});
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeVoice, voiceOverlayEnabled]);

  useEffect(() => {
    if (!activeVoice) {
      try {
        window.localStorage.removeItem(VOICE_OVERLAY_PAYLOAD_KEY);
      } catch {
        // ignore
      }
      return;
    }
    const room = voiceRooms.find((item) => item.id === activeVoice);
    const channelName = room?.name ?? 'Голос';
    const selfEffectiveMuted = effectiveMicMuted(muted, pttHeld, voiceTalkMode);
    // voiceParticipants already contains us — keep a single self row.
    const peers: VoiceOverlayPayload['peers'] = [
      {
        id: peerId,
        name: displayName,
        speaking: Boolean(speakingPeers[peerId]),
        muted: selfEffectiveMuted,
      },
      ...voicePeers
        .filter((peer) => peer.id !== peerId && peer.name !== displayName)
        .map((peer) => ({
          id: peer.id,
          name: peer.name,
          speaking: Boolean(speakingPeers[peer.id]),
          muted: Boolean(peerVoiceStates[peer.id]?.muted),
        })),
    ];
    const payload: VoiceOverlayPayload = {
      channelName,
      opacity: voiceOverlayOpacity,
      interactive: voiceOverlayInteractive,
      peers,
    };
    try {
      window.localStorage.setItem(VOICE_OVERLAY_PAYLOAD_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
    void import('@tauri-apps/api/event').then(({ emit }) => {
      void emit('voice-overlay-state', payload);
    });
  }, [activeVoice, voiceRooms, voicePeers, speakingPeers, peerVoiceStates, members, voiceOverlayOpacity, voiceOverlayInteractive, muted, pttHeld, voiceTalkMode, peerId, displayName]);

  useEffect(() => { writeStore(SERVER_KEY, server); }, [server]);
  useEffect(() => { writeStore(CHANNELS_KEY, channels); }, [channels]);
  useEffect(() => { writeStore(MESSAGES_KEY, messages); }, [messages]);
  useEffect(() => { writeStore(VOICE_KEY, voiceRooms); }, [voiceRooms]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (layoutDragRef.current === 'channel') {
        const next = Math.min(480, Math.max(200, event.clientX - 70));
        channelWidthRef.current = next;
        setChannelPaneWidth(next);
      } else if (layoutDragRef.current === 'member') {
        const next = Math.min(420, Math.max(180, window.innerWidth - event.clientX));
        memberWidthRef.current = next;
        setMemberPaneWidth(next);
      }
    };
    const onUp = () => {
      if (layoutDragRef.current === 'channel') saveChannelPaneWidth(channelWidthRef.current);
      if (layoutDragRef.current === 'member') saveMemberPaneWidth(memberWidthRef.current);
      layoutDragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const openPeerVolumeMenu = (event: ReactMouseEvent, peerId: string) => {
    setPeerVolumeMenu({ peerId, x: event.clientX, y: event.clientY });
  };
  const setPeerVolume = (id: string, value: number) => {
    setPeerVolumes((current) => ({ ...current, [id]: value }));
    voiceMeshRef.current?.setPeerVolume(id, value);
  };
  const peerVolumeMenuName =
    peerVolumeMenu
      ? voicePeers.find((peer) => peer.id === peerVolumeMenu.peerId)?.name ?? 'Участник'
      : '';

  useEffect(() => {
    if (!server.roomId || !server.inviteToken) {
      setLocation('/');
    }
  }, [server.roomId, server.inviteToken, setLocation]);

  useEffect(() => {
    if (!server.roomId || !server.inviteToken) {
      setConnectionStatus('offline');
      return;
    }
    refreshPatriotRankSalt();
    let closed = false;
    let closer: (() => void) | null = null;
    void openRoomSession({
      onInvite: (meta) => {
        if (closed) return;
        setServer((current) => ({ ...current, invite: meta.invite, inviteToken: meta.inviteToken, roomKey: meta.roomKey }));
        setToast('Приглашение обновлено — скопируйте свежую ссылку для друзей');
      },
      onView: (view) => {
        if (closed) return;
        setConnectionStatus(view.status);
        writeStore(CONNECTION_KEY, view.status);
        setIsCoordinator(view.isCoordinator);
        if (view.lastError && view.status !== 'connected') setConnectionError(view.lastError);
        if (view.status === 'connected') setConnectionError('');
        if (view.state) {
          const next = roomStateToClientState(view.state, peerId, server.invite);
          next.server.inviteToken = server.inviteToken;
          next.server.roomKey = server.roomKey;
          setServer((current) => ({
            ...current,
            ...next.server,
            invite: current.invite ?? next.server.invite,
            inviteToken: current.inviteToken ?? next.server.inviteToken,
            roomKey: current.roomKey ?? next.server.roomKey,
          }));
          setChannels((prev) => mergeChannelUnread(prev, next.channels as Channel[]));
          setVoiceRooms(next.voiceRooms);
          const nextMembers = view.state.members;
          if (knownMemberIdsRef.current === null) {
            knownMemberIdsRef.current = new Set(nextMembers.map((member) => member.id));
          } else if (!deafenedRef.current) {
            for (const member of nextMembers) {
              if (member.id === peerId) continue;
              if (!knownMemberIdsRef.current.has(member.id) && member.online) {
                playUiSound('member-join');
                triggerPatriotPopup();
              }
            }
            knownMemberIdsRef.current = new Set(nextMembers.map((member) => member.id));
          } else {
            knownMemberIdsRef.current = new Set(nextMembers.map((member) => member.id));
          }
          setMembers(nextMembers);
          if (voiceChannelRef.current) {
            setVoicePeers(view.state.voiceParticipants[voiceChannelRef.current] ?? []);
          }
        }
        const liveMessages: Message[] = view.messages.map((message) => ({
          id: message.id,
          author: message.author,
          authorId: message.authorId,
          avatar: avatarInitials(message.author),
          content: message.text ?? '🔒 не удалось расшифровать',
          timestamp: new Date(message.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          timestampIso: message.timestamp,
          isCurrentUser: message.authorId === peerId,
          channelId: message.channelId,
          delivery: message.delivery,
        }));
        const roomId = server.roomId ?? '';
        const cachedMessages: Message[] = loadCachedRoomMessages(roomId).map((entry) => ({
          id: entry.id,
          author: entry.author,
          authorId: entry.authorId,
          avatar: avatarInitials(entry.author),
          content: entry.text ?? '',
          timestamp: new Date(entry.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          timestampIso: entry.timestamp,
          isCurrentUser: entry.authorId === peerId,
          channelId: entry.channelId,
        }));
        const mappedMessages = mergeMessagesWithCache(liveMessages, cachedMessages);
        if (roomId) {
          cacheRoomMessages(
            roomId,
            liveMessages.map((item) => ({
              id: item.id,
              channelId: item.channelId ?? '',
              authorId: item.authorId ?? '',
              author: item.author,
              text: item.content.startsWith('🔒') ? null : item.content,
              timestamp: item.timestampIso ?? item.timestamp,
            })),
          );
        }
        const namesForMentions = [
          ...new Set([displayName, ...(view.state?.members ?? []).map((member) => member.name)]),
        ];
        if (knownMessageIdsRef.current !== null) {
          const unreadBumps = new Map<string, number>();
          for (const message of mappedMessages) {
            if (knownMessageIdsRef.current.has(message.id) || message.isCurrentUser) continue;
            const parsed = parseWireText(message.content);
            if (parsed.kind === 'react' || parsed.kind === 'edit' || parsed.kind === 'delete' || parsed.kind === 'pin' || parsed.kind === 'sfx' || parsed.kind === 'unknown') {
              continue;
            }
            const channelId = message.channelId ?? 'general';
            if (channelId === selectedIdRef.current) continue;
            unreadBumps.set(channelId, (unreadBumps.get(channelId) ?? 0) + 1);
          }
          if (unreadBumps.size > 0) {
            setChannels((current) =>
              current.map((channel) => {
                const add = unreadBumps.get(channel.id);
                return add ? { ...channel, unreadCount: channel.unreadCount + add } : channel;
              }),
            );
          }
        }
        if (knownMessageIdsRef.current === null) {
          knownMessageIdsRef.current = new Set(mappedMessages.map((message) => message.id));
        } else if (!deafenedRef.current) {
          for (const message of mappedMessages) {
            if (knownMessageIdsRef.current.has(message.id) || message.isCurrentUser) continue;
            const parsed = parseWireText(message.content);
            if (parsed.kind === 'react' || parsed.kind === 'edit' || parsed.kind === 'delete' || parsed.kind === 'pin' || parsed.kind === 'unknown') {
              continue;
            }
            const preview = messagePreview(message.content);
            void notifyDesktop('message', message.author, preview);
            if (parsed.kind === 'sfx') {
              if (isFunSoundId(parsed.id)) playFunSound(parsed.id);
            } else if (parsed.kind === 'text') {
              const selfName = displayName.trim().toLowerCase();
              const mentionedNames = [
                ...(parsed.mentions ?? []),
                ...extractMentions(parsed.body, namesForMentions),
              ];
              const isMentioned =
                Boolean(selfName) &&
                mentionedNames.some((name) => name.trim().toLowerCase() === selfName);
              if (isMentioned) {
                playUiSound('mention');
                void notifyDesktop('mention', message.author, preview);
              } else {
                playUiSound(parsed.file ? 'chat-text' : parsed.body ? 'chat-text' : 'chat-image');
              }
            } else if (parsed.kind === 'image') {
              playUiSound('chat-image');
            }
          }
          knownMessageIdsRef.current = new Set(mappedMessages.map((message) => message.id));
        } else {
          knownMessageIdsRef.current = new Set(mappedMessages.map((message) => message.id));
        }
        setMessages(mappedMessages);
      },
      onError: (message) => {
        if (!closed) setToast(message);
      },
      onVoice: (event) => {
        if (event.channelId !== voiceChannelRef.current) return;
        if (event.joined) {
          if (event.peerId !== peerId && !deafenedRef.current) {
            playUiSound('voice-join');
            void notifyDesktop('voice-join', event.displayName, 'Подключился к голосовому каналу');
          }
          if (event.peerId !== peerId) triggerPatriotPopup();
          void voiceMeshRef.current?.addPeer(event.peerId, peerId < event.peerId).catch((error) => {
            setToast(error instanceof Error ? error.message : 'Не удалось подключить голосовой канал');
          });
        } else {
          if (event.peerId !== peerId && !deafenedRef.current) {
            playUiSound('voice-leave');
            void notifyDesktop('voice-leave', event.displayName, 'Вышел из голосового канала');
          }
          if (event.peerId !== peerId) triggerPatriotPopup();
          voiceMeshRef.current?.removePeer(event.peerId);
        }
      },
      onSignal: (event) => {
        void voiceMeshRef.current?.handleSignal(event.fromPeerId, event.data).catch((error) => {
          setToast(error instanceof Error ? error.message : 'Ошибка голосового signaling');
        });
      },
    }).then((handles) => {
      if (closed) {
        handles?.close();
        return;
      }
      if (!handles) {
        setConnectionStatus('offline');
        return;
      }
      sessionRef.current = handles.session;
      closer = handles.close;
    });
    return () => {
      closed = true;
      closer?.();
      sessionRef.current = null;
      voiceMeshRef.current?.stop();
      voiceMeshRef.current = null;
      voiceChannelRef.current = null;
      knownMemberIdsRef.current = null;
      knownMessageIdsRef.current = null;
    };
  }, [server.roomId, server.inviteToken, peerId]);

  const sendMessage = () => {
    const body = draft.trim();
    if (!body) return;
    const mentions = extractMentions(body, memberNames);
    const payload = encodeRichMessage({
      body,
      replyTo: replyToId ?? undefined,
      mentions: mentions.length ? mentions : undefined,
    });
    if (!sendChatPayload(payload)) return;
    setDraft('');
    setReplyToId(null);
  };
  const sendChatPayload = (content: string) => {
    if (!sessionRef.current) {
      setToast('Переподключаемся к комнате…');
      return false;
    }
    if (!sessionRef.current.sendChat(selectedId, content)) {
      setToast('Сообщение слишком длинное или нет ключа комнаты');
      return false;
    }
    return true;
  };
  const sendFunSound = (id: FunSoundId) => {
    playFunSound(id);
    sendChatPayload(encodeSfx(id));
  };
  const onChatFilePick = async (file: File | undefined) => {
    if (!file) return;
    try {
      const isImage = file.type.startsWith('image/');
      if (isImage) {
        const dataUrl = await fileToChatImageDataUrl(file);
        if (sendChatPayload(`${IMAGE_MESSAGE_PREFIX}${dataUrl}`)) {
          setToast('Изображение отправлено');
          setReplyToId(null);
        }
        return;
      }
      const attachment = await fileToChatAttachment(file);
      const body = draft.trim();
      const mentions = extractMentions(body, memberNames);
      const payload = encodeRichMessage({
        body: body || attachment.name,
        replyTo: replyToId ?? undefined,
        mentions: mentions.length ? mentions : undefined,
        file: attachment,
      });
      if (sendChatPayload(payload)) {
        setDraft('');
        setReplyToId(null);
        setToast('Файл отправлен');
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не удалось обработать файл');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const onMessageReply = (id: string) => setReplyToId(id);
  const onMessageReact = (targetId: string, emoji: string) => {
    sendChatPayload(encodeReact(targetId, emoji));
  };
  const onMessageEdit = (targetId: string, body: string) => {
    sendChatPayload(encodeEdit(targetId, body));
  };
  const onMessageDelete = (targetId: string) => {
    sendChatPayload(encodeDelete(targetId));
  };
  const onMessagePin = (targetId: string, pinned: boolean) => {
    sendChatPayload(encodePin(targetId, pinned));
  };
  const messageListProps = {
    messages: channelMessages,
    memberNames,
    onReply: onMessageReply,
    onReact: onMessageReact,
    onEdit: onMessageEdit,
    onDelete: onMessageDelete,
    onPin: onMessagePin,
  };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } };
  const addChannel = (channelName: string, type: ChannelType) => {
    if (server.roomId) {
      if (!sessionRef.current?.createChannel(channelName, type)) {
        setToast('Нет соединения с комнатой');
        return;
      }
      setShowChannelDialog(false);
      setToast(`Создаём канал «${channelName}»`);
      return;
    }
    const id = uid(type);
    setChannels((current) => [...current, { id, name: channelName, type, unreadCount: 0, members: type === 'voice' ? 0 : 1 }]);
    if (type === 'voice') setVoiceRooms((current) => [...current, { id, name: channelName, participantCount: 0, state: 'ready', participants: [] }]);
    setSelectedId(id);
    setShowChannelDialog(false);
    setToast(`Канал «${channelName}» создан`);
  };
  const joinVoice = async (room: StoredVoice) => {
    if (server.roomId) {
      if (connectionStatus !== 'connected') {
        setToast('Нет соединения с комнатой');
        return;
      }
      try {
        const mesh = voiceMeshRef.current ?? new VoiceMesh(
          peerId,
          (toPeerId, data) => {
            sessionRef.current?.sendSignal(toPeerId, data);
          },
          {
            onPeerStatus: (_peerId, status, detail) => {
              setVoicePeerStatus(status);
              if (status === 'connecting') setVoiceHint(detail || 'Соединяем…');
              else if (status === 'connected') setVoiceHint('Голос подключен');
              else if (status === 'failed') {
                setShowMeteredHint(true);
                setVoiceHint(detail || 'Нет прямого пути — нужен TURN');
              } else setVoiceHint('');
            },
            onSpeaking: (id, speaking) => {
              setSpeakingPeers((current) => ({ ...current, [id]: speaking }));
            },
            onPeerVoiceState: (id, state) => {
              setPeerVoiceStates((current) => ({ ...current, [id]: state }));
            },
            onScreenShare: (id, stream) => {
              if (stream) {
                setScreenSharePeerId(id);
                setScreenShareStream(stream);
                setSharingScreen(id === peerId);
              } else {
                setScreenSharePeerId((current) => {
                  if (current !== id) return current;
                  setScreenShareStream(null);
                  setSharingScreen(false);
                  return null;
                });
              }
            },
          },
        );
        await mesh.start();
        mesh.hydratePeerVolumes(peerVolumes);
        const savedInput = loadAudioInputId();
        const savedOutput = loadAudioOutputId();
        if (savedInput) mesh.setInputDevice(savedInput);
        if (savedOutput) mesh.setOutputDevice(savedOutput);
        voiceMeshRef.current = mesh;
        voiceChannelRef.current = room.id;
        setVoiceHint('Соединяем…');
        setVoicePeerStatus('connecting');
        voiceMeshRef.current?.setMicVolume(micVolume);
        applyEffectiveMicMute(muted, pttHeldRef.current, voiceTalkModeRef.current);
        voiceMeshRef.current?.setDeafened(deafened);
        void voiceMeshRef.current?.setMicProcessing({ noiseSuppression, echoCancellation, enhancedNoise });
        sessionRef.current?.setVoiceChannel(room.id);
      } catch (error) {
        setToast(error instanceof Error ? error.message : 'Не удалось получить доступ к микрофону');
        return;
      }
    }
    setActiveVoice(room.id);
    setVoiceRooms((current) => current.map((item) => item.id === room.id ? { ...item, participantCount: item.participantCount + 1, state: 'live', participants: item.participants.includes(displayName) ? item.participants : [...item.participants, displayName] } : item));
    setToast(`Вы в комнате «${room.name}»`);
    triggerPatriotPopup();
  };
  const leaveVoice = () => {
    if (!activeVoice) return;
    triggerPatriotPopup();
    sessionRef.current?.setVoiceChannel(null);
    voiceMeshRef.current?.stop();
    voiceMeshRef.current = null;
    voiceChannelRef.current = null;
    setVoiceHint('');
    setVoicePeerStatus(null);
    setVoicePeers([]);
    setSpeakingPeers({});
    setPeerVoiceStates({});
    setSharingScreen(false);
    setScreenSharePeerId(null);
    setScreenShareStream(null);
    setPttHeld(false);
    pttHeldRef.current = false;
    if (isDesktopShell()) {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void invoke('stop_ptt_watch').catch(() => {});
        void invoke('hide_voice_overlay').catch(() => {});
      });
    }
    setVoiceRooms((current) => current.map((item) => item.id === activeVoice ? { ...item, participantCount: Math.max(0, item.participantCount - 1), participants: item.participants.filter((person) => person !== displayName), state: item.participantCount <= 1 ? 'ready' : 'live' } : item));
    setActiveVoice(null); setMuted(false); setDeafened(false); setToast('Вы вышли из голосовой комнаты');
  };

  const toggleScreenShare = async () => {
    const mesh = voiceMeshRef.current;
    if (!mesh || !activeVoice) {
      setToast('Сначала войдите в голосовую комнату');
      return;
    }
    try {
      if (mesh.isScreenSharing()) {
        await mesh.stopScreenShare();
        setToast('Демонстрация экрана остановлена');
      } else {
        await mesh.startScreenShare();
        setToast('Вы демонстрируете экран');
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не удалось поделиться экраном');
    }
  };

  useEffect(() => {
    const video = screenVideoRef.current;
    if (!video) return;
    video.srcObject = screenShareStream;
    if (screenShareStream) {
      void video.play().catch(() => {
        /* autoplay may need gesture; muted video usually ok */
      });
    }
  }, [screenShareStream]);

  useEffect(() => {
    if (!isDesktopShell()) return;
    const remoteSpeaking = Object.entries(speakingPeers).some(([id, speaking]) => speaking && id !== peerId);
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('set_tray_speaking', { speaking: remoteSpeaking });
    });
  }, [speakingPeers, peerId]);

  const screenShareLabel = (() => {
    if (!screenSharePeerId || !screenShareStream) return '';
    if (screenSharePeerId === peerId) return 'Вы демонстрируете экран';
    const peer = voicePeers.find((item) => item.id === screenSharePeerId);
    return peer ? `${peer.name} демонстрирует экран` : 'Демонстрация экрана';
  })();

  const selectChannel = (id: string) => {
    setSelectedId(id);
    setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, unreadCount: 0 } : channel));
  };
  const notify = (text: string) => setToast(text);
  const leaveServer = () => {
    leaveVoice();
    sessionRef.current?.stop();
    sessionRef.current = null;
    leaveCurrentRoom();
    writeStore(SERVER_KEY, seedServer);
    writeStore(CHANNELS_KEY, seedChannels);
    writeStore(MESSAGES_KEY, []);
    writeStore(VOICE_KEY, seedVoice);
    writeStore(CONNECTION_KEY, 'offline');
    setLocation('/');
  };
  const visibleMembers = members;
  const connectionHint = connectionError && connectionStatus !== 'connected'
    ? connectionError
    : statusLabel(connectionStatus);
  const needsPublicUrlBanner = isCoordinator && isDesktopShell() && !getPublicUrl();
  const voiceStatusLabel =
    voicePeerStatus === 'connected'
      ? 'Голос подключен'
      : voicePeerStatus === 'failed'
        ? voiceHint || 'Нет прямого пути / нужен TURN'
        : voiceHint || (activeVoice ? 'Соединяем…' : '');
  const shellStyle = {
    '--channel-pane-w': `${channelPaneWidth}px`,
    '--member-pane-w': `${memberPaneWidth}px`,
  } as CSSProperties;
  const theme = useAppTheme();
  const chatBgThemeSuffix = theme === 'patriot' ? ' theme-chat-bg--patriot' : theme === 'gachi' ? ' theme-chat-bg--gachi' : '';
  const chatAreaClassName = `chat-area theme-chat-bg${chatBgThemeSuffix}`;
  const voiceRoomLayoutClassName = `voice-room-layout theme-chat-bg${chatBgThemeSuffix}`;

  return <div className="noise workspace-shell" style={shellStyle}>
    <PatriotJoinPopup token={patriotPopupToken} />
    <WorkspaceNav unreadTotal={unreadTotal} onDiagnostics={() => setOverlay('diagnostics')} onSettings={() => setOverlay('settings')} />
    <ChannelPane
      server={server}
      channels={channels}
      voiceRooms={voiceRooms}
      selectedId={selectedId}
      onSelect={selectChannel}
      onAdd={() => setShowChannelDialog(true)}
      onInvite={() => setShowInviteDialog(true)}
      onLeaveServer={leaveServer}
      selfPeerId={peerId}
      selfDisplayName={displayName}
      selfMuted={effectiveMicMuted(muted, pttHeld, voiceTalkMode)}
      selfDeafened={deafened}
      activeVoiceChannelId={activeVoice}
      voicePeers={voicePeers}
      peerVoiceStates={peerVoiceStates}
      speakingPeers={speakingPeers}
      muted={muted}
      deafened={deafened}
      onMute={() => setMuted((value) => {
        const next = !value;
        applyEffectiveMicMute(next, pttHeldRef.current, voiceTalkModeRef.current);
        return next;
      })}
      onDeafen={() => setDeafened((value) => { const next = !value; voiceMeshRef.current?.setDeafened(next); return next; })}
      micVolume={micVolume}
      onMicVolume={(value) => { setMicVolume(value); voiceMeshRef.current?.setMicVolume(value); }}
      noiseSuppression={noiseSuppression}
      echoCancellation={echoCancellation}
      onToggleNoise={() => { const next = !noiseSuppression; setNoiseSuppression(next); void voiceMeshRef.current?.setMicProcessing({ noiseSuppression: next }); }}
      onToggleEcho={() => { const next = !echoCancellation; setEchoCancellation(next); void voiceMeshRef.current?.setMicProcessing({ echoCancellation: next }); }}
      enhancedNoise={enhancedNoise}
      onToggleEnhancedNoise={() => { const next = !enhancedNoise; setEnhancedNoise(next); void voiceMeshRef.current?.setMicProcessing({ enhancedNoise: next }); }}
      onLeaveVoice={activeVoice ? leaveVoice : undefined}
      onPeerContextMenu={openPeerVolumeMenu}
      onChannelResizeMouseDown={(event) => { event.preventDefault(); layoutDragRef.current = 'channel'; }}
    />
    <main className="content-pane">
      <header className="topbar">
        <div className="flex min-w-0 items-center gap-3"><button className="icon-btn mobile-channel-chip" aria-label="Открыть список каналов" data-testid="button-open-channels"><Menu size={18} /></button><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">{selectedChannel?.type === 'voice' ? <Volume2 size={16} /> : <Hash size={16} />}</div><div className="min-w-0"><h1 className="truncate font-display text-[16px] font-bold tracking-[-.03em]">{selectedChannel?.name ?? 'общий'}</h1><p className="topbar-subtitle truncate text-[10px] text-[hsl(var(--muted-foreground))]">{selectedChannel?.type === 'voice' ? 'Голосовая комната' : connectionHint}</p></div></div>
        <div className="flex items-center gap-2">
          <ConnectionStatusChips connectionStatus={connectionStatus} isCoordinator={isCoordinator} invite={server.invite} />
          <button
            type="button"
            className="icon-btn hidden sm:inline-flex"
            onClick={() => {
              setMemberPaneCollapsed((value) => {
                const next = !value;
                saveMemberPaneCollapsed(next);
                return next;
              });
            }}
            aria-label={memberPaneCollapsed ? 'Показать участников' : 'Свернуть участников'}
            data-testid="button-toggle-member-pane"
          >
            {memberPaneCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
          </button>
          <button className="ghost-btn hidden sm:inline-flex" onClick={() => setShowInviteDialog(true)} data-testid="button-top-invite"><UserPlus size={15} /> <span>Пригласить</span></button>
          <button className="icon-btn" onClick={() => setOverlay('diagnostics')} aria-label="Открыть диагностику" data-testid="button-open-diagnostics"><Activity size={17} /></button>
        </div>
      </header>
      {needsPublicUrlBanner && (
        <div className="mx-4 mt-3 rounded-xl border border-[hsl(var(--accent)/.45)] bg-[hsl(var(--accent)/.12)] px-4 py-3 text-sm" data-testid="banner-public-url">
          <div className="font-semibold">Авто-туннель не поднялся</div>
          <p className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">
            Desktop сам поднимает Cloudflare Quick Tunnel. Нажмите «Повторить» или задайте URL вручную в настройках.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="ghost-btn"
              onClick={() => {
                void restartPublicTunnel().then((info) => {
                  if (info?.publicOrigin) {
                    setPublicUrl(info.publicOrigin);
                    setToast('Публичный URL получен');
                  } else {
                    setToast(info?.tunnelError || 'Туннель не поднялся');
                  }
                });
              }}
              data-testid="button-banner-retry-tunnel"
            >
              Повторить туннель
            </button>
            <button className="ghost-btn" onClick={() => setOverlay('settings')} data-testid="button-banner-settings">Настройки</button>
          </div>
        </div>
      )}
      {selectedVoice ? (
        <div className={`flex min-h-0 flex-1 flex-col ${activeVoice === selectedVoice.id ? '' : 'items-center justify-center px-6 text-center'}`}>
          {(showMeteredHint || voicePeerStatus === 'failed') && (
            <div className="mx-4 mt-3 rounded-xl border border-[hsl(var(--accent)/.45)] bg-[hsl(var(--accent)/.12)] px-4 py-3 text-left text-sm" data-testid="banner-voice-turn">
              <div className="font-semibold">Голос через интернет не подключился</div>
              <p className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">
                Часто это NAT или firewall: нужен рабочий TURN. Бесплатный вариант —{' '}
                <a href="https://www.metered.ca/" target="_blank" rel="noreferrer" className="font-semibold text-[hsl(var(--primary))] underline">metered.ca</a>
                , API key в настройках Drift. {voiceHint && <span className="block mt-1 font-mono text-[10px]">{voiceHint}</span>}
              </p>
              <button type="button" className="ghost-btn mt-2" onClick={() => setOverlay('settings')} data-testid="button-voice-turn-settings">Открыть настройки</button>
            </div>
          )}
          <div className={`shrink-0 ${activeVoice === selectedVoice.id ? 'border-b border-[hsl(var(--border))] px-4 py-4 sm:px-6' : ''}`}>
            <div className={`flex flex-col gap-3 ${activeVoice === selectedVoice.id ? 'sm:flex-row sm:items-center sm:justify-between' : 'items-center'}`}>
              <div className={`flex items-center gap-3 ${activeVoice === selectedVoice.id ? '' : 'flex-col'}`}>
                <div className="relative grid h-16 w-16 place-items-center rounded-[22px] bg-[hsl(var(--primary)/.18)] text-[hsl(var(--secondary))] sm:h-14 sm:w-14">
                  <Volume2 size={activeVoice === selectedVoice.id ? 28 : 36} />
                  {activeVoice === selectedVoice.id && <span className="animate-pulse-dot absolute right-1 top-1 h-3 w-3 rounded-full bg-[hsl(var(--primary))]" />}
                </div>
                <div className={activeVoice === selectedVoice.id ? 'min-w-0 text-left' : 'text-center'}>
                  <p className="font-mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--muted-foreground))]">Голосовая комната</p>
                  <h2 className="font-display text-2xl font-bold tracking-[-.06em] sm:text-xl">{selectedVoice.name}</h2>
                  {activeVoice === selectedVoice.id && voiceStatusLabel && (
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]" data-testid="text-voice-status">{voiceStatusLabel}</p>
                  )}
                  {activeVoice !== selectedVoice.id && (
                    <p className="mt-2 max-w-sm text-sm leading-6 text-[hsl(var(--muted-foreground))]">Нажмите «войти», чтобы разрешить микрофон и подключиться по WebRTC.</p>
                  )}
                </div>
              </div>
              <div className={`flex flex-wrap items-center gap-3 ${activeVoice === selectedVoice.id ? '' : 'mt-4 flex-col'}`}>
                <button className="primary-btn" onClick={() => (activeVoice === selectedVoice.id ? leaveVoice() : void joinVoice(selectedVoice))} data-testid="button-main-voice-toggle">
                  {activeVoice === selectedVoice.id ? <><X size={16} /> Покинуть комнату</> : <><Radio size={16} /> Войти в комнату</>}
                </button>
                {activeVoice === selectedVoice.id && (
                  <button
                    className={`ghost-btn ${sharingScreen ? 'border-[hsl(var(--primary))] text-[hsl(var(--primary))]' : ''}`}
                    onClick={() => void toggleScreenShare()}
                    data-testid="button-screen-share"
                  >
                    {sharingScreen ? <><MonitorOff size={15} /> Стоп экран</> : <><Monitor size={15} /> Поделиться экраном</>}
                  </button>
                )}
                <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]"><Users size={14} /> {selectedVoice.participantCount} в комнате</div>
              </div>
            </div>
          </div>
          {activeVoice === selectedVoice.id && screenShareStream && (
            <ScreenShareStage
              label={screenShareLabel}
              sharingScreen={sharingScreen}
              onStopShare={() => void toggleScreenShare()}
              videoRef={screenVideoRef}
              videoMuted={screenSharePeerId === peerId}
            />
          )}
          {activeVoice === selectedVoice.id && (
            <div className={voiceRoomLayoutClassName}>
              <div className="message-scroll scrollbar-thin min-h-0 flex-1"><MessageList {...messageListProps} /></div>
              <ChatComposer
                draft={draft}
                memberNames={memberNames}
                onDraftChange={setDraft}
                onKeyDown={onComposerKeyDown}
                onSend={sendMessage}
                onPickFile={onChatFilePick}
                fileInputRef={fileInputRef}
                placeholder={`Написать в #${selectedVoice.name}...`}
                replyToLabel={replyToPreview}
                onClearReply={() => setReplyToId(null)}
                outboxCount={outboxCount}
                footerHint="end-to-end · голос + чат канала"
                fileInputTestId="input-voice-image-file"
                attachTestId="button-voice-image-attach"
                onPlayFunSound={sendFunSound}
              />
            </div>
          )}
        </div>
      ) : (
        <div className={chatAreaClassName}>
          <div className="message-scroll scrollbar-thin"><MessageList {...messageListProps} /></div>
          <ChatComposer
            draft={draft}
            memberNames={memberNames}
            onDraftChange={setDraft}
            onKeyDown={onComposerKeyDown}
            onSend={sendMessage}
            onPickFile={onChatFilePick}
            fileInputRef={fileInputRef}
            placeholder={`Написать в #${selectedChannel?.name ?? 'общий'}...`}
            replyToLabel={replyToPreview}
            onClearReply={() => setReplyToId(null)}
            outboxCount={outboxCount}
            footerHint={`end-to-end · ${isCoordinator ? 'вы координатор' : connectionHint}`}
            fileInputTestId="input-chat-image-file"
            attachTestId="button-add-attachment"
            onPlayFunSound={sendFunSound}
          />
        </div>
      )}
    </main>
    <aside className={`member-pane scrollbar-thin relative ${memberPaneCollapsed ? 'collapsed' : ''}`}>
      {!memberPaneCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину панели участников"
          className="panel-resizer panel-resizer-left"
          onMouseDown={(event) => { event.preventDefault(); layoutDragRef.current = 'member'; }}
          data-testid="resizer-member-pane"
        />
      )}
      <div className="mb-7"><div className="flex items-center justify-between"><span className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">Комната</span><span className="h-2 w-2 rounded-full bg-[hsl(var(--primary))]" /></div><div className="mt-4 flex items-center gap-2"><div className="grid h-8 w-8 place-items-center rounded-lg text-xs font-extrabold" style={avatarColors(server.name)}>{avatarInitials(server.name)}</div><div><div className="text-xs font-bold">{server.name}</div><div className="font-mono text-[9px] text-[hsl(var(--muted-foreground))]">координатор: {server.hostName}</div></div></div></div>
      <div className="mb-8"><div className="mb-3 flex items-center justify-between"><span className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">Участники</span><span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{server.memberCount}</span></div><div className="space-y-3">{visibleMembers.length === 0 ? <p className="text-xs text-[hsl(var(--muted-foreground))]">{connectionStatus === 'connected' ? 'Пока только вы' : 'Ждём подключения…'}</p> : visibleMembers.map((member, index) => <div className={`flex items-center gap-2 ${member.online ? '' : 'opacity-45'}`} key={member.id} data-testid={`member-${index}`}><div className="relative"><div className="member-avatar" style={avatarColors(member.name)}>{avatarInitials(member.name)}</div><span className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[hsl(var(--card))] ${member.online ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted-foreground))]'}`} /></div><span className="min-w-0 truncate text-xs font-semibold"><PatriotName name={member.name} seed={member.id} /></span>{member.name === server.hostName && <span className="ml-auto font-mono text-[8px] uppercase text-[hsl(var(--muted-foreground))]">координатор</span>}</div>)}</div><button className="mt-4 flex items-center gap-2 text-xs font-bold text-[hsl(var(--secondary))] transition hover:text-[hsl(var(--accent))]" onClick={() => setShowInviteDialog(true)} data-testid="button-member-invite"><Plus size={14} /> Ещё люди</button></div>
    </aside>
    {showChannelDialog && <CreateChannelDialog onClose={() => setShowChannelDialog(false)} onCreate={addChannel} />}
    {showInviteDialog && <InviteDialog server={server} onClose={() => setShowInviteDialog(false)} onNotify={notify} />}
    {overlay === 'diagnostics' && <div className="fixed inset-0 z-[80] overflow-auto bg-[hsl(var(--background))]"><Diagnostics onClose={() => setOverlay(null)} /></div>}
    {overlay === 'settings' && <div className="fixed inset-0 z-[80] overflow-auto bg-[hsl(var(--background))]"><SettingsPage onClose={() => setOverlay(null)} /></div>}
    {peerVolumeMenu && (
      <PeerVolumeContextMenu
        menu={peerVolumeMenu}
        peerName={peerVolumeMenuName}
        volume={peerVolumes[peerVolumeMenu.peerId] ?? 1}
        onVolume={setPeerVolume}
        onClose={() => setPeerVolumeMenu(null)}
      />
    )}
    {toast && <Toast text={toast} onClose={() => setToast('')} />}
  </div>;
}

function Diagnostics({ onClose }: { onClose?: () => void }) {
  const [, setLocation] = useLocation();
  const goBack = () => (onClose ? onClose() : setLocation('/server'));
  const [revealed, setRevealed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState('только что');
  const [logTick, setLogTick] = useState(0);
  const [logAction, setLogAction] = useState('');
  const [natBusy, setNatBusy] = useState(false);
  const [natSummary, setNatSummary] = useState(() => getLastVoiceNatReport()?.summary ?? '');
  const server = readStore<Server>(SERVER_KEY, seedServer);
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
    ['ICE / TURN', iceLabel, customTurn ? 'Кастомный relay из настроек.' : iceFlags.meteredConfigured ? `Metered (${iceFlags.meteredAppName || 'app'}), source=${iceFlags.iceSource}.` : 'Нет Metered key — в разных NAT голос часто молчит. Ключ в настройках сети.'],
    ['Публичный URL', publicUrl ? 'Авто/задан' : 'Нет', publicUrl ? publicUrl : 'Туннель не поднялся — повторите в настройках.'],
    ['Переезд координатора', 'Защищён', 'При уходе хоста пиры идут на endpoints преемника (сначала публичный URL).'],
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
  return <div className="noise min-h-[100dvh] app-grid" style={{ background: 'hsl(var(--background))' }}>
    <header className="flex h-[76px] items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card)/.72)] px-5 backdrop-blur-md sm:px-10"><Link href="/server" className="flex items-center gap-3" data-testid="link-diagnostics-back" onClick={(event) => { if (onClose) { event.preventDefault(); onClose(); } }}><div className="server-mark" style={{ width: 35, height: 35, borderRadius: 10 }}><Signal size={17} /></div><BrandName className="text-lg" /></Link><button className="ghost-btn" onClick={goBack} data-testid="button-back-to-server"><ArrowRight size={15} className="rotate-180" /> Вернуться в комнату</button></header>
    <main className="mx-auto max-w-[900px] px-5 py-12 sm:px-10 sm:py-16">
       <div className="max-w-[650px] animate-rise"><div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[hsl(var(--primary)/.15)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.15em] text-[hsl(var(--secondary))]"><ShieldCheck size={13} /> Состояние комнаты</div><h1 className="font-display text-5xl font-bold tracking-[-.08em] sm:text-7xl">Связь,<br /><span style={{ color: 'hsl(var(--accent))' }}>которая держится.</span></h1><p className="mt-6 max-w-[570px] text-[15px] leading-7 text-[hsl(var(--muted-foreground))]">Control plane (чат + signaling) и медиа (WebRTC + TURN) — разные пути. Здесь видно оба слоя.</p></div>
      <section className="mt-12 grid gap-3 sm:grid-cols-3">
         <div className="metric-card animate-rise stagger-1"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Signaling</span><Wifi size={16} className="text-[hsl(var(--primary))]" /></div><div className="mt-4 font-display text-2xl font-bold">{connectionLabel}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">WebSocket control plane</div></div>
        <div className="metric-card animate-rise stagger-2"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">TURN</span><Zap size={16} className="text-[hsl(var(--accent))]" /></div><div className="mt-4 font-display text-2xl font-bold">{turnOk ? 'Да' : 'Нет'}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{turnOk ? 'relay готов' : 'нужен для интернета'}</div></div>
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

function PttKeyCaptureButton({ onCapture }: { onCapture: (code: PttKeyCode) => void }) {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Mouse4' || event.code === 'Mouse5') return;
      const known = PTT_KEY_OPTIONS.some((item) => item.code === event.code);
      if (!known) return;
      onCapture(event.code);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, onCapture]);
  return (
    <button
      type="button"
      className="ghost-btn mt-2 w-full text-xs"
      onClick={() => setCapturing(true)}
      data-testid="button-capture-ptt-key"
    >
      {capturing ? 'Нажмите клавишу…' : 'Нажмите клавишу…'}
    </button>
  );
}

type SettingsSectionId = 'appearance' | 'devices' | 'voice' | 'sounds' | 'app' | 'network' | 'advanced';

function SettingsSection({
  id,
  title,
  hint,
  open,
  onToggle,
  children,
  testId,
}: {
  id: SettingsSectionId;
  title: string;
  hint?: string;
  open: boolean;
  onToggle: (id: SettingsSectionId) => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-[hsl(var(--border))]" data-testid={testId}>
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 px-4 py-3.5 text-left transition hover:bg-[hsl(var(--muted)/.35)]"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <span className="min-w-0">
          <span className="block text-sm font-bold">{title}</span>
          {hint && <span className="mt-0.5 block text-xs text-[hsl(var(--muted-foreground))]">{hint}</span>}
        </span>
        <ChevronDown size={18} className={`mt-0.5 shrink-0 text-[hsl(var(--muted-foreground))] transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-[hsl(var(--border))] px-4 py-4">{children}</div>}
    </div>
  );
}

function SettingsPage({ onClose }: { onClose?: () => void }) {
  const [, setLocation] = useLocation();
  const goBack = () => (onClose ? onClose() : setLocation('/server'));
  const ice = loadIceSettings();
  const [publicUrl, setPublicUrlDraft] = useState(getPublicUrl());
  const [bootstrap, setBootstrap] = useState(getBootstrapOrigin());
  const [turnUrls, setTurnUrls] = useState(ice.turn?.urls ?? '');
  const [turnUser, setTurnUser] = useState(ice.turn?.username ?? '');
  const [turnCred, setTurnCred] = useState(ice.turn?.credential ?? '');
  const [meteredKey, setMeteredKey] = useState(ice.meteredApiKey ?? '');
  const [meteredApp, setMeteredApp] = useState(ice.meteredAppName ?? '');
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelMsg, setTunnelMsg] = useState('');
  const [saved, setSaved] = useState('');
  const [openSection, setOpenSection] = useState<SettingsSectionId | null>('appearance');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [autostartEnabled, setAutostartEnabledState] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [themeId, setThemeId] = useState<AppThemeId>(() => loadTheme());
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [audioInputId, setAudioInputId] = useState(() => loadAudioInputId());
  const [audioOutputId, setAudioOutputId] = useState(() => loadAudioOutputId());
  const [uiSoundsEnabled, setUiSoundsEnabled] = useState(() => loadUiSoundsEnabled());
  const [startupSoundId, setStartupSoundId] = useState<StartupSoundId>(() => loadStartupSoundId());
  const [voiceTalkMode, setVoiceTalkMode] = useState<VoiceTalkMode>(() => loadVoiceTalkMode());
  const [pttKeyCode, setPttKeyCode] = useState<PttKeyCode>(() => loadPttKeyCode());
  const [voiceOverlayEnabled, setVoiceOverlayEnabled] = useState(() => loadVoiceOverlayEnabled());
  const [voiceOverlayOpacity, setVoiceOverlayOpacity] = useState(() => loadVoiceOverlayOpacity());
  const [voiceOverlayInteractive, setVoiceOverlayInteractive] = useState(() => loadVoiceOverlayInteractive());
  const [updateProgress, setUpdateProgress] = useState<{ loaded: number; total: number | null; phase: string } | null>(null);
  const [tunnelProvider, setTunnelProvider] = useState<TunnelProviderId>(() => loadTunnelProvider());
  const [ngrokToken, setNgrokToken] = useState(() => loadNgrokAuthToken());
  const [zrokToken, setZrokToken] = useState(() => loadZrokToken());

  const toggleSection = (id: SettingsSectionId) => {
    setOpenSection((current) => (current === id ? null : id));
  };

  const pushOverlayPayloadPatch = (patch: Partial<VoiceOverlayPayload>) => {
    try {
      const raw = window.localStorage.getItem(VOICE_OVERLAY_PAYLOAD_KEY);
      const base: VoiceOverlayPayload = raw
        ? (JSON.parse(raw) as VoiceOverlayPayload)
        : { channelName: 'Голос', opacity: loadVoiceOverlayOpacity(), interactive: loadVoiceOverlayInteractive(), peers: [] };
      const next = { ...base, ...patch };
      window.localStorage.setItem(VOICE_OVERLAY_PAYLOAD_KEY, JSON.stringify(next));
      void import('@tauri-apps/api/event').then(({ emit }) => {
        void emit('voice-overlay-state', next);
      });
    } catch {
      // ignore
    }
    window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
    window.dispatchEvent(new CustomEvent('p2pchat-voice-overlay-push'));
  };

  useEffect(() => {
    void currentAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    void getAutostartEnabled().then(setAutostartEnabledState);
  }, []);

  useEffect(() => {
    void warmIceServers();
  }, []);

  useEffect(() => {
    void listAudioDevices().then(({ inputs, outputs }) => {
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
    });
  }, []);

  const retryTunnel = async () => {
    setTunnelBusy(true);
    setTunnelMsg('');
    saveTunnelProvider(tunnelProvider);
    saveNgrokAuthToken(ngrokToken);
    saveZrokToken(zrokToken);
    try {
      const info = await restartPublicTunnel();
      if (info?.publicOrigin) {
        setPublicUrlDraft(info.publicOrigin);
        setPublicUrl(info.publicOrigin);
        const next = await refreshCoordinatorInvite();
        if (next) {
          writeStore(SERVER_KEY, { ...readStore(SERVER_KEY, seedServer), invite: next.invite });
        }
        setTunnelMsg(`Туннель (${tunnelProvider}): ${info.publicOrigin}. Скопируйте новое приглашение.`);
      } else {
        setTunnelMsg(info?.tunnelError || 'Не удалось поднять туннель');
      }
    } finally {
      setTunnelBusy(false);
    }
  };

  const checkUpdates = async () => {
    setUpdateBusy(true);
    setUpdateMsg('');
    try {
      const info = await checkForAppUpdate();
      setUpdateInfo(info);
      if (info.upToDate) setUpdateMsg(`У вас актуальная версия ${info.currentVersion}`);
      else setUpdateMsg(`Доступна ${info.latestVersion} (сейчас ${info.currentVersion})`);
    } catch (error) {
      setUpdateMsg(error instanceof Error ? error.message : 'Не удалось проверить обновления');
    } finally {
      setUpdateBusy(false);
    }
  };

  const installUpdate = async () => {
    if (!updateInfo) return;
    if (!isDesktopShell() || !updateInfo.downloadUrl) {
      window.open(updateInfo.releaseUrl, '_blank');
      return;
    }
    setUpdateBusy(true);
    setUpdateProgress({ loaded: 0, total: null, phase: 'download' });
    setUpdateMsg(`Скачиваем Drift ${updateInfo.latestVersion}… Приложение закроется. Подтвердите запрос Windows (администратор) — иначе файлы в Program Files не заменятся.`);
    try {
      await installAppUpdate(updateInfo.downloadUrl, (loaded, total, phase) => {
        setUpdateProgress({ loaded, total, phase });
      });
    } catch (error) {
      setUpdateMsg(error instanceof Error ? error.message : String(error));
      setUpdateBusy(false);
      setUpdateProgress(null);
    }
  };

  const updateProgressPercent =
    updateProgress?.total && updateProgress.total > 0
      ? Math.min(100, Math.round((updateProgress.loaded / updateProgress.total) * 100))
      : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (publicUrl.trim()) setPublicUrl(publicUrl.trim(), { manual: true });
    else setPublicUrl('');
    setBootstrapOrigin(bootstrap.trim());
    saveIceSettings({
      turn: turnUrls.trim()
        ? { urls: turnUrls.trim(), username: turnUser.trim(), credential: turnCred.trim() }
        : null,
      meteredApiKey: meteredKey.trim() || null,
      meteredAppName: meteredApp.trim() || null,
    });
    saveTunnelProvider(tunnelProvider);
    saveNgrokAuthToken(ngrokToken);
    saveZrokToken(zrokToken);
    void warmIceServers();
    void refreshCoordinatorInvite().then((next) => {
      if (next) {
        writeStore(SERVER_KEY, { ...readStore(SERVER_KEY, seedServer), invite: next.invite });
      }
    });
    setSaved('Сохранено. Если вы хост — скопируйте новое приглашение друзьям.');
  };

  return (
    <div className="noise relative min-h-[100dvh] app-grid" style={{ background: 'hsl(var(--background))' }}>
      {updateProgress && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[hsl(var(--background)/.85)] backdrop-blur-sm" data-testid="overlay-update-progress">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl">
            <div className="text-sm font-bold">Обновление Drift</div>
            <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
              {updateProgress.phase === 'install' ? 'Запуск установщика…' : 'Скачивание…'} Не закрывайте окно.
            </p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
              <div
                className="h-full bg-[hsl(var(--primary))] transition-all duration-200"
                style={{ width: `${updateProgressPercent ?? (updateProgress.loaded > 0 ? 8 : 0)}%` }}
              />
            </div>
            <p className="mt-2 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
              {updateProgressPercent !== null
                ? `${updateProgressPercent}%`
                : updateProgress.loaded > 0
                  ? `${Math.round(updateProgress.loaded / 1024 / 1024)} МБ`
                  : 'Подготовка…'}
            </p>
          </div>
        </div>
      )}
      <header className="flex h-[76px] items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card)/.72)] px-5 backdrop-blur-md sm:px-10">
        <Link href="/server" className="flex items-center gap-3" data-testid="link-settings-back" onClick={(event) => { if (onClose) { event.preventDefault(); onClose(); } }}>
          <div className="server-mark" style={{ width: 35, height: 35, borderRadius: 10 }}><Signal size={17} /></div>
          <BrandName className="text-lg" />
        </Link>
        <button className="ghost-btn" onClick={goBack} data-testid="button-settings-back"><ArrowRight size={15} className="rotate-180" /> В комнату</button>
      </header>
      <main className="mx-auto max-w-[640px] px-5 py-10 sm:px-10">
        <h1 className="font-display text-4xl font-bold tracking-[-.06em]">Настройки</h1>
        <p className="mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          Разделы ниже — раскройте нужный. Крестик окна сворачивает в трей; полный выход: ПКМ по иконке → Выход.
        </p>

        <div className="mt-6">
          <SettingsSection id="appearance" title="Внешний вид" hint="Тема интерфейса" open={openSection === 'appearance'} onToggle={toggleSection} testId="settings-section-appearance">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {APP_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-left text-xs font-semibold transition ${themeId === theme.id ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.12)]' : 'border-[hsl(var(--border))]'}`}
                  onClick={() => {
                    setThemeId(theme.id);
                    saveTheme(theme.id);
                  }}
                  data-testid={`button-theme-${theme.id}`}
                >
                  {theme.label}
                  {theme.id === 'patriot' && (
                    <span className="mt-1 flex items-center gap-1.5 text-[10px] font-normal text-[hsl(var(--muted-foreground))]">
                      <span className="patriot-flag-bars" aria-hidden />
                      флаг · звания
                    </span>
                  )}
                </button>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection id="devices" title="Микрофон и динамики" hint="Устройства ввода/вывода" open={openSection === 'devices'} onToggle={toggleSection} testId="settings-section-devices">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Применяются при следующем входе в голос (или перезайдите в комнату).</p>
            <label className="field-label mt-3" htmlFor="audio-input">Вход (микрофон)</label>
            <select
              id="audio-input"
              className="field-input"
              value={audioInputId}
              onChange={(event) => {
                const id = event.target.value;
                setAudioInputId(id);
                saveAudioInputId(id);
              }}
              data-testid="select-audio-input"
            >
              <option value="">Системный по умолчанию</option>
              {audioInputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${device.deviceId.slice(0, 8)}`}</option>
              ))}
            </select>
            <label className="field-label mt-3" htmlFor="audio-output">Выход (динамики)</label>
            <select
              id="audio-output"
              className="field-input"
              value={audioOutputId}
              onChange={(event) => {
                const id = event.target.value;
                setAudioOutputId(id);
                saveAudioOutputId(id);
              }}
              data-testid="select-audio-output"
            >
              <option value="">Системный по умолчанию</option>
              {audioOutputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label || `Выход ${device.deviceId.slice(0, 8)}`}</option>
              ))}
            </select>
          </SettingsSection>

          <SettingsSection id="voice" title="Голос и оверлей" hint="PTT и мини-войс поверх игр" open={openSection === 'voice'} onToggle={toggleSection} testId="settings-section-voice">
            <label className="field-label" htmlFor="voice-mode">Режим</label>
            <select
              id="voice-mode"
              className="field-input"
              value={voiceTalkMode}
              onChange={(event) => {
                const mode = event.target.value === 'ptt' ? 'ptt' : 'vad';
                setVoiceTalkMode(mode);
                saveVoiceTalkMode(mode);
                window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
              }}
              data-testid="select-voice-mode"
            >
              <option value="vad">Активация голосом (по умолчанию)</option>
              <option value="ptt">По нажатию клавиши (PTT)</option>
            </select>
            {voiceTalkMode === 'ptt' && (
              <>
                <label className="field-label mt-3" htmlFor="ptt-key">Клавиша PTT</label>
                <select
                  id="ptt-key"
                  className="field-input"
                  value={pttKeyCode}
                  onChange={(event) => {
                    const code = event.target.value;
                    setPttKeyCode(code);
                    savePttKeyCode(code);
                    if (isDesktopShell()) {
                      void import('@tauri-apps/api/core').then(({ invoke }) => {
                        void invoke('set_ptt_vk', { vk: pttVkForCode(code) }).catch(() => {});
                      });
                    }
                    window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
                  }}
                  data-testid="select-ptt-key"
                >
                  {PTT_KEY_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
                <PttKeyCaptureButton
                  onCapture={(code) => {
                    setPttKeyCode(code);
                    savePttKeyCode(code);
                    if (isDesktopShell()) {
                      void import('@tauri-apps/api/core').then(({ invoke }) => {
                        void invoke('set_ptt_vk', { vk: pttVkForCode(code) }).catch(() => {});
                      });
                    }
                    window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
                  }}
                />
              </>
            )}
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-[hsl(var(--border))] p-3">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={voiceOverlayEnabled}
                disabled={!isDesktopShell()}
                onChange={(event) => {
                  const next = event.target.checked;
                  setVoiceOverlayEnabled(next);
                  saveVoiceOverlayEnabled(next);
                  if (isDesktopShell()) {
                    void import('@tauri-apps/api/core').then(({ invoke }) => {
                      if (!next) void invoke('hide_voice_overlay').catch(() => {});
                    });
                  }
                  window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
                }}
                data-testid="checkbox-voice-overlay"
              />
              <span>
                <span className="block text-xs font-bold">Мини-войс оверлей</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
                  Поверх игр (оконный / borderless): кто в канале и кто говорит.
                </span>
              </span>
            </label>
            {voiceOverlayEnabled && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="field-label" htmlFor="overlay-opacity">
                    Прозрачность оверлея · {Math.round(voiceOverlayOpacity * 100)}%
                  </label>
                  <input
                    id="overlay-opacity"
                    type="range"
                    min={15}
                    max={100}
                    value={Math.round(voiceOverlayOpacity * 100)}
                    onChange={(event) => {
                      const next = Number(event.target.value) / 100;
                      setVoiceOverlayOpacity(next);
                      saveVoiceOverlayOpacity(next);
                      pushOverlayPayloadPatch({ opacity: next });
                    }}
                    className="w-full"
                    data-testid="range-overlay-opacity"
                  />
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[hsl(var(--border))] p-3">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={voiceOverlayInteractive}
                    disabled={!isDesktopShell()}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setVoiceOverlayInteractive(next);
                      saveVoiceOverlayInteractive(next);
                      pushOverlayPayloadPatch({ interactive: next });
                    }}
                    data-testid="checkbox-voice-overlay-interactive"
                  />
                  <span>
                    <span className="block text-xs font-bold">Поменять расположение</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
                      Вкл — можно перетаскивать оверлей. Выкл — клики проходят сквозь него к игре/кнопкам под ним.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </SettingsSection>

          <SettingsSection id="sounds" title="Звуки" hint="События и звук запуска" open={openSection === 'sounds'} onToggle={toggleSection} testId="settings-section-sounds">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[hsl(var(--border))] p-3">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={uiSoundsEnabled}
                onChange={(event) => {
                  const next = event.target.checked;
                  setUiSoundsEnabled(next);
                  saveUiSoundsEnabled(next);
                  if (next) playUiSound('chat-text');
                }}
                data-testid="checkbox-ui-sounds"
              />
              <span>
                <span className="block text-xs font-bold">Звуки событий</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
                  Вход на сервер, голос, чат (не свои действия). Не играют при «звук выкл».
                </span>
              </span>
            </label>
            <div className="mt-4 rounded-lg border border-[hsl(var(--border))] p-3" data-testid="startup-sound-picker">
              <div className="text-xs font-bold">Звук запуска Drift</div>
              <p className="mt-1 text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">Три варианта ~2 с. «Слушать» — превью.</p>
              <div className="mt-3 space-y-2">
                {STARTUP_SOUND_OPTIONS.map((option) => {
                  const selected = startupSoundId === option.id;
                  return (
                    <div key={option.id} className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${selected ? 'border-[hsl(var(--primary)/.55)] bg-[hsl(var(--primary)/.08)]' : 'border-[hsl(var(--border))]'}`}>
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setStartupSoundId(option.id);
                          saveStartupSoundId(option.id);
                        }}
                        data-testid={`button-select-startup-${option.id}`}
                      >
                        <span className="block text-xs font-bold">{option.label}{selected ? ' · выбран' : ''}</span>
                        <span className="mt-0.5 block text-[10px] text-[hsl(var(--muted-foreground))]">{option.hint}</span>
                      </button>
                      <button
                        type="button"
                        className="ghost-btn !h-8 shrink-0 !px-2.5 text-[10px]"
                        onClick={() => {
                          setStartupSoundId(option.id);
                          saveStartupSoundId(option.id);
                          previewStartupSound(option.id);
                        }}
                        data-testid={`button-preview-startup-${option.id}`}
                      >
                        Слушать
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="app" title="Приложение" hint="Автозапуск и обновления" open={openSection === 'app'} onToggle={toggleSection} testId="settings-section-app">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-bold">Автозапуск с Windows</div>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Запускать Drift при входе в систему.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autostartEnabled}
                className={`relative h-7 w-12 shrink-0 rounded-full transition ${autostartEnabled ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted))]'}`}
                disabled={autostartBusy || !isDesktopShell()}
                onClick={() => {
                  const next = !autostartEnabled;
                  setAutostartBusy(true);
                  void setAutostartEnabled(next)
                    .then((ok) => {
                      setAutostartEnabledState(ok);
                      setSaved(next ? 'Автозапуск включён' : 'Автозапуск выключен');
                    })
                    .catch((error) => setSaved(error instanceof Error ? error.message : 'Не удалось изменить автозапуск'))
                    .finally(() => setAutostartBusy(false));
                }}
                data-testid="toggle-autostart"
              >
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${autostartEnabled ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
            <div className="mt-5 border-t border-[hsl(var(--border))] pt-4">
              <div className="text-sm font-bold">Обновления</div>
              <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Drift {appVersion} · ASMAXI · GitHub ASMAXI/p2pchat</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="primary-btn" disabled={updateBusy} onClick={() => void checkUpdates()} data-testid="button-check-updates">
                  {updateBusy ? 'Подождите…' : 'Проверить обновления'}
                </button>
                {updateInfo && !updateInfo.upToDate && (
                  <button type="button" className="ghost-btn" disabled={updateBusy} onClick={() => void installUpdate()} data-testid="button-download-update">
                    {updateInfo.downloadUrl && isDesktopShell() ? `Обновить до ${updateInfo.latestVersion}` : 'Открыть страницу релиза'}
                  </button>
                )}
              </div>
              {updateMsg && <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]" data-testid="text-update-status">{updateMsg}</p>}
            </div>
          </SettingsSection>

          <SettingsSection id="network" title="Сеть и туннель" hint="Cloudflare / ngrok / localhost.run" open={openSection === 'network'} onToggle={toggleSection} testId="settings-section-network">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              Чат и signaling — через туннель. Голос — отдельно (TURN/Metered).
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {TUNNEL_PROVIDER_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
                    tunnelProvider === opt.id
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.08)]'
                      : 'border-[hsl(var(--border))]'
                  }`}
                >
                  <input
                    type="radio"
                    name="tunnel-provider"
                    className="mt-1"
                    checked={tunnelProvider === opt.id}
                    onChange={() => {
                      setTunnelProvider(opt.id);
                      saveTunnelProvider(opt.id);
                    }}
                    data-testid={`radio-tunnel-${opt.id}`}
                  />
                  <span>
                    <span className="font-semibold">{opt.label}</span>
                    <span className="mt-0.5 block text-xs text-[hsl(var(--muted-foreground))]">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {tunnelProvider === 'ngrok' && (
              <div className="mt-3">
                <label className="field-label" htmlFor="ngrok-token">ngrok Authtoken</label>
                <input
                  id="ngrok-token"
                  className="field-input"
                  value={ngrokToken}
                  onChange={(e) => {
                    setNgrokToken(e.target.value);
                    saveNgrokAuthToken(e.target.value);
                  }}
                  placeholder="из dashboard.ngrok.com → Your Authtoken"
                  data-testid="input-ngrok-token"
                />
              </div>
            )}
            {tunnelProvider === 'zrok' && (
              <div className="mt-3">
                <label className="field-label" htmlFor="zrok-token">zrok account token</label>
                <input
                  id="zrok-token"
                  className="field-input"
                  value={zrokToken}
                  onChange={(e) => {
                    setZrokToken(e.target.value);
                    saveZrokToken(e.target.value);
                  }}
                  placeholder="из zrok.io → Enable Your Environment"
                  data-testid="input-zrok-token"
                />
              </div>
            )}
            <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
              Текущий URL: {publicUrl || 'ещё нет — создайте комнату или нажмите «Поднять»'}
            </p>
            <button type="button" className="primary-btn mt-3" disabled={tunnelBusy || !isDesktopShell()} onClick={() => void retryTunnel()} data-testid="button-retry-tunnel">
              {tunnelBusy ? 'Поднимаем…' : 'Поднять / обновить туннель'}
            </button>
            {tunnelMsg && <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]" data-testid="text-tunnel-status">{tunnelMsg}</p>}
          </SettingsSection>

          <SettingsSection id="advanced" title="Расширенные" hint="TURN / Metered / URL вручную" open={openSection === 'advanced'} onToggle={toggleSection} testId="settings-section-advanced">
            <form className="space-y-4" onSubmit={save} data-testid="form-network-settings">
              <div>
                <label className="field-label" htmlFor="public-url">Публичный URL вручную</label>
                <input id="public-url" className="field-input" value={publicUrl} onChange={(e) => setPublicUrlDraft(e.target.value)} placeholder="https://….trycloudflare.com" data-testid="input-public-url" />
              </div>
              <div>
                <label className="field-label" htmlFor="bootstrap-url">Bootstrap / sync URL</label>
                <input id="bootstrap-url" className="field-input" value={bootstrap} onChange={(e) => setBootstrap(e.target.value)} placeholder="опционально" data-testid="input-bootstrap-url" />
              </div>
              <div className="rounded-xl border border-[hsl(var(--border))] p-4">
                <div className="text-sm font-bold">Голос через интернет (TURN)</div>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  В разных сетях без TURN голос не поднимется. Metered API key или свой coturn.
                </p>
                <label className="field-label mt-3" htmlFor="metered-key">Metered API key</label>
                <input id="metered-key" className="field-input" value={meteredKey} onChange={(e) => setMeteredKey(e.target.value)} placeholder="из dashboard Metered" data-testid="input-metered-key" />
                <label className="field-label mt-3" htmlFor="metered-app">Metered app name</label>
                <input id="metered-app" className="field-input" value={meteredApp} onChange={(e) => setMeteredApp(e.target.value)} placeholder="имя приложения в Metered" data-testid="input-metered-app" />
              </div>
              <div className="rounded-xl border border-[hsl(var(--border))] p-4">
                <div className="text-sm font-bold">Свой TURN (VPS / coturn)</div>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Если заполнено — имеет приоритет над Metered.</p>
                <label className="field-label mt-3" htmlFor="turn-urls">TURN URL</label>
                <input id="turn-urls" className="field-input" value={turnUrls} onChange={(e) => setTurnUrls(e.target.value)} placeholder="turn:your-vps:3478" data-testid="input-turn-urls" />
                <label className="field-label mt-3" htmlFor="turn-user">Username</label>
                <input id="turn-user" className="field-input" value={turnUser} onChange={(e) => setTurnUser(e.target.value)} data-testid="input-turn-user" />
                <label className="field-label mt-3" htmlFor="turn-cred">Credential</label>
                <input id="turn-cred" className="field-input" type="password" value={turnCred} onChange={(e) => setTurnCred(e.target.value)} data-testid="input-turn-cred" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" className="primary-btn" data-testid="button-save-settings">Сохранить сеть</button>
                {saved && <p className="text-xs text-[hsl(var(--primary))]" data-testid="text-settings-saved">{saved}</p>}
              </div>
            </form>
          </SettingsSection>
        </div>
      </main>
    </div>
  );
}

function voiceOverlayRouteActive(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('voiceOverlay') === '1') return true;
  } catch {
    // ignore
  }
  if ((window.location.hash || '').includes('voice-overlay')) return true;
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  return path.endsWith('/voice-overlay');
}

function Router() {
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (voiceOverlayRouteActive()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void installInviteDeepLinkHandler((url) => {
      if (cancelled) return;
      emitPendingInvite(url);
      setLocation('/');
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setLocation]);

  if (voiceOverlayRouteActive()) {
    return (
      <ErrorBoundary resetKey={location}>
        <VoiceOverlayPage />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary resetKey={location}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/server" component={Workspace} />
        <Route path="/diagnostics">{() => <Diagnostics />}</Route>
        <Route path="/settings">{() => <SettingsPage />}</Route>
        <Route path="/voice-overlay">{() => <VoiceOverlayPage />}</Route>
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  const overlayShell = voiceOverlayRouteActive();
  const router = (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Router />
    </WouterRouter>
  );
  if (overlayShell) {
    return router;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {router}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;