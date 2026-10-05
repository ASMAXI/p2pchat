import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, ChevronDown, Signal } from 'lucide-react';
import { checkForAppUpdate, currentAppVersion, installAppUpdate, getBootstrapOrigin, getPublicUrl, isDesktopShell, loadIceSettings, loadRoomMeta, refreshCoordinatorInvite, restartPublicTunnel, saveIceSettings, setBootstrapOrigin, setPublicUrl, warmIceServers, type AppUpdateInfo } from '@/lib/p2p-client';
import { getAutostartEnabled, setAutostartEnabled } from '@/lib/autostart';
import { APP_THEMES, loadTheme, saveTheme, type AppThemeId } from '@/lib/theme';
import { listAudioDevices, loadAudioInputId, loadAudioOutputId, saveAudioInputId, saveAudioOutputId } from '@/lib/audio-settings';
import { STARTUP_SOUND_OPTIONS, loadStartupSoundId, loadUiSoundsEnabled, playUiSound, previewStartupSound, saveStartupSoundId, saveUiSoundsEnabled, type StartupSoundId } from '@/lib/ui-sounds';
import { HOTKEY_NONE, isHotkeyCodeSupported, labelForHotkeyCode, loadDeafenHotkeyCode, loadMuteHotkeyCode, loadPttKeyCode, loadVoiceOverlayEnabled, loadVoiceOverlayInteractive, loadVoiceOverlayOpacity, loadVoiceTalkMode, hotkeyVkForCode, mouseButtonToHotkeyCode, pttVkForCode, saveDeafenHotkeyCode, saveMuteHotkeyCode, savePttKeyCode, saveVoiceOverlayEnabled, saveVoiceOverlayInteractive, saveVoiceOverlayOpacity, saveVoiceTalkMode, VOICE_OVERLAY_PAYLOAD_KEY, type PttKeyCode, type VoiceOverlayPayload, type VoiceTalkMode } from '@/lib/voice-settings';
import { TUNNEL_PROVIDER_OPTIONS, loadNgrokAuthToken, loadTunnelProvider, loadZrokToken, saveNgrokAuthToken, saveTunnelProvider, saveZrokToken, type TunnelProviderId } from '@/lib/tunnel-settings';
import { SERVER_KEY, readStore, writeStore, seedServer } from '@/lib/app-shared';
import { BrandName } from '@/components/app-brand';
import { NetworkHealthPanel } from '@/components/network-health-panel';

function HotkeyBindControl({
  label,
  value,
  allowClear = false,
  onChange,
  testId,
}: {
  label: string;
  value: PttKeyCode;
  allowClear?: boolean;
  onChange: (code: PttKeyCode) => void;
  testId: string;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!capturing) return;
    const finish = (code: PttKeyCode) => {
      if (!isHotkeyCodeSupported(code)) {
        setError('Эту клавишу назначить нельзя');
        return;
      }
      setError('');
      onChange(code);
      setCapturing(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        setCapturing(false);
        setError('');
        return;
      }
      if (allowClear && event.code === 'Backspace') {
        setError('');
        onChange(HOTKEY_NONE);
        setCapturing(false);
        return;
      }
      finish(event.code);
    };
    const onMouseDown = (event: MouseEvent) => {
      const code = mouseButtonToHotkeyCode(event.button);
      if (!code) return;
      event.preventDefault();
      event.stopPropagation();
      finish(code);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [allowClear, capturing, onChange]);

  return (
    <div className="mt-3" data-testid={testId}>
      <div className="field-label">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <div
          className="min-w-[7rem] flex-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.35)] px-3 py-2 font-mono text-xs font-semibold"
          data-testid={`${testId}-value`}
        >
          {capturing ? 'Нажмите клавишу или кнопку мыши…' : labelForHotkeyCode(value)}
        </div>
        <button
          type="button"
          className="ghost-btn text-xs"
          onClick={() => {
            setError('');
            setCapturing(true);
          }}
          data-testid={`${testId}-bind`}
        >
          {capturing ? 'Жду…' : 'Назначить'}
        </button>
        {allowClear && value && !capturing && (
          <button
            type="button"
            className="ghost-btn text-xs"
            onClick={() => {
              setError('');
              onChange(HOTKEY_NONE);
            }}
            data-testid={`${testId}-clear`}
          >
            Сброс
          </button>
        )}
        {capturing && (
          <button
            type="button"
            className="ghost-btn text-xs"
            onClick={() => {
              setCapturing(false);
              setError('');
            }}
            data-testid={`${testId}-cancel`}
          >
            Отмена
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
        {capturing
          ? allowClear
            ? 'Любая клавиша / боковая кнопка мыши. Esc — отмена, Backspace — сброс.'
            : 'Любая клавиша / боковая кнопка мыши. Esc — отмена.'
          : error || null}
      </p>
      {error && !capturing && (
        <p className="mt-1 text-[11px] text-[hsl(var(--accent))]">{error}</p>
      )}
    </div>
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
    <div
      className={`mt-3 overflow-hidden rounded-xl border transition ${
        open
          ? 'border-[hsl(var(--primary)/.55)] bg-[hsl(var(--primary)/.08)] shadow-[inset_0_0_0_1px_hsl(var(--primary)/.12)]'
          : 'border-[hsl(var(--border))] bg-[hsl(var(--card)/.4)]'
      }`}
      data-testid={testId}
    >
      <button
        type="button"
        className={`flex w-full items-start justify-between gap-3 px-4 py-3.5 text-left transition ${
          open
            ? 'bg-[hsl(var(--primary)/.14)] hover:bg-[hsl(var(--primary)/.18)]'
            : 'hover:bg-[hsl(var(--muted)/.45)]'
        }`}
        onClick={() => onToggle(id)}
        aria-expanded={open}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <span className="min-w-0">
          <span className={`block text-sm font-bold ${open ? 'text-[hsl(var(--foreground))]' : ''}`}>{title}</span>
          {hint && (
            <span className={`mt-0.5 block text-xs ${open ? 'text-[hsl(var(--secondary))]' : 'text-[hsl(var(--muted-foreground))]'}`}>
              {hint}
            </span>
          )}
        </span>
        <ChevronDown
          size={18}
          className={`mt-0.5 shrink-0 transition ${
            open ? 'rotate-180 text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'
          }`}
        />
      </button>
      {open && (
        <div className="border-t border-[hsl(var(--primary)/.25)] bg-[hsl(var(--background)/.72)] px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

export function SettingsPage({ onClose }: { onClose?: () => void }) {
  const [, setLocation] = useLocation();
  const roomMeta = loadRoomMeta();
  const goBack = () => (onClose ? onClose() : setLocation(roomMeta?.roomId ? '/server' : '/'));
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
  const [muteHotkeyCode, setMuteHotkeyCode] = useState<PttKeyCode>(() => loadMuteHotkeyCode());
  const [deafenHotkeyCode, setDeafenHotkeyCode] = useState<PttKeyCode>(() => loadDeafenHotkeyCode());
  const [voiceOverlayEnabled, setVoiceOverlayEnabled] = useState(() => loadVoiceOverlayEnabled());
  const [voiceOverlayOpacity, setVoiceOverlayOpacity] = useState(() => loadVoiceOverlayOpacity());
  const [voiceOverlayInteractive, setVoiceOverlayInteractive] = useState(() => loadVoiceOverlayInteractive());
  const [updateProgress, setUpdateProgress] = useState<{ loaded: number; total: number | null; phase: string } | null>(null);
  const [tunnelProvider, setTunnelProvider] = useState<TunnelProviderId>(() => loadTunnelProvider());
  const [ngrokToken, setNgrokToken] = useState(() => loadNgrokAuthToken());
  const [zrokToken, setZrokToken] = useState(() => loadZrokToken());

  const pushVoiceHotkeysToNative = (ptt: PttKeyCode, mute: PttKeyCode, deafen: PttKeyCode) => {
    if (!isDesktopShell()) return;
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('set_voice_hotkey_vks', {
        pttVk: pttVkForCode(ptt),
        muteVk: hotkeyVkForCode(mute),
        deafenVk: hotkeyVkForCode(deafen),
      }).catch(() => {});
    });
  };

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
    if (!updateInfo.sha256) {
      setUpdateMsg('В релизе нет SHA-256 — откройте страницу релиза и скачайте установщик вручную.');
      window.open(updateInfo.releaseUrl, '_blank');
      return;
    }
    setUpdateBusy(true);
    setUpdateProgress({ loaded: 0, total: null, phase: 'download' });
    setUpdateMsg(`Скачиваем Drift ${updateInfo.latestVersion}… Приложение закроется. Подтвердите запрос Windows (администратор) — иначе файлы в Program Files не заменятся.`);
    try {
      await installAppUpdate(updateInfo.downloadUrl, (loaded, total, phase) => {
        setUpdateProgress({ loaded, total, phase });
      }, updateInfo.sha256);
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
    <div className="noise relative h-full min-h-0 overflow-auto app-grid" style={{ background: 'hsl(var(--background))' }}>
      {updateProgress && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[hsl(var(--background)/.85)] backdrop-blur-sm" data-testid="overlay-update-progress">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl">
            <div className="text-sm font-bold">Обновление Drift</div>
            <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
              {updateProgress.phase === 'install'
                ? 'Запуск установщика…'
                : updateProgress.phase === 'verify'
                  ? 'Проверка SHA-256…'
                  : 'Скачивание…'}{' '}
              Не закрывайте окно.
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
        <Link href={roomMeta?.roomId ? '/server' : '/'} className="flex items-center gap-3" data-testid="link-settings-back" onClick={(event) => { if (onClose) { event.preventDefault(); onClose(); } }}>
          <div className="server-mark" style={{ width: 35, height: 35, borderRadius: 10 }}><Signal size={17} /></div>
          <BrandName className="text-lg" />
        </Link>
        <button className="ghost-btn" onClick={goBack} data-testid="button-settings-back">
          <ArrowRight size={15} className="rotate-180" /> {roomMeta?.roomId && !onClose ? 'В комнату' : 'Назад'}
        </button>
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
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Меняются сразу, даже если вы уже в голосовом канале.</p>
            <label className="field-label mt-3" htmlFor="audio-input">Вход (микрофон)</label>
            <select
              id="audio-input"
              className="field-input"
              value={audioInputId}
              onChange={(event) => {
                const id = event.target.value;
                setAudioInputId(id);
                saveAudioInputId(id);
                window.dispatchEvent(new CustomEvent('p2pchat-audio-settings'));
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
                window.dispatchEvent(new CustomEvent('p2pchat-audio-settings'));
              }}
              data-testid="select-audio-output"
            >
              <option value="">Системный по умолчанию</option>
              {audioOutputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label || `Выход ${device.deviceId.slice(0, 8)}`}</option>
              ))}
            </select>
          </SettingsSection>

          <SettingsSection id="voice" title="Голос и оверлей" hint="PTT, mute/deafen и мини-войс поверх игр" open={openSection === 'voice'} onToggle={toggleSection} testId="settings-section-voice">
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
              <HotkeyBindControl
                label="Клавиша PTT"
                value={pttKeyCode}
                testId="hotkey-ptt"
                onChange={(code) => {
                  setPttKeyCode(code);
                  savePttKeyCode(code);
                  pushVoiceHotkeysToNative(code, muteHotkeyCode, deafenHotkeyCode);
                  window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
                }}
              />
            )}
            <HotkeyBindControl
              label="Заглушить / разглушить микрофон"
              value={muteHotkeyCode}
              allowClear
              testId="hotkey-mute"
              onChange={(code) => {
                setMuteHotkeyCode(code);
                saveMuteHotkeyCode(code);
                pushVoiceHotkeysToNative(pttKeyCode, code, deafenHotkeyCode);
                window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
              }}
            />
            <HotkeyBindControl
              label="Выключить / включить уши"
              value={deafenHotkeyCode}
              allowClear
              testId="hotkey-deafen"
              onChange={(code) => {
                setDeafenHotkeyCode(code);
                saveDeafenHotkeyCode(code);
                pushVoiceHotkeysToNative(pttKeyCode, muteHotkeyCode, code);
                window.dispatchEvent(new CustomEvent('p2pchat-voice-settings'));
              }}
            />
            <p className="mt-2 text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
              Назначьте любую клавишу или боковую кнопку мыши. Глобально в голосовом канале (desktop). Не совпадайте с PTT.
            </p>
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
                  Вход участников на сервер, вход в голос, чат. Ваш вход в голосовой канал — отдельный звук.
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

          <SettingsSection id="network" title="Сеть" hint="Network Health · туннель" open={openSection === 'network'} onToggle={toggleSection} testId="settings-section-network">
            <NetworkHealthPanel />
            <p className="mt-4 text-xs text-[hsl(var(--muted-foreground))]">
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
                  Опционально. В разных сетях без TURN голос часто не поднимается — можно указать Metered API key или свой coturn. Без ключа остаётся бесплатный Open Relay (не всегда работает).
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

