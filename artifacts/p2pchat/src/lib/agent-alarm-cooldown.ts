const COOLDOWN_MS = 5 * 60 * 1000;
const keyFor = (roomId: string, peerId: string) => `p2pchat-agent-alarm:${roomId}:${peerId}`;

export function agentAlarmCooldownMs(roomId: string, peerId: string): number {
  if (!roomId || !peerId) return 0;
  try {
    const raw = window.localStorage.getItem(keyFor(roomId, peerId));
    if (!raw) return 0;
    const last = Number(raw);
    if (!Number.isFinite(last)) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - last));
  } catch {
    return 0;
  }
}

export function canSendAgentAlarm(roomId: string, peerId: string): { ok: boolean; remainingMs: number } {
  const remainingMs = agentAlarmCooldownMs(roomId, peerId);
  return { ok: remainingMs <= 0, remainingMs };
}

export function markAgentAlarmSent(roomId: string, peerId: string): void {
  if (!roomId || !peerId) return;
  try {
    window.localStorage.setItem(keyFor(roomId, peerId), String(Date.now()));
  } catch {
    // ignore quota
  }
}

export function formatAlarmCooldown(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec} сек`;
  return sec > 0 ? `${min} мин ${sec} сек` : `${min} мин`;
}
