---
name: P2P control plane
description: Durable constraints for the room control plane and WebRTC signaling layer.
---

The room control plane uses invite-authenticated WebSocket state synchronization; voice media is established separately by browser WebRTC and relayed signaling messages.

**Why:** Keeping room state, signaling, and media separate makes host migration and reconnect behavior testable without pretending that server presence events are audio transport.

**How to apply:** Preserve targeted signaling, idempotent message IDs, runtime-only presence, and stale-socket protection when extending voice, NAT traversal, or relay fallback.