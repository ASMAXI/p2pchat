# P2PChat

Приватный групповой мессенджер без постоянного облачного сервера: каждый desktop может быть peer и временным координатором. Комната держится, пока онлайн хотя бы один desktop с reachable endpoint.

## Архитектура

```
Текст + signaling  →  control plane (локальный hub + авто Cloudflare Quick Tunnel)
Голос              →  mesh WebRTC + встроенный free TURN (свой TURN — позже / Pro)
```

Друзьям **не нужны** ngrok-аккаунт и ручной Metered: desktop сам скачивает `cloudflared` и поднимает туннель; TURN по умолчанию — Open Relay.

### Временные логи (тест)

В приложении: **Диагностика** → блок «Временные логи» → **Копировать** или **Скачать .txt**.  
Каждый участник после проверки присылает свой файл — там туннель, session, ICE/голос (без текста чата).

## Запуск для друзей (desktop)

1. Установить сборку Windows (Actions → installer).
2. Создать комнату — подождать авто-туннель (первый раз скачает cloudflared).
3. Скопировать invite другу.
4. Голос: войти в голосовой канал (free TURN уже внутри).

Если туннель не поднялся — Настройки → «Поднять / обновить туннель».

## Разработка

```bash
pnpm install
pnpm run test
cd artifacts/p2pchat && pnpm desktop:dev
```

Опционально стабильный TURN через ваш Metered-аккаунт (free tier):

```env
# artifacts/p2pchat/.env
VITE_METERED_API_KEY=...
VITE_METERED_APP_NAME=yourapp
```

Свой VPS/coturn позже: Настройки → расширенные → свой TURN (перекрывает free).

## Last-peer

Пока `online >= 1` и у координатора есть публичный endpoint (авто-туннель), сессия жива. Чтобы интернет-друзья пережили ваш выход, у преемника тоже должен быть desktop с авто-туннелем.

## Структура

```
lib/p2p-*              # identity, protocol, room session
artifacts/api-server   # опциональный bootstrap
artifacts/p2pchat      # UI + Tauri (local_hub + cloudflared tunnel)
```
