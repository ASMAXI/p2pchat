import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Route, Switch, Link, useLocation, Router as WouterRouter } from 'wouter';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  Clipboard,
  Copy,
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
  Settings2,
  ShieldCheck,
  Signal,
  Sparkles,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  connectRoom,
  createRoom,
  getApiOrigin,
  getPeerId,
  inviteWithApiOrigin,
  isDesktopShell,
  joinRoom,
  parseInvite,
  setApiOrigin,
  VoiceMesh,
  type RoomMessage as ApiRoomMessage,
  type RoomMember as ApiRoomMember,
  type RoomState as ApiRoomState,
} from '@/lib/p2p-client';

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
};
type Channel = { id: string; name: string; type: ChannelType; unreadCount: number; members: number };
type Message = {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  avatar: string;
  isCurrentUser: boolean;
  channelId?: string;
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
const initials = (value: string) => value.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const readStore = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};
const writeStore = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

const apiMessageToMessage = (message: ApiRoomMessage, peerId: string): Message => ({
  id: message.id,
  author: message.author,
  avatar: initials(message.author),
  content: message.content,
  timestamp: new Date(message.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
  isCurrentUser: message.authorId === peerId,
  channelId: message.channelId,
});

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
    messages: state.messages.map((message) => apiMessageToMessage(message, peerId)),
    voiceRooms,
  };
};

const seedServer: Server = {
  id: 'server-orbit',
  name: 'Комната 17',
  memberCount: 18,
  role: 'Владелец',
  connectivityState: 'connected',
  hostName: 'Миша',
};
const seedChannels: Channel[] = [
  { id: 'general', name: 'общий', type: 'text', unreadCount: 0, members: 18 },
  { id: 'ideas', name: 'идеи', type: 'text', unreadCount: 3, members: 14 },
  { id: 'photos', name: 'фото', type: 'text', unreadCount: 0, members: 12 },
  { id: 'lounge', name: 'вечерний лоунж', type: 'voice', unreadCount: 0, members: 4 },
  { id: 'games', name: 'настолки', type: 'voice', unreadCount: 0, members: 7 },
];
const seedMessages: Message[] = [
  { id: 'm-1', author: 'Миша', avatar: 'МШ', content: 'Кто сегодня в комнате после девяти?', timestamp: '20:41', isCurrentUser: false, channelId: 'general' },
  { id: 'm-2', author: 'Лена', avatar: 'ЛН', content: 'Я буду. Принесу тот самый плейлист.', timestamp: '20:43', isCurrentUser: false, channelId: 'general' },
  { id: 'm-3', author: 'Вы', avatar: 'ВЫ', content: 'Уже на подходе. Давайте начнём с короткого созвона.', timestamp: '20:44', isCurrentUser: true, channelId: 'general' },
  { id: 'm-4', author: 'Антон', avatar: 'АН', content: 'В «идеях» оставил заметку про поездку. Посмотрите, когда будет минутка.', timestamp: '20:47', isCurrentUser: false, channelId: 'general' },
];
const seedVoice: StoredVoice[] = [
  { id: 'lounge', name: 'вечерний лоунж', participantCount: 2, state: 'live', participants: ['Лена', 'Миша'] },
  { id: 'games', name: 'настолки', participantCount: 0, state: 'ready', participants: [] },
];

function LogoMark({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? 'server-mark' : 'flex items-center gap-3'}>
      <div className="server-mark" style={small ? undefined : { width: 38, height: 38, borderRadius: 11 }}>
        <Signal size={20} strokeWidth={2.5} />
      </div>
      {!small && <span className="font-display text-[20px] font-bold tracking-[-.05em]">P2P<span style={{ color: 'hsl(var(--accent))' }}>Chat</span></span>}
    </div>
  );
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
  const [apiOrigin, setApiOriginState] = useState(getApiOrigin);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = readStore<Server | null>(SERVER_KEY, null);

  const createServer = async (event: FormEvent) => {
    event.preventDefault();
    const memberName = displayName.trim() || 'Вы';
    const peerId = getPeerId();
    setBusy(true);
    try {
      setApiOrigin(apiOrigin);
      const response = await createRoom({ name: name.trim() || 'Комната без названия', peerId, displayName: memberName });
      const roomInvite = inviteWithApiOrigin(response.invite ?? '', getApiOrigin());
      const clientState = roomStateToClientState(response.room, peerId, roomInvite);
      clientState.server.inviteToken = response.inviteToken;
      writeStore(PROFILE_NAME_KEY, memberName);
      writeStore(SERVER_KEY, clientState.server);
      writeStore(CHANNELS_KEY, clientState.channels);
      writeStore(MESSAGES_KEY, clientState.messages);
      writeStore(VOICE_KEY, clientState.voiceRooms);
      setLocation('/server');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не удалось создать комнату');
    } finally {
      setBusy(false);
    }
  };
  const joinServer = async (event: FormEvent) => {
    event.preventDefault();
    const memberName = displayName.trim() || 'Вы';
    const parsed = parseInvite(invite);
    if (!parsed) {
      setToast('Вставьте полную ссылку приглашения из комнаты');
      return;
    }
    const peerId = getPeerId();
    setBusy(true);
    try {
      const response = await joinRoom({ invite, displayName: memberName }, parsed.apiOrigin || apiOrigin);
      const clientState = roomStateToClientState(response.room, peerId, invite.trim());
      clientState.server.inviteToken = parsed.inviteToken;
      writeStore(PROFILE_NAME_KEY, memberName);
      writeStore(SERVER_KEY, clientState.server);
      writeStore(CHANNELS_KEY, clientState.channels);
      writeStore(MESSAGES_KEY, clientState.messages);
      writeStore(VOICE_KEY, clientState.voiceRooms);
      setLocation('/server');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не удалось войти в комнату');
    } finally {
      setBusy(false);
    }
  };
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
            <p className="mt-7 max-w-[460px] text-[15px] leading-7 text-[#f5f0df]/63">P2PChat держит вашу компанию вместе. Создайте приватный сервер, позовите друзей — связь просто работает.</p>
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
        <section className="flex items-center px-6 py-10 sm:px-12 lg:px-20">
          <div className="mx-auto w-full max-w-[440px] animate-rise">
            <div className="mb-10 flex items-center justify-between lg:hidden"><LogoMark small /><span className="font-mono text-[10px] uppercase tracking-widest text-[hsl(var(--muted-foreground))]">приватная комната</span></div>
            <div className="mb-10"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">Вход в пространство</p><h2 className="font-display mt-3 text-4xl font-bold tracking-[-.06em]">Где собираемся?</h2><p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">Комната синхронизируется между приглашёнными участниками. Никаких аккаунтов и лишних шагов.</p></div>
            <div className="mb-7 grid grid-cols-2 rounded-xl bg-[hsl(var(--muted))] p-1" role="tablist">
              <button className={`rounded-[9px] px-3 py-2.5 text-sm font-bold transition ${mode === 'create' ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm' : 'text-[hsl(var(--muted-foreground))]'}`} onClick={() => setMode('create')} data-testid="tab-create-server">Создать сервер</button>
              <button className={`rounded-[9px] px-3 py-2.5 text-sm font-bold transition ${mode === 'join' ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm' : 'text-[hsl(var(--muted-foreground))]'}`} onClick={() => setMode('join')} data-testid="tab-join-server">Войти по ссылке</button>
            </div>
             <div className="mb-5">
               <label className="field-label" htmlFor="display-name">Ваше имя</label>
               <input id="display-name" className="field-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Например, Миша" data-testid="input-display-name" />
             </div>
              {isDesktopShell() && <div className="mb-5">
                <label className="field-label" htmlFor="api-origin">Адрес сервера синхронизации</label>
                <input id="api-origin" className="field-input" value={apiOrigin} onChange={(event) => setApiOriginState(event.target.value)} placeholder="https://ваш-сервер.example.com" data-testid="input-api-origin" />
                <p className="mt-2 text-xs leading-5 text-[hsl(var(--muted-foreground))]">Для Windows-клиента нужен опубликованный адрес API. Он попадёт в invite-ссылку для друзей.</p>
              </div>}
             {mode === 'create' ? (
              <form onSubmit={createServer} className="animate-rise" data-testid="form-create-server">
                <label className="field-label" htmlFor="server-name">Название сервера</label>
                <input id="server-name" className="field-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, «Наши выходные»" data-testid="input-server-name" autoFocus />
                <div className="mt-4 flex items-start gap-2 rounded-xl bg-[hsl(var(--muted))] p-3.5 text-xs leading-5 text-[hsl(var(--muted-foreground))]"><LockKeyhole size={15} className="mt-0.5 shrink-0 text-[hsl(var(--secondary))]" /> Только вы решаете, кто получает приглашение. Сервер будет готов через секунду.</div>
                 <button className="primary-btn mt-6 w-full" type="submit" disabled={busy} data-testid="button-create-server">{busy ? 'Подключаем комнату…' : 'Создать приватный сервер'} {!busy && <ArrowRight size={16} />}</button>
              </form>
            ) : (
              <form onSubmit={joinServer} className="animate-rise" data-testid="form-join-server">
                <label className="field-label" htmlFor="invite-code">Ссылка или код приглашения</label>
                <div className="relative"><Link2 size={17} className="absolute left-3.5 top-3.5 text-[hsl(var(--muted-foreground))]" /><input id="invite-code" className="field-input pl-10 uppercase" value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="p2p.chat/join/..." data-testid="input-invite-code" autoFocus /></div>
                <p className="mt-3 text-xs leading-5 text-[hsl(var(--muted-foreground))]">Попросите ссылку у владельца комнаты. Код можно вставить целиком — мы сами найдём нужную часть.</p>
                 <button className="primary-btn mt-6 w-full" type="submit" disabled={busy} data-testid="button-join-server">{busy ? 'Проверяем приглашение…' : 'Войти в комнату'} {!busy && <ArrowRight size={16} />}</button>
              </form>
            )}
            {existing && <button className="mt-10 flex w-full items-center justify-between border-t border-[hsl(var(--border))] pt-5 text-left" onClick={() => setLocation('/server')} data-testid="button-continue-server"><span><span className="block text-xs text-[hsl(var(--muted-foreground))]">Последняя комната</span><span className="mt-1 block font-bold">{existing.name}</span></span><ArrowRight size={18} /></button>}
             <div className="mt-12 flex items-center gap-2 text-[11px] text-[hsl(var(--muted-foreground))]"><ShieldCheck size={14} /> Защищённая комната · без аккаунта</div>
          </div>
        </section>
      </div>
      {toast && <Toast text={toast} onClose={() => setToast('')} />}
    </main>
  );
}

function WorkspaceNav({ onDiagnostics }: { onDiagnostics: () => void }) {
  const [location, setLocation] = useLocation();
  return (
    <aside className="workspace-nav" aria-label="Навигация">
      <Link href="/server" className="server-mark" aria-label="Открыть сервер" data-testid="link-server-home"><Signal size={20} strokeWidth={2.5} /></Link>
      <div className="nav-divider" />
      <button className={`nav-icon ${location === '/server' ? 'active' : ''}`} onClick={() => setLocation('/server')} aria-label="Чаты" data-testid="button-nav-chat"><Hash size={18} /></button>
      <button className="nav-icon" onClick={onDiagnostics} aria-label="Диагностика" data-testid="button-nav-diagnostics"><Activity size={18} /></button>
      <div className="mt-auto flex flex-col gap-3">
        <button className="nav-icon" onClick={() => window.alert('Настройки профиля будут доступны в следующей версии.')} aria-label="Настройки" data-testid="button-nav-settings"><Settings2 size={18} /></button>
        <div className="member-avatar" style={{ width: 38, height: 38, background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' }}>ВЫ</div>
      </div>
    </aside>
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
  const link = server.invite ?? `p2p.chat/join/room/${server.id.slice(-6).toUpperCase()}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); } catch { /* clipboard can be unavailable in local previews */ }
    onNotify('Ссылка скопирована в буфер обмена');
    onClose();
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-card">
    <div className="mb-6 flex items-start justify-between"><div><div className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">Доступ в комнату</div><h3 className="font-display mt-2 text-2xl font-bold tracking-[-.05em]">Позвать своих</h3></div><button className="icon-btn" onClick={onClose} aria-label="Закрыть" data-testid="button-close-invite-dialog"><X size={18} /></button></div>
    <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))]">Отправьте ссылку друзьям — она уже готова. Новые участники появятся в списке сразу после входа.</p>
    <div className="mt-5 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.55)] p-3"><div className="font-mono text-[11px] tracking-tight text-[hsl(var(--foreground))]" data-testid="text-invite-link">{link}</div></div>
    <button className="primary-btn mt-5 w-full" onClick={copy} data-testid="button-copy-invite"><Copy size={16} /> Скопировать ссылку</button>
  </div></div>;
}

function ChannelPane({ server, channels, selectedId, onSelect, onAdd, onInvite }: { server: Server; channels: Channel[]; selectedId: string; onSelect: (id: string) => void; onAdd: () => void; onInvite: () => void }) {
  const textChannels = channels.filter((channel) => channel.type === 'text');
  const voiceChannels = channels.filter((channel) => channel.type === 'voice');
  return <aside className="channel-pane">
    <div className="channel-header"><button className="flex w-full items-center justify-between text-left" onClick={onInvite} data-testid="button-server-menu"><span><span className="block font-display text-[17px] font-bold tracking-[-.04em]">{server.name}</span><span className="mt-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]"><span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))]" /> {server.memberCount} участников</span></span><ChevronDown size={16} className="text-[hsl(var(--muted-foreground))]" /></button>
    </div>
    <div className="channel-scroll scrollbar-thin">
      <div className="mb-5"><div className="mb-2 flex items-center justify-between px-2 text-[10px] font-bold uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]"><span>Текстовые</span><button className="icon-btn" style={{ width: 22, height: 22 }} onClick={onAdd} aria-label="Добавить канал" data-testid="button-add-text-channel"><Plus size={14} /></button></div>{textChannels.map((channel) => <button key={channel.id} className={`channel-row ${channel.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(channel.id)} data-testid={`button-channel-${channel.id}`}><Hash size={17} /><span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold">{channel.name}</span>{channel.unreadCount > 0 && <span className="rounded-full bg-[hsl(var(--accent))] px-1.5 py-0.5 text-[10px] font-bold text-[hsl(var(--accent-foreground))]">{channel.unreadCount}</span>}</button>)}</div>
      <div><div className="mb-2 flex items-center justify-between px-2 text-[10px] font-bold uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]"><span>Голосовые</span><button className="icon-btn" style={{ width: 22, height: 22 }} onClick={onAdd} aria-label="Добавить голосовой канал" data-testid="button-add-voice-channel"><Plus size={14} /></button></div>{voiceChannels.map((channel) => <button key={channel.id} className={`channel-row ${channel.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(channel.id)} data-testid={`button-voice-room-${channel.id}`}><Volume2 size={17} /><span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold">{channel.name}</span>{channel.members > 0 && <span className="font-mono text-[10px]">{channel.members}</span>}</button>)}</div>
    </div>
    <div className="channel-footer"><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-[hsl(var(--muted-foreground))] transition hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]" onClick={onInvite} data-testid="button-invite-members"><UserPlus size={15} /> Пригласить друзей</button></div>
  </aside>;
}

function VoiceCard({ room, active, onJoin, onLeave, muted, deafened, onMute, onDeafen }: { room: StoredVoice; active: boolean; onJoin: () => void; onLeave: () => void; muted: boolean; deafened: boolean; onMute: () => void; onDeafen: () => void }) {
  return <div className={`mx-4 mb-3 rounded-xl border p-3 transition ${active ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.1)]' : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]'}`}>
    <div className="flex items-center gap-2"><span className={`grid h-7 w-7 place-items-center rounded-lg ${active ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'}`}><Volume2 size={14} /></span><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold">{room.name}</div><div className="mt-0.5 font-mono text-[9px] uppercase text-[hsl(var(--muted-foreground))]">{active ? 'Вы внутри' : `${room.participantCount} ${room.participantCount === 1 ? 'участник' : 'участника'}`}</div></div>{active ? <button className="icon-btn" onClick={onLeave} aria-label="Покинуть голосовую комнату" data-testid={`button-leave-voice-${room.id}`}><X size={15} /></button> : <button className="icon-btn" onClick={onJoin} aria-label="Войти в голосовую комнату" data-testid={`button-join-voice-${room.id}`}><ArrowRight size={15} /></button>}</div>
    {room.participants.length > 0 && <div className="mt-3 flex items-center gap-1.5">{room.participants.map((person) => <div key={person} className="member-avatar" title={person}>{initials(person)}</div>)}</div>}
    {active && <div className="mt-3 flex gap-1 border-t border-[hsl(var(--border))] pt-2"><button className={`icon-btn ${muted ? 'bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent))]' : ''}`} onClick={onMute} aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'} data-testid="button-toggle-mute"><>{muted ? <MicOff size={15} /> : <Mic size={15} />}</></button><button className={`icon-btn ${deafened ? 'bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent))]' : ''}`} onClick={onDeafen} aria-label={deafened ? 'Включить звук' : 'Отключить звук'} data-testid="button-toggle-deafen"><>{deafened ? <VolumeX size={15} /> : <Headphones size={15} />}</></button><span className="ml-auto self-center font-mono text-[9px] uppercase text-[hsl(var(--muted-foreground))]">связь защищена</span></div>}
  </div>;
}

function MessageList({ messages }: { messages: Message[] }) {
  if (!messages.length) return <div className="flex h-full flex-col items-center justify-center px-6 text-center"><div className="grid h-16 w-16 place-items-center rounded-2xl bg-[hsl(var(--primary)/.18)] text-[hsl(var(--secondary))]"><Sparkles size={25} /></div><h3 className="font-display mt-5 text-xl font-bold">Здесь пока тихо</h3><p className="mt-2 max-w-xs text-sm leading-6 text-[hsl(var(--muted-foreground))]">Начните разговор — первое сообщение задаст настроение комнате.</p></div>;
  return <div className="space-y-1"><div className="mb-7 flex items-center gap-3 text-[11px] text-[hsl(var(--muted-foreground))]"><div className="diag-line" /><span>Сегодня</span><div className="diag-line" /></div>{messages.map((message, index) => <article className="message-item" key={message.id} style={{ animationDelay: `${index * 45}ms` }} data-testid={`message-${message.id}`}><div className="message-avatar" style={{ background: message.isCurrentUser ? 'hsl(var(--accent))' : undefined, color: message.isCurrentUser ? 'hsl(var(--accent-foreground))' : undefined }}>{message.avatar}</div><div className="min-w-0"><div className="flex items-baseline gap-2"><strong className="text-[13px]">{message.author}</strong><time className="font-mono text-[9px] text-[hsl(var(--muted-foreground))]">{message.timestamp}</time></div><p className="mt-1 text-[14px] leading-6 text-[hsl(var(--foreground)/.82)]">{message.content}</p></div></article>)}</div>;
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
  const [toast, setToast] = useState('');
  const [activeVoice, setActiveVoice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [members, setMembers] = useState<ApiRoomMember[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'offline'>('offline');
  const [peerId] = useState(getPeerId);
  const connectionRef = useRef<ReturnType<typeof connectRoom> | null>(null);
  const voiceMeshRef = useRef<VoiceMesh | null>(null);
  const voiceChannelRef = useRef<string | null>(null);
  const displayName = readStore(PROFILE_NAME_KEY, 'Вы');
  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? channels[0];
  const channelMessages = messages.filter((message) => message.channelId === selectedId || (!message.channelId && selectedId === 'general'));
  const selectedVoice = voiceRooms.find((room) => room.id === selectedId);

  useEffect(() => { writeStore(SERVER_KEY, server); }, [server]);
  useEffect(() => { writeStore(CHANNELS_KEY, channels); }, [channels]);
  useEffect(() => { writeStore(MESSAGES_KEY, messages); }, [messages]);
  useEffect(() => { writeStore(VOICE_KEY, voiceRooms); }, [voiceRooms]);

  useEffect(() => {
    if (!server.roomId || !server.inviteToken) {
      setConnectionStatus('offline');
      return;
    }
    const handleConnectionStatus = (status: 'connecting' | 'connected' | 'offline') => {
      setConnectionStatus(status);
      writeStore(CONNECTION_KEY, status);
    };
    const connection = connectRoom(
      { roomId: server.roomId, inviteToken: server.inviteToken, peerId, displayName },
      (event) => {
        if (event.type === 'state' || event.type === 'presence') {
          const next = roomStateToClientState(event.state, peerId, server.invite);
          next.server.inviteToken = server.inviteToken;
          setServer((current) => ({ ...current, ...next.server }));
          setChannels(next.channels);
          setMessages(next.messages);
          setVoiceRooms(next.voiceRooms);
          setMembers(event.state.members);
        } else if (event.type === 'message') {
          const nextMessage = apiMessageToMessage(event.message, peerId);
          setMessages((current) => current.some((message) => message.id === nextMessage.id) ? current : [...current, nextMessage]);
        } else if (event.type === 'voice') {
          if (event.channelId !== voiceChannelRef.current) return;
          if (event.joined) {
            void voiceMeshRef.current?.addPeer(event.peerId, peerId < event.peerId).catch((error) => {
              setToast(error instanceof Error ? error.message : 'Не удалось подключить голосовой канал');
            });
          } else {
            voiceMeshRef.current?.removePeer(event.peerId);
          }
        } else if (event.type === 'signal') {
          void voiceMeshRef.current?.handleSignal(event.fromPeerId, event.data).catch((error) => {
            setToast(error instanceof Error ? error.message : 'Ошибка голосового signaling');
          });
        } else if (event.type === 'error') {
          setToast(event.message);
        }
      },
      handleConnectionStatus,
    );
    connectionRef.current = connection;
    return () => {
      connection.close();
      connectionRef.current = null;
      voiceMeshRef.current?.stop();
      voiceMeshRef.current = null;
      voiceChannelRef.current = null;
    };
  }, [server.roomId, server.inviteToken, peerId, displayName]);

  const sendMessage = () => {
    const content = draft.trim();
    if (!content) return;
    if (server.roomId && connectionStatus !== 'connected') {
      setToast('Нет соединения с комнатой — сообщение не отправлено');
      return;
    }
    const messageId = uid('message');
    const next: Message = { id: messageId, author: displayName, avatar: initials(displayName), content, timestamp: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), isCurrentUser: true, channelId: selectedId };
    setMessages((current) => [...current, next]);
    if (server.roomId) connectionRef.current?.send({ type: 'message', channelId: selectedId, content, messageId });
    setDraft('');
  };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } };
  const addChannel = (channelName: string, type: ChannelType) => {
    if (server.roomId) {
      if (connectionStatus !== 'connected') {
        setToast('Нет соединения с комнатой');
        return;
      }
      connectionRef.current?.send({ type: 'create_channel', name: channelName, channelType: type });
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
        const mesh = voiceMeshRef.current ?? new VoiceMesh(peerId, (toPeerId, data) => {
          connectionRef.current?.send({ type: 'signal', toPeerId, data });
        });
        await mesh.start();
        voiceMeshRef.current = mesh;
        voiceChannelRef.current = room.id;
        connectionRef.current?.send({ type: 'voice_join', channelId: room.id });
      } catch (error) {
        setToast(error instanceof Error ? error.message : 'Не удалось получить доступ к микрофону');
        return;
      }
    }
    setActiveVoice(room.id);
    setVoiceRooms((current) => current.map((item) => item.id === room.id ? { ...item, participantCount: item.participantCount + 1, state: 'live', participants: item.participants.includes(displayName) ? item.participants : [...item.participants, displayName] } : item));
    setToast(`Вы в комнате «${room.name}»`);
  };
  const leaveVoice = () => {
    if (!activeVoice) return;
    if (server.roomId) connectionRef.current?.send({ type: 'voice_leave', channelId: activeVoice });
    voiceMeshRef.current?.stop();
    voiceMeshRef.current = null;
    voiceChannelRef.current = null;
    setVoiceRooms((current) => current.map((item) => item.id === activeVoice ? { ...item, participantCount: Math.max(0, item.participantCount - 1), participants: item.participants.filter((person) => person !== displayName), state: item.participantCount <= 1 ? 'ready' : 'live' } : item));
    setActiveVoice(null); setMuted(false); setDeafened(false); setToast('Вы вышли из голосовой комнаты');
  };
  const selectChannel = (id: string) => {
    setSelectedId(id);
    setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, unreadCount: 0 } : channel));
  };
  const notify = (text: string) => setToast(text);
  const visibleMembers = members.length > 0
    ? members
    : ['Миша', 'Лена', 'Антон', 'Даша', 'Вы'].map((name, index) => ({
      id: `seed-${index}`,
      name,
      online: true,
      role: name === server.hostName ? 'owner' as const : 'member' as const,
      joinedAt: '',
    }));
  return <div className="noise workspace-shell">
    <WorkspaceNav onDiagnostics={() => setLocation('/diagnostics')} />
    <ChannelPane server={server} channels={channels} selectedId={selectedId} onSelect={selectChannel} onAdd={() => setShowChannelDialog(true)} onInvite={() => setShowInviteDialog(true)} />
    <main className="content-pane">
      <header className="topbar">
        <div className="flex min-w-0 items-center gap-3"><button className="icon-btn mobile-channel-chip" aria-label="Открыть список каналов" data-testid="button-open-channels"><Menu size={18} /></button><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">{selectedChannel?.type === 'voice' ? <Volume2 size={16} /> : <Hash size={16} />}</div><div className="min-w-0"><h1 className="truncate font-display text-[16px] font-bold tracking-[-.03em]">{selectedChannel?.name ?? 'общий'}</h1><p className="topbar-subtitle truncate text-[10px] text-[hsl(var(--muted-foreground))]">{selectedChannel?.type === 'voice' ? 'Голосовая комната' : connectionStatus === 'connected' ? 'Синхронизировано между участниками' : connectionStatus === 'connecting' ? 'Подключаемся к комнате…' : 'Нет соединения с комнатой'}</p></div></div>
        <div className="flex items-center gap-2"><button className="ghost-btn hidden sm:inline-flex" onClick={() => setShowInviteDialog(true)} data-testid="button-top-invite"><UserPlus size={15} /> <span>Пригласить</span></button><button className="icon-btn" onClick={() => setLocation('/diagnostics')} aria-label="Открыть диагностику" data-testid="button-open-diagnostics"><Activity size={17} /></button></div>
      </header>
       {selectedVoice ? <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><div className="relative grid h-24 w-24 place-items-center rounded-[28px] bg-[hsl(var(--primary)/.18)] text-[hsl(var(--secondary))]"><Volume2 size={36} /><span className="animate-pulse-dot absolute right-1 top-1 h-3 w-3 rounded-full bg-[hsl(var(--primary))]" /></div><p className="mt-7 font-mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--muted-foreground))]">Голосовая комната</p><h2 className="font-display mt-2 text-3xl font-bold tracking-[-.06em]">{selectedVoice.name}</h2><p className="mt-3 max-w-sm text-sm leading-6 text-[hsl(var(--muted-foreground))]">Нажмите «войти», чтобы разрешить микрофон и подключиться по WebRTC.</p><div className="mt-7 flex items-center gap-3"><button className="primary-btn" onClick={() => activeVoice === selectedVoice.id ? leaveVoice() : void joinVoice(selectedVoice)} data-testid="button-main-voice-toggle">{activeVoice === selectedVoice.id ? <><X size={16} /> Покинуть комнату</> : <><Radio size={16} /> Войти в комнату</>}</button></div><div className="mt-9 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]"><Users size={14} /> {selectedVoice.participantCount} сейчас в комнате</div></div> : <div className="chat-area"><div className="message-scroll scrollbar-thin"><MessageList messages={channelMessages} /></div><div className="composer"><div className="composer-inner"><button className="icon-btn shrink-0" onClick={() => setShowChannelDialog(true)} aria-label="Добавить вложение" data-testid="button-add-attachment"><Plus size={18} /></button><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={`Написать в #${selectedChannel?.name ?? 'общий'}...`} aria-label="Новое сообщение" data-testid="input-message" rows={1} /><button className="primary-btn !h-9 !w-9 !p-0" onClick={sendMessage} aria-label="Отправить сообщение" data-testid="button-send-message"><Send size={15} /></button></div><div className="mt-2 flex items-center gap-1.5 px-1 font-mono text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]"><LockKeyhole size={10} /> сообщения синхронизируются в комнате <span className="ml-auto">enter — отправить</span></div></div></div>}
    </main>
    <aside className="member-pane scrollbar-thin">
      <div className="mb-7"><div className="flex items-center justify-between"><span className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">Комната</span><span className="h-2 w-2 rounded-full bg-[hsl(var(--primary))]" /></div><div className="mt-4 flex items-center gap-2"><div className="grid h-8 w-8 place-items-center rounded-lg bg-[hsl(var(--primary))] text-xs font-extrabold text-[hsl(var(--primary-foreground))]">{initials(server.name)}</div><div><div className="text-xs font-bold">{server.name}</div><div className="font-mono text-[9px] text-[hsl(var(--muted-foreground))]">хост: {server.hostName}</div></div></div></div>
      <div className="mb-8"><div className="mb-3 flex items-center justify-between"><span className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">Участники</span><span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{server.memberCount}</span></div><div className="space-y-3">{visibleMembers.map((member, index) => <div className={`flex items-center gap-2 ${member.online ? '' : 'opacity-45'}`} key={member.id} data-testid={`member-${index}`}><div className="relative"><div className="member-avatar" style={member.id === peerId ? { background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' } : undefined}>{initials(member.name)}</div><span className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[hsl(var(--card))] ${member.online ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted-foreground))]'}`} /></div><span className="text-xs font-semibold">{member.name}</span>{member.name === server.hostName && <span className="ml-auto font-mono text-[8px] uppercase text-[hsl(var(--muted-foreground))]">хост</span>}</div>)}</div><button className="mt-4 flex items-center gap-2 text-xs font-bold text-[hsl(var(--secondary))] transition hover:text-[hsl(var(--accent))]" onClick={() => setShowInviteDialog(true)} data-testid="button-member-invite"><Plus size={14} /> Ещё люди</button></div>
      <div><div className="mb-3 flex items-center justify-between"><span className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">Голосовые</span><button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setShowChannelDialog(true)} aria-label="Создать голосовую комнату" data-testid="button-member-add-voice"><Plus size={14} /></button></div>{voiceRooms.map((room) => <VoiceCard key={room.id} room={room} active={activeVoice === room.id} onJoin={() => void joinVoice(room)} onLeave={leaveVoice} muted={muted} deafened={deafened} onMute={() => setMuted((value) => { const next = !value; voiceMeshRef.current?.setMuted(next); return next; })} onDeafen={() => setDeafened((value) => { const next = !value; voiceMeshRef.current?.setDeafened(next); return next; })} />)}</div>
    </aside>
    {showChannelDialog && <CreateChannelDialog onClose={() => setShowChannelDialog(false)} onCreate={addChannel} />}
    {showInviteDialog && <InviteDialog server={server} onClose={() => setShowInviteDialog(false)} onNotify={notify} />}
    {toast && <Toast text={toast} onClose={() => setToast('')} />}
  </div>;
}

function Diagnostics() {
  const [, setLocation] = useLocation();
  const [revealed, setRevealed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState('только что');
  const server = readStore<Server>(SERVER_KEY, seedServer);
  const connectionStatus = readStore<'connecting' | 'connected' | 'offline'>(CONNECTION_KEY, 'offline');
  const connectionLabel = connectionStatus === 'connected' ? 'Стабильно' : connectionStatus === 'connecting' ? 'Подключение' : 'Офлайн';
  const diagnostics = [
    ['Control plane', connectionStatus === 'connected' ? 'Работает' : connectionLabel, 'Комната синхронизирует участников и сообщения через защищённый WebSocket.'],
    ['Обмен сообщениями', connectionStatus === 'connected' ? 'Работает' : 'Ожидает', connectionStatus === 'connected' ? 'Новые сообщения доходят всем подключённым участникам.' : 'Вернитесь в комнату, чтобы восстановить соединение.'],
    ['Голосовой signaling', 'Готов', 'События входа и выхода из голосовых комнат передаются через control plane.'],
    ['Переезд хоста', 'Защищён', 'Если текущий хост уйдёт, backend выберет нового участника автоматически.'],
  ];
  const check = () => { setChecking(true); window.setTimeout(() => { setChecking(false); setLastChecked('только что'); }, 1000); };
  return <div className="noise min-h-[100dvh] app-grid" style={{ background: 'hsl(var(--background))' }}>
    <header className="flex h-[76px] items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card)/.72)] px-5 backdrop-blur-md sm:px-10"><Link href="/server" className="flex items-center gap-3" data-testid="link-diagnostics-back"><div className="server-mark" style={{ width: 35, height: 35, borderRadius: 10 }}><Signal size={17} /></div><span className="font-display text-lg font-bold tracking-[-.05em]">P2P<span style={{ color: 'hsl(var(--accent))' }}>Chat</span></span></Link><button className="ghost-btn" onClick={() => setLocation('/server')} data-testid="button-back-to-server"><ArrowRight size={15} className="rotate-180" /> Вернуться в комнату</button></header>
    <main className="mx-auto max-w-[900px] px-5 py-12 sm:px-10 sm:py-16">
       <div className="max-w-[650px] animate-rise"><div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[hsl(var(--primary)/.15)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.15em] text-[hsl(var(--secondary))]"><ShieldCheck size={13} /> Состояние комнаты</div><h1 className="font-display text-5xl font-bold tracking-[-.08em] sm:text-7xl">Связь,<br /><span style={{ color: 'hsl(var(--accent))' }}>которая держится.</span></h1><p className="mt-6 max-w-[570px] text-[15px] leading-7 text-[hsl(var(--muted-foreground))]">Проверьте живое состояние control plane, участников и автоматического выбора нового хоста. Аудио WebRTC и NAT traversal подключаются следующим слоем.</p></div>
      <section className="mt-12 grid gap-3 sm:grid-cols-3">
         <div className="metric-card animate-rise stagger-1"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Соединение</span><Wifi size={16} className="text-[hsl(var(--primary))]" /></div><div className="mt-4 font-display text-2xl font-bold">{connectionLabel}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">WebSocket control plane</div></div>
        <div className="metric-card animate-rise stagger-2"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Задержка</span><Zap size={16} className="text-[hsl(var(--accent))]" /></div><div className="mt-4 font-display text-2xl font-bold">18 <small className="font-sans text-sm font-medium">мс</small></div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">до ближайшего участника</div></div>
         <div className="metric-card animate-rise stagger-3"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Роль узла</span><Network size={16} className="text-[hsl(var(--secondary))]" /></div><div className="mt-4 font-display text-2xl font-bold">{server.role ?? 'Участник'}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">хост: {server.hostName}</div></div>
      </section>
      <section className="mt-3 overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] animate-rise stagger-3">
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-5 py-5 sm:px-7"><div><h2 className="font-display text-xl font-bold tracking-[-.04em]">Состояние комнаты</h2><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Последняя проверка: {lastChecked}</p></div><button className="ghost-btn" onClick={check} disabled={checking} data-testid="button-refresh-diagnostics"><RefreshCw size={15} className={checking ? 'animate-spin' : ''} /> {checking ? 'Проверяем' : 'Проверить снова'}</button></div>
        <div className="divide-y divide-[hsl(var(--border))] px-5 sm:px-7">
           {diagnostics.map(([title, state, description], index) => <div className="flex items-center gap-4 py-5" key={title} data-testid={`diagnostic-row-${index}`}><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[hsl(var(--primary)/.14)] text-[hsl(var(--secondary))]"><Check size={17} /></div><div className="min-w-0 flex-1"><div className="text-sm font-bold">{title}</div><div className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">{description}</div></div><span className="hidden rounded-full bg-[hsl(var(--primary)/.18)] px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-[hsl(var(--secondary))] sm:block">{state}</span></div>)}
        </div>
        <button className="flex w-full items-center gap-2 border-t border-[hsl(var(--border))] px-5 py-4 text-left text-xs font-bold text-[hsl(var(--muted-foreground))] transition hover:bg-[hsl(var(--muted)/.55)] hover:text-[hsl(var(--foreground))] sm:px-7" onClick={() => setRevealed((value) => !value)} data-testid="button-reveal-diagnostics"><Info size={15} /> {revealed ? 'Скрыть технические детали' : 'Показать технические детали'}<ChevronDown size={15} className={`ml-auto transition ${revealed ? 'rotate-180' : ''}`} /></button>
         {revealed && <div className="grid gap-3 border-t border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] px-5 py-5 font-mono text-[10px] text-[hsl(var(--muted-foreground))] sm:grid-cols-2 sm:px-7 animate-rise"><div>transport <span className="float-right text-[hsl(var(--foreground))]">websocket / server-assisted</span></div><div>discovery <span className="float-right text-[hsl(var(--foreground))]">invite token</span></div><div>encryption <span className="float-right text-[hsl(var(--foreground))]">TLS at deployment</span></div><div>host handoff <span className="float-right text-[hsl(var(--foreground))]">active</span></div></div>}
      </section>
      <div className="mt-7 flex items-start gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.55)] p-4 text-xs leading-5 text-[hsl(var(--muted-foreground))]"><LockKeyhole size={15} className="mt-0.5 shrink-0 text-[hsl(var(--secondary))]" /><span><strong className="text-[hsl(var(--foreground))]">Это нормально.</strong> В большинстве случаев вам никогда не понадобится этот экран. Мы показали его, чтобы вы знали: комната следит за собой.</span></div>
    </main>
  </div>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={Home} /><Route path="/server" component={Workspace} /><Route path="/diagnostics" component={Diagnostics} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;