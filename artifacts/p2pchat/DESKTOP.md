# P2PChat desktop build

P2PChat uses a Tauri desktop shell around the shared React interface. The shell is
ready for Windows 10/11 x64 packaging and keeps the UI local on the user's
computer.

## Development

From this directory:

```bash
pnpm desktop:dev
```

## Windows installers

Windows builds produce both `.msi` and `.exe` installers. The Tauri configuration
targets Windows only (`msi` and `nsis`); Linux packaging is not part of this
desktop deliverable.

### Windows GitHub Actions build

The repository includes `.github/workflows/build-windows.yml`. Run it from the
GitHub Actions tab with **Run workflow**. The workflow builds both installers
for Windows x64 and uploads them as the `p2pchat-windows-x64` artifact.

For a local Windows build, run from `artifacts/p2pchat`:

```powershell
pnpm install
pnpm desktop:build:windows
```

After installation, enter the public API server URL on the first screen
(for example, `https://chat-api.example.com`). The room owner creates a room
there and the generated invite link carries that URL to friends automatically.
The desktop installer does not embed a server process.

The desktop client now uses the shared room control plane for invitations,
presence, messages, channel updates and host migration. Voice uses browser
WebRTC with native Opus negotiation, ICE/STUN and WebSocket signaling. A
production TURN/relay service and the Java 21/SQLite identity/event-store layer
from the full protocol specification remain separate infrastructure work.