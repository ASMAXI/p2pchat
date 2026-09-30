# P2PChat desktop build

P2PChat uses a Tauri shell around the shared React UI. On Windows the shell embeds a
local peer node (`src-tauri/src/local_hub.rs`) so creating a room does **not** require
a separately typed API URL.

## Development

From `artifacts/p2pchat`:

```bash
pnpm desktop:dev
```

Creating a room starts the local coordinator on a LAN-reachable port (preferred
`47821`). The invite link includes LAN origins and the room encryption key.

Optional bootstrap field on the home screen is only for internet peers or when joining
a room hosted elsewhere.

## Windows installers

```powershell
pnpm install
pnpm desktop:build:windows
```

GitHub Actions: `.github/workflows/build-windows.yml`.

## Architecture notes

- Coordinator is a temporary role; room history is replicated to peers.
- Messages are signed (Ed25519) and encrypted (AES-GCM) before leaving the client.
- When the coordinator leaves, remaining desktop peers elect a successor and reconnect.
- Optional Node bootstrap (`artifacts/api-server`) can stay online as `alwaysHost` for
  web clients or cross-NAT discovery; it still does not see plaintext.
