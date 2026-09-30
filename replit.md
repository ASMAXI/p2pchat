## P2PChat

Закрытый мессенджер для небольших групп: desktop-клиент поднимает локальный peer-узел, комната реплицируется между участниками, роль координатора мигрирует при уходе хоста.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — optional bootstrap node (порт 5000 по умолчанию)
- `pnpm --filter @workspace/p2pchat run desktop:dev` — desktop с встроенным узлом
- `pnpm run test` — unit + критический E2E
- `pnpm run typecheck` — typecheck workspace
- `pnpm run build` — typecheck + build

## Stack

- pnpm workspaces, TypeScript 5.9
- Protocol core: `lib/p2p-identity`, `lib/p2p-protocol`, `lib/p2p-room`
- Bootstrap API: Express + SQLite + WebSocket
- Desktop: Tauri 2 + embedded Axum peer node
- UI: React + Vite

## Architecture

- Identity: Ed25519, peerId = hash(publicKey)
- Messages: signed + AES-GCM; relay/bootstrap не видит plaintext
- Coordinator: временная роль с epoch; миграция детерминирована
- Invite: `p2pchat://join?room=&token=&key=&api=`

## Product

- Создание комнаты / вход по invite
- Текст + presence + каналы
- Голос Phase 2 (WebRTC mesh уже подключен к signaling)
- Diagnostics без внутренних epoch-ошибок в UX

## User preferences

- Интерфейс на русском.
