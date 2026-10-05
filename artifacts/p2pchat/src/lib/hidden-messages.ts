const keyFor = (roomId: string) => `p2pchat-hidden-messages:${roomId}`;

export function loadHiddenMessageIds(roomId: string): Set<string> {
  if (!roomId) return new Set();
  try {
    const raw = window.localStorage.getItem(keyFor(roomId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function hideMessageLocally(roomId: string, messageId: string): Set<string> {
  const next = loadHiddenMessageIds(roomId);
  next.add(messageId);
  try {
    window.localStorage.setItem(keyFor(roomId), JSON.stringify([...next]));
  } catch {
    // ignore quota
  }
  return next;
}
