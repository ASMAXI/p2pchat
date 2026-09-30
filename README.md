# P2PChat

Приватный групповой мессенджер без постоянного облачного сервера: каждый desktop-клиент может быть peer и временным координатором комнаты. При уходе координатора роль мигрирует к оставшимся участникам.

## Что реализовано (релизный каркас по ТЗ)

- Криптографическая identity (Ed25519), стабильный `peerId`
- End-to-end шифрование содержимого сообщений (AES-256-GCM), узел видит только ciphertext
- Invite со ссылкой: room / token / room key / endpoints
- Репликация snapshot + signed events, dedup, offline outbox
- Coordinator election / migration (epoch), split-brain resolution
- Встроенный peer-узел в Tauri (`local_hub.rs`)
- Опциональный bootstrap Node-сервер (`artifacts/api-server`) для интернета / web
- Unit + критический E2E (crash координатора → takeover → возврат без дублей)

Голос (WebRTC) — Phase 2 поверх стабильного text core; signaling уже через control plane.

## Структура

```
lib/p2p-identity   # ключи, подписи, AEAD
lib/p2p-protocol   # wire types / invite / proof strings
lib/p2p-room       # election, event log, migration, RoomSession
artifacts/api-server   # bootstrap node (alwaysHost)
artifacts/p2pchat      # UI + Tauri desktop
```

## Запуск

```bash
pnpm install
pnpm run test
pnpm run typecheck
```

### Desktop (рекомендуется)

```bash
cd artifacts/p2pchat
pnpm desktop:dev
```

Создайте комнату — локальный узел поднимется сам. Invite для LAN-друзей содержит ваш LAN IP. Поле «Резервный bootstrap» нужно только для интернета / web.

### Bootstrap-узел (опционально)

```powershell
cd artifacts/api-server
pnpm run build
$env:PORT="5000"; node --enable-source-maps .\dist\index.mjs
```

В клиенте укажите `http://<host>:5000` как bootstrap.

### Web UI

```bash
pnpm --filter @workspace/p2pchat run dev
```

Браузер не хостит узел сам — нужен desktop-peer или bootstrap.

## Ограничения 1.0

- 2–25 участников в комнате
- Полная NAT/TURN hardening — следующий слой
- Файлы и voice polish — Phase 2
- Web без desktop не может стать координатором
