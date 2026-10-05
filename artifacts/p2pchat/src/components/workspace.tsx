import { useEffect, useRef, useState, useMemo, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { Activity, ChevronDown, Copy, Download, Hash, Headphones, LockKeyhole, Menu, Mic, MicOff, Plus, Radio, Send, Settings, Signal, Sparkles, UserPlus, Users, Volume2, VolumeX, X, ImageIcon, Monitor, MonitorOff, Music2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { PatriotJoinPopup, shouldShowPatriotPopup } from '@/components/patriot-join-popup';
import { getPeerId, getPublicUrl, isDesktopShell, isLocalhostOrigin, leaveCurrentRoom, openRoomSession, refreshCoordinatorInvite, restartPublicTunnel, setPublicUrl, statusLabel, VoiceMesh, getActiveVoiceMesh, type RoomMember as ApiRoomMember, type VoicePeerStatus, type VoiceQualitySnapshot } from '@/lib/p2p-client';
import type { RoomSession } from '@workspace/p2p-room';
import type { SessionStatus } from '@workspace/p2p-room';
import { debugLog } from '@/lib/debug-log';
import { avatarColors, avatarInitials, fileToChatImageDataUrl } from '@/lib/avatar';
import { encodeRichMessage, encodeReact, encodeEdit, encodeDelete, encodePin, encodeSfx, encodeVoteKick, encodeKickNotice, foldChatMessages, extractMentions, mentionSuggestions, applyMentionSuggestion, splitMentionSpans, fileToChatAttachment, parseWireText, IMAGE_MESSAGE_PREFIX } from '@/lib/chat-payload';
import { notifyDesktop } from '@/lib/desktop-notify';
import { cacheRoomMessages, loadCachedRoomMessages, mergeMessagesWithCache } from '@/lib/message-cache';
import { useAppTheme } from '@/lib/theme';
import { refreshPatriotRankSalt } from '@/lib/patriot-ranks';
import { FUN_SOUNDS, funSoundLabel, isFunSoundId, playFunSound, type FunSoundId } from '@/lib/fun-sounds';
import { loadChannelPaneWidth, loadMemberPaneCollapsed, loadMemberPaneWidth, saveMemberPaneCollapsed, saveChannelPaneWidth, saveMemberPaneWidth } from '@/lib/layout-settings';
import { loadAudioInputId, loadAudioOutputId } from '@/lib/audio-settings';
import { playUiSound } from '@/lib/ui-sounds';
import { labelForHotkeyCode, loadDeafenHotkeyCode, loadMuteHotkeyCode, loadPttKeyCode, loadVoiceOverlayEnabled, loadVoiceOverlayInteractive, loadVoiceOverlayOpacity, loadVoiceTalkMode, hotkeyVkForCode, pttVkForCode, VOICE_OVERLAY_PAYLOAD_KEY, type PttKeyCode, type VoiceOverlayPayload, type VoiceTalkMode } from '@/lib/voice-settings';
import { dismissOnboardingGuide, loadOnboardingGuide } from '@/lib/onboarding-guide';
import { hideMessageLocally, loadHiddenMessageIds } from '@/lib/hidden-messages';
import { applySlashCommandSuggestion, slashCommandSuggestions, tryParseChatCommand, type SlashCommandOption } from '@/lib/chat-commands';
import { type ChannelType, type Server, type Channel, type Message, type StoredVoice, SERVER_KEY, CHANNELS_KEY, MESSAGES_KEY, VOICE_KEY, PROFILE_NAME_KEY, CONNECTION_KEY, uid, readStore, writeStore, mergeChannelUnread, roomStateToClientState, seedServer, seedChannels, seedMessages, seedVoice } from '@/lib/app-shared';
import { LIMITS } from '@workspace/p2p-protocol';
import { CreatorCredit, AppVersionLabel, Toast, ConnectionStatusChips, PatriotName } from '@/components/app-brand';
import { SettingsPage } from '@/components/settings-page';
import { Diagnostics } from '@/components/diagnostics-panel';
import { ScreenShareStage } from '@/components/screen-share-stage';

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

function InviteDialog({
  server,
  onClose,
  onNotify,
  onInviteUpdated,
}: {
  server: Server;
  onClose: () => void;
  onNotify: (text: string) => void;
  onInviteUpdated?: (invite: string) => void;
}) {
  const [link, setLink] = useState(server.invite ?? '');
  const [refreshing, setRefreshing] = useState(true);
  const isLocal = isLocalhostOrigin(link);

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    void refreshCoordinatorInvite()
      .then((meta) => {
        if (cancelled) return;
        const next = meta?.invite || server.invite || '';
        setLink(next);
        if (meta?.invite) onInviteUpdated?.(meta.invite);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
    // Refresh once when the dialog opens so friends never get a dead Quick Tunnel hostname.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async () => {
    if (!link) {
      onNotify('Ссылка ещё не готова — подождите туннель');
      return;
    }
    try { await navigator.clipboard.writeText(link); } catch { /* clipboard can be unavailable in local previews */ }
    onNotify('Свежая ссылка скопирована — друг открывает её в Chrome/Edge (не в IE)');
    onClose();
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-card">
    <div className="mb-6 flex items-start justify-between"><div><div className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">Доступ в комнату</div><h3 className="font-display mt-2 text-2xl font-bold tracking-[-.05em]">Позвать своих</h3></div><button className="icon-btn" onClick={onClose} aria-label="Закрыть" data-testid="button-close-invite-dialog"><X size={18} /></button></div>
    <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))]">Ссылка обновляется при каждом открытии этого окна (актуальный туннель). В Steam: ПКМ по ссылке → открыть во внешнем браузере (Chrome/Edge), не Internet Explorer. У друга должен быть установлен Drift.</p>
    {isLocal && <div className="mt-4 rounded-xl border border-[hsl(var(--accent))]/30 bg-[hsl(var(--accent)/.08)] p-3 text-xs leading-5 text-[hsl(var(--accent))]">
      <strong>Внимание:</strong> в ссылке только localhost. Друзья в другой сети не подключатся.
      <div className="mt-2 font-mono text-[10px]">В одной Wi‑Fi приглашение должно содержать LAN-адрес (его подставит desktop-клиент). Между сетями нужен публичный bootstrap или туннель.</div>
    </div>}
    <div className="mt-5 max-h-40 overflow-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.55)] p-3"><div className="break-all font-mono text-[11px] leading-5 tracking-tight text-[hsl(var(--foreground))]" data-testid="text-invite-link">{refreshing ? 'Обновляем ссылку под текущий туннель…' : (link || 'Ссылка появится после поднятия туннеля')}</div></div>
    <button className="primary-btn mt-5 w-full" onClick={copy} disabled={refreshing || !link} data-testid="button-copy-invite"><Copy size={16} /> {refreshing ? 'Готовим ссылку…' : 'Скопировать ссылку'}</button>
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
  voiceTalkMode,
  pttHeld,
  pttKeyLabel,
  voiceQuality,
  sharingScreen,
  onToggleScreenShare,
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
  voiceTalkMode?: VoiceTalkMode;
  pttHeld?: boolean;
  pttKeyLabel?: string;
  voiceQuality?: VoiceQualitySnapshot | null;
  sharingScreen?: boolean;
  onToggleScreenShare?: () => void;
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
                    const isSelf = person.id === selfPeerId;
                    const voiceState = voiceUi
                      ? isSelf
                        ? { muted: selfMuted ?? false, deafened: selfDeafened ?? false }
                        : peerVoiceStates?.[person.id]
                      : undefined;
                    const speaking = voiceUi ? Boolean(speakingPeers?.[person.id]) : false;
                    const rowPeerId = isSelf ? undefined : person.id;
                    return (
                      <div
                        key={`${channel.id}-${person.id}`}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-[hsl(var(--foreground)/.85)]"
                        onContextMenu={rowPeerId && onPeerContextMenu ? (event) => { event.preventDefault(); onPeerContextMenu(event, rowPeerId); } : undefined}
                      >
                        <div
                          className={`member-avatar ${speaking ? 'ring-2 ring-[hsl(var(--primary))] ring-offset-1 ring-offset-[hsl(var(--background))]' : ''}`}
                          style={{ width: 22, height: 22, fontSize: 8, ...avatarColors(person.name) }}
                        >
                          {avatarInitials(person.name)}
                        </div>
                        <span className="min-w-0 flex-1 truncate font-semibold"><PatriotName name={person.name} seed={person.id} /></span>
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
          {voiceQuality && (
            <div
              className="flex items-center gap-2 rounded-md bg-[hsl(var(--background)/.55)] px-2 py-1.5 font-mono text-[11px]"
              data-testid="voice-quality-chip"
              title={voiceQuality.path === 'relay' ? 'Через TURN' : voiceQuality.path === 'srflx' ? 'Через интернет (STUN)' : voiceQuality.path === 'host' ? 'Прямой / LAN' : 'Путь ещё считается'}
            >
              <span aria-hidden>
                {voiceQuality.level === 'ok' ? '🟢' : voiceQuality.level === 'fair' ? '🟡' : '🔴'}
              </span>
              <span className="font-semibold text-[hsl(var(--foreground))]">
                {voiceQuality.rttMs != null ? `${voiceQuality.rttMs} ms` : '… ms'}
              </span>
              <span className="ml-auto text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                {voiceQuality.path === 'relay' ? 'TURN' : voiceQuality.path === 'srflx' ? 'STUN' : voiceQuality.path === 'host' ? 'P2P' : 'ICE'}
              </span>
            </div>
          )}
          {voiceTalkMode === 'ptt' && (
            <div
              className={`rounded-md px-2 py-1.5 text-[11px] font-semibold transition ${
                pttHeld
                  ? 'bg-[hsl(var(--primary)/.22)] text-[hsl(var(--foreground))]'
                  : 'bg-[hsl(var(--background)/.45)] text-[hsl(var(--muted-foreground))]'
              }`}
              data-testid="ptt-indicator"
            >
              {pttHeld
                ? `Говорите · ${pttKeyLabel || 'PTT'}`
                : `Зажмите ${pttKeyLabel || 'клавишу'}, чтобы говорить`}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            <button className={`icon-btn ${muted ? 'bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent))]' : ''}`} onClick={onMute} aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'} data-testid="button-toggle-mute">{muted ? <MicOff size={15} /> : <Mic size={15} />}</button>
            <button className={`icon-btn ${deafened ? 'bg-[hsl(var(--accent)/.18)] text-[hsl(var(--accent))]' : ''}`} onClick={onDeafen} aria-label={deafened ? 'Включить звук' : 'Отключить звук'} data-testid="button-toggle-deafen">{deafened ? <VolumeX size={15} /> : <Headphones size={15} />}</button>
            {onToggleScreenShare && (
              <button
                className={`icon-btn ${sharingScreen ? 'bg-[hsl(var(--primary)/.18)] text-[hsl(var(--primary))]' : ''}`}
                onClick={onToggleScreenShare}
                aria-label={sharingScreen ? 'Остановить демонстрацию экрана' : 'Поделиться экраном'}
                data-testid="button-toggle-screen-share"
              >
                {sharingScreen ? <MonitorOff size={15} /> : <Monitor size={15} />}
              </button>
            )}
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
          {onToggleScreenShare && (
            <button
              type="button"
              className={`flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold transition ${
                sharingScreen
                  ? 'bg-[hsl(var(--primary)/.16)] text-[hsl(var(--primary))]'
                  : 'hover:bg-[hsl(var(--muted)/.55)] text-[hsl(var(--muted-foreground))]'
              }`}
              onClick={onToggleScreenShare}
              data-testid="button-screen-share-footer"
            >
              {sharingScreen ? <><MonitorOff size={12} /> Стоп экран</> : <><Monitor size={12} /> Поделиться экраном</>}
            </button>
          )}
        </div>
      )}
      {activeVoiceChannelId && onLeaveVoice && (
        <button className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-[hsl(var(--primary))] transition hover:bg-[hsl(var(--primary)/.12)]" onClick={onLeaveVoice} data-testid="button-leave-voice-channel"><VolumeX size={14} /> Покинуть голосовой</button>
      )}
      <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-[hsl(var(--muted-foreground))] transition hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]" onClick={onInvite} data-testid="button-invite-members"><UserPlus size={15} /> Пригласить друзей</button>
      <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-[hsl(var(--accent))] transition hover:bg-[hsl(var(--accent)/.12)]" onClick={onLeaveServer} data-testid="button-leave-server"><X size={15} /> Покинуть сервер</button>
      <CreatorCredit className="block px-2 pt-1 text-[8px] text-[hsl(var(--muted-foreground)/.7)]" />
      <AppVersionLabel className="mt-1 block px-2 text-[9px]" />
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
  onHideLocal,
  onPin,
  onVoteYes,
}: {
  messages: Message[];
  memberNames: string[];
  onReply: (id: string) => void;
  onReact: (targetId: string, emoji: string) => void;
  onEdit: (targetId: string, body: string) => void;
  onDelete: (targetId: string) => void;
  onHideLocal: (targetId: string) => void;
  onPin: (targetId: string, pinned: boolean) => void;
  onVoteYes: (targetId: string) => void;
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
              ) : message.voteKick ? (
                <div className="mt-2 rounded-xl border border-[hsl(var(--accent)/.35)] bg-[hsl(var(--accent)/.08)] px-3 py-2" data-testid={`message-votekick-${message.id}`}>
                  <p className="text-sm font-semibold">🗳️ Кикнуть {message.voteKick.targetName}?</p>
                  <p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">Без бана — сможет зайти снова по ссылке. Нужно большинство онлайн.</p>
                  <button type="button" className="primary-btn mt-2 !h-8 !px-3 text-xs" onClick={() => onVoteYes(message.id)} data-testid={`button-vote-yes-${message.id}`}>
                    За ({(message.reactions?.['✅'] ?? []).length})
                  </button>
                </div>
              ) : message.kickNotice ? (
                <p className="mt-1 text-sm italic text-[hsl(var(--muted-foreground))]">{message.content}</p>
              ) : (
                renderMessageBody(message.content, memberNames, message.deleted)
              )}
              {message.reactions && Object.keys(message.reactions).length > 0 && !message.voteKick && (
                <div className="mt-2 flex flex-wrap gap-1" data-testid={`message-reactions-${message.id}`}>
                  {Object.entries(message.reactions).map(([emoji, authors]) => (
                    <button key={emoji} type="button" className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] px-2 py-0.5 text-[11px]" onClick={() => onReact(message.id, emoji)} title={authors.join(', ')}>
                      {emoji} {authors.length}
                    </button>
                  ))}
                </div>
              )}
              {!message.deleted && !message.sfxId && !message.kickNotice && (
                <div className="mt-1 flex flex-wrap gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100" data-testid={`message-actions-${message.id}`}>
                  {!message.voteKick && (
                    <>
                      <button type="button" className="ghost-btn !h-7 !px-2 text-[10px]" onClick={() => onReply(message.id)} data-testid={`button-reply-${message.id}`}>Ответить</button>
                      {REACTION_EMOJIS.map((emoji) => (
                        <button key={emoji} type="button" className="ghost-btn !h-7 !w-7 !p-0 text-sm" onClick={() => onReact(message.id, emoji)} aria-label={`Реакция ${emoji}`}>{emoji}</button>
                      ))}
                    </>
                  )}
                  {message.isCurrentUser && !message.voteKick && (
                    <button type="button" className="ghost-btn !h-7 !px-2 text-[10px]" onClick={() => { const next = window.prompt('Новый текст сообщения', message.content); if (next != null && next.trim()) onEdit(message.id, next.trim()); }} data-testid={`button-edit-${message.id}`}>Изменить</button>
                  )}
                  {message.isCurrentUser && !message.voteKick && (
                    <button type="button" className="ghost-btn !h-7 !px-2 text-[10px] text-[hsl(var(--accent))]" onClick={() => { if (window.confirm('Удалить сообщение у всех?')) onDelete(message.id); }} data-testid={`button-delete-${message.id}`}>Удалить у всех</button>
                  )}
                  <button type="button" className="ghost-btn !h-7 !px-2 text-[10px]" onClick={() => onHideLocal(message.id)} data-testid={`button-hide-local-${message.id}`}>Скрыть у себя</button>
                  {!message.voteKick && (
                    <button type="button" className="ghost-btn !h-7 !px-2 text-[10px]" onClick={() => onPin(message.id, !message.pinned)} data-testid={`button-pin-${message.id}`}>{message.pinned ? 'Открепить' : 'Закрепить'}</button>
                  )}
                </div>
              )}
            </div>
          </article>
        );
      })}
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
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [sfxOpen, setSfxOpen] = useState(false);
  const slashOptions = slashCommandSuggestions(draft);
  const showSlashMenu = Boolean(slashOptions && slashOptions.length > 0 && !slashDismissed);
  const mentionState = mentionSuggestions(draft, memberNames);
  const showMentionMenu = Boolean(!showSlashMenu && mentionState && mentionState.matches.length > 0 && !mentionDismissed);

  useEffect(() => {
    setMentionDismissed(false);
    setSlashDismissed(false);
  }, [draft]);

  const pickSlash = (option: SlashCommandOption) => {
    onDraftChange(applySlashCommandSuggestion(draft, option));
    setSlashDismissed(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu && slashOptions?.[0]) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        pickSlash(slashOptions[0]);
        return;
      }
    }
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
      {showSlashMenu && slashOptions && (
        <div className="mention-menu" role="listbox" aria-label="Команды" data-testid="slash-command-menu">
          {slashOptions.map((option) => (
            <button
              key={option.cmd}
              type="button"
              role="option"
              className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[hsl(var(--muted)/.55)]"
              onMouseDown={(event) => {
                event.preventDefault();
                pickSlash(option);
              }}
              data-testid={`slash-option-${option.cmd}`}
            >
              <span className="text-sm font-semibold">{option.usage}</span>
              <span className="text-[11px] text-[hsl(var(--muted-foreground))]">{option.description}</span>
            </button>
          ))}
        </div>
      )}
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

export function Workspace() {
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
  const [joiningVoice, setJoiningVoice] = useState(false);
  const joiningVoiceRef = useRef(false);
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
  const [voiceBannerDismissed, setVoiceBannerDismissed] = useState(false);
  const [sideAlerts, setSideAlerts] = useState<Array<{ id: string; title: string; body: string }>>([]);
  const executedKickVotesRef = useRef<Set<string>>(new Set());
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(() => loadHiddenMessageIds(readStore<Server>(SERVER_KEY, seedServer).roomId ?? ''));
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
  /** Names for peers still in live WebRTC after control-plane presence dropped them. */
  const stickyVoiceNamesRef = useRef<Map<string, string>>(new Map());
  const [voiceTalkMode, setVoiceTalkMode] = useState<VoiceTalkMode>(() => loadVoiceTalkMode());
  const [pttKeyCode, setPttKeyCode] = useState<PttKeyCode>(() => loadPttKeyCode());
  const [muteHotkeyCode, setMuteHotkeyCode] = useState<PttKeyCode>(() => loadMuteHotkeyCode());
  const [deafenHotkeyCode, setDeafenHotkeyCode] = useState<PttKeyCode>(() => loadDeafenHotkeyCode());
  const [pttHeld, setPttHeld] = useState(false);
  const pttHeldRef = useRef(false);
  const [voiceQuality, setVoiceQuality] = useState<VoiceQualitySnapshot | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(() => Boolean(loadOnboardingGuide(readStore<Server>(SERVER_KEY, seedServer).roomId)));
  const voiceTalkModeRef = useRef(voiceTalkMode);
  const pttKeyCodeRef = useRef(pttKeyCode);
  const muteHotkeyCodeRef = useRef(muteHotkeyCode);
  const deafenHotkeyCodeRef = useRef(deafenHotkeyCode);
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
  muteHotkeyCodeRef.current = muteHotkeyCode;
  deafenHotkeyCodeRef.current = deafenHotkeyCode;
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
  const channelMessages = messages.filter((message) => {
    if (hiddenMessageIds.has(message.id)) return false;
    return message.channelId === selectedId || (!message.channelId && selectedId === 'general');
  });
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
      setMuteHotkeyCode(loadMuteHotkeyCode());
      setDeafenHotkeyCode(loadDeafenHotkeyCode());
      setVoiceOverlayEnabled(loadVoiceOverlayEnabled());
      setVoiceOverlayOpacity(loadVoiceOverlayOpacity());
      setVoiceOverlayInteractive(loadVoiceOverlayInteractive());
      if (activeVoice) applyEffectiveMicMute(userMutedRef.current, pttHeldRef.current, mode);
    };
    window.addEventListener('p2pchat-voice-settings', onVoiceSettings);
    return () => window.removeEventListener('p2pchat-voice-settings', onVoiceSettings);
  }, [activeVoice]);

  useEffect(() => {
    const onAudioSettings = () => {
      const mesh = voiceMeshRef.current ?? getActiveVoiceMesh();
      if (!mesh) return;
      mesh.setInputDevice(loadAudioInputId());
      mesh.setOutputDevice(loadAudioOutputId());
    };
    window.addEventListener('p2pchat-audio-settings', onAudioSettings);
    return () => window.removeEventListener('p2pchat-audio-settings', onAudioSettings);
  }, []);

  useEffect(() => {
    if (!isDesktopShell()) return;
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('set_voice_hotkey_vks', {
        pttVk: pttVkForCode(pttKeyCode),
        muteVk: hotkeyVkForCode(muteHotkeyCode),
        deafenVk: hotkeyVkForCode(deafenHotkeyCode),
      }).catch(() => {});
    });
  }, [pttKeyCode, muteHotkeyCode, deafenHotkeyCode]);

  useEffect(() => {
    const pttMode = voiceTalkMode === 'ptt';
    const muteBound = Boolean(muteHotkeyCode);
    const deafenBound = Boolean(deafenHotkeyCode);
    const needWatch = Boolean(activeVoice && (pttMode || muteBound || deafenBound));

    if (!needWatch) {
      if (isDesktopShell()) {
        void import('@tauri-apps/api/core').then(({ invoke }) => {
          void invoke('stop_ptt_watch').catch(() => {});
        });
      }
      setPttHeld(false);
      pttHeldRef.current = false;
      return;
    }

    let unlistenDown: (() => void) | undefined;
    let unlistenUp: (() => void) | undefined;
    let unlistenMute: (() => void) | undefined;
    let unlistenDeafen: (() => void) | undefined;
    let closed = false;

    const setHeld = (held: boolean) => {
      if (!pttMode) return;
      pttHeldRef.current = held;
      setPttHeld(held);
      applyEffectiveMicMute(userMutedRef.current, held, 'ptt');
    };

    const toggleMute = () => {
      setMuted((value) => {
        const next = !value;
        applyEffectiveMicMute(next, pttHeldRef.current, voiceTalkModeRef.current);
        return next;
      });
    };

    const toggleDeafen = () => {
      setDeafened((value) => {
        const next = !value;
        voiceMeshRef.current?.setDeafened(next);
        return next;
      });
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat) return;
      if (event.code === 'Mouse4' || event.code === 'Mouse5') return;
      const code = event.code;
      if (pttMode && code === pttKeyCodeRef.current) {
        event.preventDefault();
        setHeld(true);
        return;
      }
      // Desktop: mute/deafen приходят из глобального watch (иначе двойной toggle при фокусе).
      if (isDesktopShell()) return;
      if (muteBound && code === muteHotkeyCodeRef.current && code !== pttKeyCodeRef.current) {
        event.preventDefault();
        toggleMute();
        return;
      }
      if (
        deafenBound
        && code === deafenHotkeyCodeRef.current
        && code !== pttKeyCodeRef.current
        && code !== muteHotkeyCodeRef.current
      ) {
        event.preventDefault();
        toggleDeafen();
      }
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (!pttMode || event.code !== pttKeyCodeRef.current) return;
      event.preventDefault();
      setHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    if (isDesktopShell()) {
      const pttVk = pttMode ? pttVkForCode(pttKeyCode) : 0;
      const muteVk = hotkeyVkForCode(muteHotkeyCode);
      const deafenVk = hotkeyVkForCode(deafenHotkeyCode);
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void invoke('start_ptt_watch', { vk: pttVk, muteVk, deafenVk }).catch(() => {});
      });
      void import('@tauri-apps/api/event').then(({ listen }) => {
        if (pttMode) {
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
        }
        if (muteBound) {
          void listen('hotkey-mute-toggle', () => {
            if (!closed) toggleMute();
          }).then((fn) => {
            unlistenMute = fn;
          });
        }
        if (deafenBound) {
          void listen('hotkey-deafen-toggle', () => {
            if (!closed) toggleDeafen();
          }).then((fn) => {
            unlistenDeafen = fn;
          });
        }
      });
    }

    if (pttMode) applyEffectiveMicMute(userMutedRef.current, false, 'ptt');

    return () => {
      closed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      unlistenDown?.();
      unlistenUp?.();
      unlistenMute?.();
      unlistenDeafen?.();
      if (isDesktopShell()) {
        void import('@tauri-apps/api/core').then(({ invoke }) => {
          void invoke('stop_ptt_watch').catch(() => {});
        });
      }
    };
  }, [activeVoice, voiceTalkMode, pttKeyCode, muteHotkeyCode, deafenHotkeyCode]);

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
      setVoiceQuality(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const mesh = voiceMeshRef.current ?? getActiveVoiceMesh();
      if (!mesh) {
        if (!cancelled) setVoiceQuality(null);
        return;
      }
      try {
        const snap = await mesh.collectQualitySnapshot();
        if (!cancelled) setVoiceQuality(snap);
      } catch {
        if (!cancelled) setVoiceQuality(null);
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeVoice, voicePeerStatus]);

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
        .filter((peer) => peer.id !== peerId)
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
          const nextMembers = view.state.members;
          const mergedVoiceRooms = next.voiceRooms.map((room) => {
            if (room.id !== voiceChannelRef.current) return room;
            const byId = new Map(room.participants.map((person) => [person.id, person]));
            if (peerId) byId.set(peerId, { id: peerId, name: displayName });
            for (const [id, name] of stickyVoiceNamesRef.current) {
              if (!byId.has(id)) byId.set(id, { id, name });
            }
            const mesh = voiceMeshRef.current;
            if (mesh) {
              for (const id of mesh.listLivePeerIds()) {
                if (id === peerId || byId.has(id)) continue;
                byId.set(id, {
                  id,
                  name:
                    stickyVoiceNamesRef.current.get(id) ??
                    nextMembers.find((member) => member.id === id)?.name ??
                    id.slice(0, 8),
                });
              }
            }
            const participants = [...byId.values()];
            return {
              ...room,
              participants,
              participantCount: participants.length,
              state: participants.length > 0 ? ('live' as const) : ('ready' as const),
            };
          });
          setVoiceRooms(mergedVoiceRooms);
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
            const fromState = view.state.voiceParticipants[voiceChannelRef.current] ?? [];
            for (const peer of fromState) stickyVoiceNamesRef.current.set(peer.id, peer.name);
            const mesh = voiceMeshRef.current;
            if (!mesh) {
              setVoicePeers(fromState);
            } else {
              const ids = new Set(fromState.map((peer) => peer.id));
              const extras = mesh
                .listLivePeerIds()
                .filter((id) => id !== peerId && !ids.has(id))
                .map((id) => ({
                  id,
                  name:
                    stickyVoiceNamesRef.current.get(id) ??
                    nextMembers.find((member) => member.id === id)?.name ??
                    id.slice(0, 8),
                }));
              setVoicePeers([...fromState, ...extras]);
            }
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
            if (parsed.kind === 'react' || parsed.kind === 'edit' || parsed.kind === 'delete' || parsed.kind === 'pin' || parsed.kind === 'votekick' || parsed.kind === 'kick' || parsed.kind === 'unknown') {
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
          stickyVoiceNamesRef.current.set(event.peerId, event.displayName);
          if (event.peerId !== peerId && !deafenedRef.current) {
            playUiSound('voice-join');
            void notifyDesktop('voice-join', event.displayName, 'Подключился к голосовому каналу');
          }
          if (event.peerId !== peerId) triggerPatriotPopup();
          void voiceMeshRef.current?.addPeer(event.peerId, peerId < event.peerId).catch((error) => {
            setToast(error instanceof Error ? error.message : 'Не удалось подключить голосовой канал');
          });
        } else {
          stickyVoiceNamesRef.current.delete(event.peerId);
          // Intentional voice_leave: tear down mesh. WS-only drops don't emit this —
          // presence clears voiceParticipants while WebRTC may still be live (kept via merge).
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

  useEffect(() => {
    if (server.roomId) setHiddenMessageIds(loadHiddenMessageIds(server.roomId));
  }, [server.roomId]);

  const sendMessage = () => {
    const body = draft.trim();
    if (!body) return;
    const command = tryParseChatCommand(body, {
      selfName: displayName,
      selfId: peerId,
      members: members.map((member) => ({ id: member.id, name: member.name, online: member.online })),
    });
    if (command) {
      if (command.kind === 'error' || command.kind === 'help') {
        setToast(command.text);
        setDraft('');
        return;
      }
      if (command.kind === 'roll') {
        if (!sendChatPayload(command.text)) return;
        setDraft('');
        setReplyToId(null);
        return;
      }
      if (command.kind === 'votekick') {
        if (!sendChatPayload(encodeVoteKick(command.targetId, command.targetName))) return;
        setDraft('');
        setReplyToId(null);
        setToast(`Голосование: кикнуть ${command.targetName}`);
        return;
      }
    }
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
  const onMessageHideLocal = (targetId: string) => {
    const roomId = server.roomId ?? '';
    setHiddenMessageIds(hideMessageLocally(roomId, targetId));
  };
  const onVoteYes = (voteMessageId: string) => {
    sendChatPayload(encodeReact(voteMessageId, '✅', 'add'));
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
    onHideLocal: onMessageHideLocal,
    onPin: onMessagePin,
    onVoteYes,
  };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } };
  const addChannel = (channelName: string, type: ChannelType) => {
    const sameType = channels.filter((channel) => channel.type === type).length;
    const limit = type === 'voice' ? LIMITS.maxVoiceChannels : LIMITS.maxTextChannels;
    if (sameType >= limit) {
      setToast(type === 'voice' ? 'Лимит голосовых каналов: 5' : 'Лимит текстовых каналов: 5');
      return;
    }
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
    if (joiningVoiceRef.current) return;
    if (activeVoice === room.id) {
      setSelectedId(room.id);
      return;
    }
    if (server.roomId) {
      if (connectionStatus !== 'connected') {
        setToast('Нет соединения с комнатой — подождите или откройте Диагностику');
        debugLog('voice', 'join blocked: not connected', { roomId: room.id, connectionStatus });
        return;
      }
      joiningVoiceRef.current = true;
      setJoiningVoice(true);
      setSelectedId(room.id);
      setToast('Запрашиваем микрофон…');
      debugLog('voice', 'join requested', { roomId: room.id, connectionStatus, peerId });
      try {
        if (activeVoice && activeVoice !== room.id) {
          sessionRef.current?.setVoiceChannel(null);
          // keep mesh; just switch channel membership after start
        }
        const mesh = voiceMeshRef.current ?? new VoiceMesh(
          peerId,
          (toPeerId, data) => {
            const ok = sessionRef.current?.sendSignal(toPeerId, data) ?? false;
            return ok;
          },
          {
            onPeerStatus: (statusPeerId, status, detail) => {
              setVoicePeerStatus(status);
              if (status === 'connecting') setVoiceHint(detail || 'Соединяем…');
              else if (status === 'connected') {
                setVoiceHint('Голос подключен');
                setSideAlerts((current) => current.filter((item) => item.id !== 'voice-turn'));
              } else if (status === 'failed') {
                setVoiceHint(detail || 'Нет прямого пути — нужен TURN');
                setSideAlerts((current) => [
                  ...current.filter((item) => item.id !== 'voice-turn'),
                  {
                    id: 'voice-turn',
                    title: 'Голос через интернет не подключился',
                    body: detail || 'Часто это NAT. Metered/свой TURN — в Настройки → Сеть.',
                  },
                ]);
              } else setVoiceHint('');
              if (status === 'failed' || status === 'closed') {
                stickyVoiceNamesRef.current.delete(statusPeerId);
                setVoicePeers((current) => current.filter((peer) => peer.id !== statusPeerId));
              }
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
        debugLog('voice', 'join announced', { roomId: room.id });
      } catch (error) {
        debugLog('voice', 'join failed', error, 'error');
        setToast(error instanceof Error ? error.message : 'Не удалось получить доступ к микрофону');
        return;
      } finally {
        joiningVoiceRef.current = false;
        setJoiningVoice(false);
      }
    }
    setActiveVoice(room.id);
    setVoiceBannerDismissed(false);
    setVoiceRooms((current) => current.map((item) => {
      if (item.id !== room.id) return item;
      const already = item.participants.some((person) => person.id === peerId);
      const participants = already
        ? item.participants
        : [...item.participants, { id: peerId, name: displayName }];
      return {
        ...item,
        participantCount: participants.length,
        state: 'live',
        participants,
      };
    }));
    playUiSound('voice-enter');
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
    stickyVoiceNamesRef.current.clear();
    setVoiceHint('');
    setVoicePeerStatus(null);
    setVoiceQuality(null);
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
    setVoiceRooms((current) => current.map((item) => {
      if (item.id !== activeVoice) return item;
      const participants = item.participants.filter((person) => person.id !== peerId);
      return {
        ...item,
        participantCount: participants.length,
        participants,
        state: participants.length === 0 ? ('ready' as const) : ('live' as const),
      };
    }));
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
    const voiceRoom = voiceRooms.find((room) => room.id === id);
    if (voiceRoom && activeVoice !== id && !joiningVoiceRef.current) {
      void joinVoice(voiceRoom);
    }
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

  useEffect(() => {
    const onlineCount = members.filter((member) => member.online).length;
    const needed = Math.max(1, Math.ceil(onlineCount / 2));
    for (const message of messages) {
      const parsed = parseWireText(message.content);
      if (parsed.kind === 'kick' && parsed.targetId === peerId) {
        setToast('Вас исключили голосованием. Можно зайти снова по ссылке.');
        leaveServer();
        return;
      }
      if (parsed.kind !== 'votekick') continue;
      if (executedKickVotesRef.current.has(message.id)) continue;
      const folded = foldChatMessages(
        messages.map((item) => ({
          id: item.id,
          channelId: item.channelId,
          author: item.author,
          authorId: item.authorId,
          avatar: item.avatar,
          content: item.content,
          timestamp: item.timestamp,
          isCurrentUser: item.isCurrentUser,
          delivery: item.delivery,
        })),
      );
      const voteMsg = folded.find((item) => item.id === message.id);
      const yes = voteMsg?.reactions?.['✅']?.length ?? 0;
      if (yes < needed) continue;
      executedKickVotesRef.current.add(message.id);
      if (!sessionRef.current) continue;
      if (message.isCurrentUser || peerId <= (message.authorId ?? '')) {
        void sessionRef.current.sendChat(message.channelId || selectedId, encodeKickNotice(parsed.targetId, parsed.targetName));
      }
    }
  // leaveServer intentionally omitted to avoid re-bind loops
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, members, peerId, selectedId]);

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
      voiceTalkMode={voiceTalkMode}
      pttHeld={pttHeld}
      pttKeyLabel={labelForHotkeyCode(pttKeyCode)}
      voiceQuality={activeVoice ? voiceQuality : null}
      sharingScreen={sharingScreen}
      onToggleScreenShare={activeVoice ? () => void toggleScreenShare() : undefined}
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
      {showSetupGuide && (
        <div className="mx-4 mt-3 rounded-xl border border-[hsl(var(--primary)/.4)] bg-[hsl(var(--primary)/.1)] px-4 py-3 text-sm" data-testid="banner-setup-guide">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Сервер создан — три шага</div>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5 text-[hsl(var(--muted-foreground))]">
                <li className={getPublicUrl() ? 'text-[hsl(var(--foreground))]' : ''}>
                  Туннель {getPublicUrl() ? 'готов ✓' : 'поднимается…'}
                </li>
                <li>Нажмите «Пригласить» и отправьте ссылку другу</li>
                <li>Оба зайдите в голосовой канал — чат уже работает без голоса</li>
              </ol>
            </div>
            <button
              type="button"
              className="icon-btn shrink-0"
              aria-label="Скрыть подсказку"
              onClick={() => {
                dismissOnboardingGuide();
                setShowSetupGuide(false);
              }}
              data-testid="button-dismiss-setup-guide"
            >
              <X size={16} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="primary-btn !py-2 text-xs" onClick={() => setShowInviteDialog(true)} data-testid="button-guide-invite">
              Пригласить друзей
            </button>
            <button
              type="button"
              className="ghost-btn !py-2 text-xs"
              onClick={() => {
                dismissOnboardingGuide();
                setShowSetupGuide(false);
              }}
              data-testid="button-guide-dismiss"
            >
              Понятно
            </button>
          </div>
        </div>
      )}
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
          <div className={`shrink-0 ${activeVoice === selectedVoice.id ? 'border-b border-[hsl(var(--border))] px-4 py-3 sm:px-5' : ''}`}>
            <div className={`flex flex-col gap-2 ${activeVoice === selectedVoice.id ? 'sm:flex-row sm:items-center sm:justify-between' : 'items-center'}`}>
              <div className={`flex items-center gap-3 ${activeVoice === selectedVoice.id ? '' : 'flex-col'}`}>
                <div className="relative grid h-12 w-12 place-items-center rounded-[16px] bg-[hsl(var(--primary)/.18)] text-[hsl(var(--secondary))]">
                  <Volume2 size={22} />
                  {activeVoice === selectedVoice.id && <span className="animate-pulse-dot absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-[hsl(var(--primary))]" />}
                </div>
                <div className={activeVoice === selectedVoice.id ? 'min-w-0 text-left' : 'text-center'}>
                  <p className="font-mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--muted-foreground))]">Голосовая комната</p>
                  <h2 className="font-display text-xl font-bold tracking-[-.06em]">{selectedVoice.name}</h2>
                  {activeVoice === selectedVoice.id && voiceStatusLabel && (
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]" data-testid="text-voice-status">{voiceStatusLabel}</p>
                  )}
                  {activeVoice === selectedVoice.id && voiceQuality && (
                    <p className="mt-1 font-mono text-[11px]" data-testid="text-voice-quality">
                      <span aria-hidden>{voiceQuality.level === 'ok' ? '🟢' : voiceQuality.level === 'fair' ? '🟡' : '🔴'}</span>
                      {' '}
                      {voiceQuality.rttMs != null ? `${voiceQuality.rttMs} ms` : 'измеряем…'}
                      <span className="ml-2 text-[hsl(var(--muted-foreground))]">
                        {voiceQuality.path === 'relay' ? 'через TURN' : voiceQuality.path === 'srflx' ? 'STUN' : voiceQuality.path === 'host' ? 'прямой P2P' : ''}
                      </span>
                    </p>
                  )}
                  {activeVoice === selectedVoice.id && voiceTalkMode === 'ptt' && (
                    <p className={`mt-1 text-xs font-semibold ${pttHeld ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} data-testid="text-ptt-hint">
                      {pttHeld ? `Говорите · ${labelForHotkeyCode(pttKeyCode)}` : `PTT: зажмите ${labelForHotkeyCode(pttKeyCode)}`}
                    </p>
                  )}
                  {activeVoice !== selectedVoice.id && (
                    <p className="mt-2 max-w-sm text-sm leading-6 text-[hsl(var(--muted-foreground))]">Нажмите «войти», чтобы разрешить микрофон и подключиться по WebRTC.</p>
                  )}
                </div>
              </div>
              <div className={`flex flex-wrap items-center gap-2 ${activeVoice === selectedVoice.id ? '' : 'mt-3 flex-col'}`}>
                {activeVoice !== selectedVoice.id && (
                  <button
                    className="primary-btn !h-9 !px-3 text-xs"
                    disabled={joiningVoice}
                    onClick={() => void joinVoice(selectedVoice)}
                    data-testid="button-main-voice-toggle"
                  >
                    {joiningVoice ? <><Radio size={14} /> Подключаем…</> : <><Radio size={14} /> Войти</>}
                  </button>
                )}
                <div className="flex items-center gap-2 text-[11px] text-[hsl(var(--muted-foreground))]"><Users size={13} /> {selectedVoice.participantCount} в комнате</div>
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
      {sideAlerts.length > 0 && (
        <div className="mt-auto space-y-2 pb-2" data-testid="side-alerts">
          {sideAlerts.map((alert) => (
            <div key={alert.id} className="rounded-xl border border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.1)] px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <strong className="leading-4">{alert.title}</strong>
                <button
                  type="button"
                  className="icon-btn !h-6 !w-6"
                  aria-label="Скрыть"
                  onClick={() => {
                    setSideAlerts((current) => current.filter((item) => item.id !== alert.id));
                    if (alert.id === 'voice-turn') setVoiceBannerDismissed(true);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
              <p className="mt-1 leading-4 text-[hsl(var(--muted-foreground))]">{alert.body}</p>
              {alert.id === 'voice-turn' && (
                <button type="button" className="ghost-btn mt-2 !h-7 !px-2 text-[10px]" onClick={() => setOverlay('settings')}>Настройки</button>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
    {showChannelDialog && <CreateChannelDialog onClose={() => setShowChannelDialog(false)} onCreate={addChannel} />}
    {showInviteDialog && (
      <InviteDialog
        server={server}
        onClose={() => setShowInviteDialog(false)}
        onNotify={notify}
        onInviteUpdated={(invite) => setServer((current) => ({ ...current, invite }))}
      />
    )}
    {overlay === 'diagnostics' && <div className="fixed inset-x-0 bottom-0 z-[80] overflow-auto bg-[hsl(var(--background))]" style={{ top: 'var(--app-titlebar-h, 36px)' }}><Diagnostics onClose={() => setOverlay(null)} /></div>}
    {overlay === 'settings' && <div className="fixed inset-x-0 bottom-0 z-[80] overflow-auto bg-[hsl(var(--background))]" style={{ top: 'var(--app-titlebar-h, 36px)' }}><SettingsPage onClose={() => setOverlay(null)} /></div>}
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

