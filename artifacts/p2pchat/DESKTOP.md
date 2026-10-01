# P2PChat desktop build

Tauri shell with an embedded peer node (`local_hub.rs`) and an automatic
Cloudflare Quick Tunnel (`tunnel.rs`) so friends do not need ngrok.

## Development

```bash
pnpm desktop:dev
```

On first `start_local_sync_server` the app downloads `cloudflared` into app data,
opens a Quick Tunnel to the local hub port, and publishes `https://*.trycloudflare.com`
into `member.endpoints` / invite.

## Voice

Built-in free TURN (Open Relay) is used by default. Optional:

- `VITE_METERED_API_KEY` + `VITE_METERED_APP_NAME` — fetch ICE from your Metered free account
- Settings → advanced — paste your own coturn (future Pro / VPS)

## Windows installers

```powershell
pnpm install
pnpm desktop:build:windows
```

## Architecture notes

- Coordinator migrates among desktop peers; public URL prefers trycloudflare / tunnels.
- Chat signaling ≠ media. Media uses WebRTC + TURN, not the HTTP tunnel.
- No permanent cloud host required for the core product.
