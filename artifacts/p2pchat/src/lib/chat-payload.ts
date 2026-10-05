/** Rich chat plaintext envelope (backward-compatible with plain text + [[drift-img:]]). */

export const IMAGE_MESSAGE_PREFIX = "[[drift-img:]]";
export const MSG_PREFIX = "[[drift-msg:v1]]";
export const REACT_PREFIX = "[[drift-react:v1]]";
export const EDIT_PREFIX = "[[drift-edit:v1]]";
export const DEL_PREFIX = "[[drift-del:v1]]";
export const PIN_PREFIX = "[[drift-pin:v1]]";
export const SFX_PREFIX = "[[drift-sfx:v1]]";
export const VOTEKICK_PREFIX = "[[drift-votekick:v1]]";
export const KICK_PREFIX = "[[drift-kick:v1]]";

export const MAX_FILE_BYTES = 900_000; // keep under plaintext limit with base64 overhead
export const MAX_FILE_NAME = 120;

export type ChatFileRef = {
  name: string;
  mime: string;
  dataUrl: string;
  size: number;
};

export type RichBody = {
  v: 1;
  body: string;
  replyTo?: string;
  mentions?: string[];
  file?: ChatFileRef;
};

export type ReactBody = { v: 1; target: string; emoji: string; op?: "add" | "remove" | "toggle" };
export type EditBody = { v: 1; target: string; body: string };
export type DelBody = { v: 1; target: string };
export type PinBody = { v: 1; target: string; pinned: boolean };
export type SfxBody = { v: 1; id: string };
export type VoteKickBody = { v: 1; targetId: string; targetName: string; needed?: number; online?: number };

/** Votes required to pass a votekick (majority of online at creation time). */
export function voteKickVotesNeeded(onlineCount: number): number {
  return Math.max(1, Math.ceil(Math.max(0, onlineCount) / 2));
}
export type KickBody = { v: 1; targetId: string; targetName: string };

export type ParsedWireText =
  | { kind: "text"; body: string; replyTo?: string; mentions?: string[]; file?: ChatFileRef }
  | { kind: "image"; dataUrl: string }
  | { kind: "react"; target: string; emoji: string; op: "add" | "remove" | "toggle" }
  | { kind: "edit"; target: string; body: string }
  | { kind: "delete"; target: string }
  | { kind: "pin"; target: string; pinned: boolean }
  | { kind: "sfx"; id: string }
  | { kind: "votekick"; targetId: string; targetName: string; neededVotes: number; onlineSnapshot?: number }
  | { kind: "kick"; targetId: string; targetName: string }
  | { kind: "unknown"; raw: string };

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function isImageMessage(text: string | null | undefined): boolean {
  return Boolean(text?.startsWith(IMAGE_MESSAGE_PREFIX));
}

export function imagePayload(text: string): string {
  return text.slice(IMAGE_MESSAGE_PREFIX.length);
}

export function encodeRichMessage(input: {
  body: string;
  replyTo?: string;
  mentions?: string[];
  file?: ChatFileRef;
}): string {
  const mentions = (input.mentions ?? []).filter(Boolean);
  const needsEnvelope = Boolean(input.replyTo || mentions.length || input.file);
  if (!needsEnvelope) return input.body;
  const payload: RichBody = {
    v: 1,
    body: input.body,
    replyTo: input.replyTo,
    mentions: mentions.length ? mentions : undefined,
    file: input.file,
  };
  return `${MSG_PREFIX}${JSON.stringify(payload)}`;
}

export function encodeReact(target: string, emoji: string, op: ReactBody["op"] = "toggle"): string {
  return `${REACT_PREFIX}${JSON.stringify({ v: 1, target, emoji, op } satisfies ReactBody)}`;
}

export function encodeEdit(target: string, body: string): string {
  return `${EDIT_PREFIX}${JSON.stringify({ v: 1, target, body } satisfies EditBody)}`;
}

export function encodeDelete(target: string): string {
  return `${DEL_PREFIX}${JSON.stringify({ v: 1, target } satisfies DelBody)}`;
}

export function encodePin(target: string, pinned: boolean): string {
  return `${PIN_PREFIX}${JSON.stringify({ v: 1, target, pinned } satisfies PinBody)}`;
}

export function encodeSfx(id: string): string {
  return `${SFX_PREFIX}${JSON.stringify({ v: 1, id } satisfies SfxBody)}`;
}

export function encodeVoteKick(
  targetId: string,
  targetName: string,
  meta?: { needed?: number; online?: number },
): string {
  return `${VOTEKICK_PREFIX}${JSON.stringify({
    v: 1,
    targetId,
    targetName,
    needed: meta?.needed,
    online: meta?.online,
  } satisfies VoteKickBody)}`;
}

export function encodeKickNotice(targetId: string, targetName: string): string {
  return `${KICK_PREFIX}${JSON.stringify({ v: 1, targetId, targetName } satisfies KickBody)}`;
}

export function parseWireText(text: string | null | undefined): ParsedWireText {
  if (!text) return { kind: "unknown", raw: "" };
  if (text.startsWith(IMAGE_MESSAGE_PREFIX)) {
    return { kind: "image", dataUrl: imagePayload(text) };
  }
  if (text.startsWith(MSG_PREFIX)) {
    const data = parseJson<RichBody>(text.slice(MSG_PREFIX.length));
    if (!data || typeof data.body !== "string") return { kind: "unknown", raw: text };
    return {
      kind: "text",
      body: data.body,
      replyTo: data.replyTo,
      mentions: data.mentions,
      file: data.file,
    };
  }
  if (text.startsWith(REACT_PREFIX)) {
    const data = parseJson<ReactBody>(text.slice(REACT_PREFIX.length));
    if (!data?.target || !data.emoji) return { kind: "unknown", raw: text };
    return { kind: "react", target: data.target, emoji: data.emoji, op: data.op ?? "toggle" };
  }
  if (text.startsWith(EDIT_PREFIX)) {
    const data = parseJson<EditBody>(text.slice(EDIT_PREFIX.length));
    if (!data?.target || typeof data.body !== "string") return { kind: "unknown", raw: text };
    return { kind: "edit", target: data.target, body: data.body };
  }
  if (text.startsWith(DEL_PREFIX)) {
    const data = parseJson<DelBody>(text.slice(DEL_PREFIX.length));
    if (!data?.target) return { kind: "unknown", raw: text };
    return { kind: "delete", target: data.target };
  }
  if (text.startsWith(PIN_PREFIX)) {
    const data = parseJson<PinBody>(text.slice(PIN_PREFIX.length));
    if (!data?.target) return { kind: "unknown", raw: text };
    return { kind: "pin", target: data.target, pinned: Boolean(data.pinned) };
  }
  if (text.startsWith(SFX_PREFIX)) {
    const data = parseJson<SfxBody>(text.slice(SFX_PREFIX.length));
    if (!data?.id || typeof data.id !== "string") return { kind: "unknown", raw: text };
    return { kind: "sfx", id: data.id };
  }
  if (text.startsWith(VOTEKICK_PREFIX)) {
    const data = parseJson<VoteKickBody>(text.slice(VOTEKICK_PREFIX.length));
    if (!data?.targetId || !data?.targetName) return { kind: "unknown", raw: text };
    const onlineSnapshot = typeof data.online === "number" ? data.online : undefined;
    const neededVotes =
      typeof data.needed === "number" && data.needed > 0
        ? Math.floor(data.needed)
        : voteKickVotesNeeded(onlineSnapshot ?? 1);
    return {
      kind: "votekick",
      targetId: data.targetId,
      targetName: data.targetName,
      neededVotes,
      onlineSnapshot,
    };
  }
  if (text.startsWith(KICK_PREFIX)) {
    const data = parseJson<KickBody>(text.slice(KICK_PREFIX.length));
    if (!data?.targetId || !data?.targetName) return { kind: "unknown", raw: text };
    return { kind: "kick", targetId: data.targetId, targetName: data.targetName };
  }
  return { kind: "text", body: text };
}

export function extractMentions(text: string, memberNames: string[]): string[] {
  const found = new Set<string>();
  // Prefer longer names first so "@Иван Петров" wins over "@Иван"
  const sorted = [...memberNames].filter((n) => n.trim()).sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const re = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=$|\\s|[.,!?;:])`, "i");
    if (re.test(text)) found.add(name);
  }
  return [...found];
}

/** Names that match the current `@query` token for autocomplete. */
export function mentionSuggestions(draft: string, memberNames: string[]): { query: string; matches: string[] } | null {
  const match = draft.match(/(^|[\s])@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] ?? "";
  const q = query.toLowerCase();
  const matches = memberNames
    .filter((name) => name.trim() && name.toLowerCase().includes(q))
    .filter((name, index, arr) => arr.findIndex((item) => item.toLowerCase() === name.toLowerCase()) === index)
    .slice(0, 6);
  return { query, matches };
}

/** Replace trailing `@query` with `@Name `. */
export function applyMentionSuggestion(draft: string, name: string): string {
  return draft.replace(/@([^\s@]*)$/, `@${name} `);
}

/** Split text into plain / mention spans for highlighting. */
export function splitMentionSpans(text: string, memberNames: string[]): Array<{ text: string; mention: boolean }> {
  if (!text) return [];
  const sorted = [...memberNames].filter((n) => n.trim()).sort((a, b) => b.length - a.length);
  if (!sorted.length) return [{ text, mention: false }];
  const pattern = new RegExp(`(@(?:${sorted.map(escapeRegExp).join("|")}))(?=$|\\s|[.,!?;:])`, "gi");
  const parts: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), mention: false });
    parts.push({ text: match[0]!, mention: true });
    last = index + match[0]!.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts.length ? parts : [{ text, mention: false }];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type DisplayMessage = {
  id: string;
  channelId?: string;
  author: string;
  authorId?: string;
  avatar: string;
  content: string;
  timestamp: string;
  isCurrentUser?: boolean;
  delivery?: "queued" | "sent" | "synced";
  replyTo?: string;
  mentions?: string[];
  file?: ChatFileRef;
  imageUrl?: string;
  edited?: boolean;
  deleted?: boolean;
  reactions?: Record<string, string[]>; // emoji -> author names
  pinned?: boolean;
  sfxId?: string;
  voteKick?: { targetId: string; targetName: string; neededVotes: number; onlineSnapshot?: number };
  kickNotice?: { targetId: string; targetName: string };
};

/** Fold control messages (react/edit/delete/pin) into display list. */
export function foldChatMessages(
  raw: Array<{
    id: string;
    channelId?: string;
    author: string;
    authorId?: string;
    avatar: string;
    content: string;
    timestamp: string;
    isCurrentUser?: boolean;
    delivery?: DisplayMessage["delivery"];
  }>,
): DisplayMessage[] {
  const byId = new Map<string, DisplayMessage>();
  const order: string[] = [];

  for (const item of raw) {
    const parsed = parseWireText(item.content);
    if (parsed.kind === "react") {
      const target = byId.get(parsed.target);
      if (!target || target.deleted) continue;
      const reactions = { ...(target.reactions ?? {}) };
      const list = new Set(reactions[parsed.emoji] ?? []);
      const reactorKey = item.authorId ?? item.author;
      if (parsed.op === "remove") list.delete(reactorKey);
      else if (parsed.op === "add") list.add(reactorKey);
      else if (list.has(reactorKey)) list.delete(reactorKey);
      else list.add(reactorKey);
      if (list.size) reactions[parsed.emoji] = [...list];
      else delete reactions[parsed.emoji];
      target.reactions = reactions;
      continue;
    }
    if (parsed.kind === "edit") {
      const target = byId.get(parsed.target);
      if (!target || target.deleted) continue;
      const editorId = item.authorId;
      const ownerId = target.authorId;
      if (ownerId && editorId) {
        if (ownerId !== editorId) continue;
      } else if (target.author !== item.author) {
        continue;
      }
      target.content = parsed.body;
      target.edited = true;
      continue;
    }
    if (parsed.kind === "delete") {
      const target = byId.get(parsed.target);
      if (!target) continue;
      const deleterId = item.authorId;
      const ownerId = target.authorId;
      if (ownerId && deleterId) {
        if (ownerId !== deleterId) continue;
      } else if (target.author !== item.author) {
        continue;
      }
      byId.delete(parsed.target);
      const idx = order.indexOf(parsed.target);
      if (idx >= 0) order.splice(idx, 1);
      continue;
    }
    if (parsed.kind === "pin") {
      const target = byId.get(parsed.target);
      if (target) target.pinned = parsed.pinned;
      continue;
    }

    const base: DisplayMessage = {
      id: item.id,
      channelId: item.channelId,
      author: item.author,
      authorId: item.authorId,
      avatar: item.avatar,
      content: item.content,
      timestamp: item.timestamp,
      isCurrentUser: item.isCurrentUser,
      delivery: item.delivery,
    };

    if (parsed.kind === "sfx") {
      base.sfxId = parsed.id;
      base.content = parsed.id;
    } else if (parsed.kind === "image") {
      base.imageUrl = parsed.dataUrl;
      base.content = "";
    } else if (parsed.kind === "text") {
      base.content = parsed.body;
      base.replyTo = parsed.replyTo;
      base.mentions = parsed.mentions;
      base.file = parsed.file;
    } else if (parsed.kind === "votekick") {
      base.voteKick = {
        targetId: parsed.targetId,
        targetName: parsed.targetName,
        neededVotes: parsed.neededVotes,
        onlineSnapshot: parsed.onlineSnapshot,
      };
      base.content = `Голосование: кикнуть ${parsed.targetName}`;
    } else if (parsed.kind === "kick") {
      base.kickNotice = { targetId: parsed.targetId, targetName: parsed.targetName };
      base.content = `${parsed.targetName} исключён голосованием (можно зайти снова)`;
    } else {
      base.content = item.content;
    }

    byId.set(item.id, base);
    order.push(item.id);
  }

  return order.map((id) => byId.get(id)!).filter(Boolean);
}

export async function fileToChatAttachment(file: File): Promise<ChatFileRef> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`Файл слишком большой (макс. ~${Math.round(MAX_FILE_BYTES / 1024)} КБ)`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
  return {
    name: file.name.slice(0, MAX_FILE_NAME),
    mime: file.type || "application/octet-stream",
    dataUrl,
    size: file.size,
  };
}
