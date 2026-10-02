/** Local message history cache so reconnect doesn't flash an empty chat. */

const KEY = "p2pchat-message-cache-v1";
const MAX_PER_ROOM = 400;

type CacheEntry = {
  id: string;
  channelId: string;
  authorId: string;
  author: string;
  text: string | null;
  timestamp: string;
};

type Store = Record<string, CacheEntry[]>;

function readStore(): Store {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) || "{}") as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  window.localStorage.setItem(KEY, JSON.stringify(store));
}

export function cacheRoomMessages(
  roomId: string,
  messages: Array<{
    id: string;
    channelId: string;
    authorId: string;
    author: string;
    text: string | null;
    timestamp: string;
  }>,
): void {
  if (!roomId) return;
  const store = readStore();
  const byId = new Map<string, CacheEntry>();
  for (const item of store[roomId] ?? []) byId.set(item.id, item);
  for (const item of messages) {
    if (item.text == null) continue;
    byId.set(item.id, {
      id: item.id,
      channelId: item.channelId,
      authorId: item.authorId,
      author: item.author,
      text: item.text,
      timestamp: item.timestamp,
    });
  }
  store[roomId] = [...byId.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-MAX_PER_ROOM);
  writeStore(store);
}

export function loadCachedRoomMessages(roomId: string): CacheEntry[] {
  if (!roomId) return [];
  return readStore()[roomId] ?? [];
}

export function mergeMessagesWithCache<T extends { id: string; timestamp: string }>(
  live: T[],
  cached: T[],
): T[] {
  const map = new Map<string, T>();
  for (const item of cached) map.set(item.id, item);
  for (const item of live) map.set(item.id, item);
  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
