# P2PChat

Закрытый локальный мессенджер для небольших групп: создать комнату, пригласить друзей ссылкой, общаться в текстовых каналах и подключаться к голосовым комнатам без ручной настройки сети.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/p2pchat/src/App.tsx` — onboarding, workspace, voice rooms, invite flow и diagnostics
- `artifacts/p2pchat/src/index.css` — визуальная тема P2PChat
- `artifacts/p2pchat` — основной web-артефакт с local-first persistence
- `attached_assets/P2PChat_TZ_v1_1_NAT_Host_Migration_1787950669170.pdf` — исходное ТЗ v1.1

## Architecture decisions

- Первый пользовательский срез работает local-first: данные комнаты, сообщения и голосовое состояние сохраняются в localStorage.
- Сетевые сложности из ТЗ представлены отдельным diagnostics-сценарием и не перегружают обычный UX.
- Роуты `/`, `/server` и `/diagnostics` разделяют onboarding, рабочее пространство и диагностику соединения.
- UI-копирайт и основные состояния следуют русскоязычному пользовательскому сценарию из ТЗ v1.1.

## Product

- Создание приватного сервера с именем
- Вход по invite-коду/ссылке и копирование приглашения
- Текстовые и голосовые каналы
- Отправка сообщений и создание каналов
- Join/leave, mute и deafen голосовой комнаты
- Friendly diagnostics для direct path, sync и host migration

## User preferences

- Интерфейс приложения — на русском языке.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
