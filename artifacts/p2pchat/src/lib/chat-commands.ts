import { voteKickVotesNeeded } from "@/lib/chat-payload";

/** Slash commands parsed before sending chat. */

export type ChatCommandResult =
  | { kind: "roll"; text: string }
  | {
      kind: "votekick";
      targetId: string;
      targetName: string;
      text: string;
      neededVotes: number;
      onlineSnapshot: number;
    }
  | { kind: "help"; text: string }
  | { kind: "error"; text: string };

export type SlashCommandOption = {
  cmd: string;
  usage: string;
  description: string;
  /** Inserted into the composer when picked (usually `/cmd `). */
  insert: string;
};

export type VotekickMemberOption = {
  id: string;
  name: string;
  label: string;
  insert: string;
};

export const SLASH_COMMANDS: SlashCommandOption[] = [
  { cmd: "roll", usage: "/roll [число]", description: "Бросок 1…N (по умолчанию 100)", insert: "/roll " },
  { cmd: "votekick", usage: "/votekick", description: "Голосование за кик — выберите участника", insert: "/votekick " },
  { cmd: "help", usage: "/help", description: "Список команд", insert: "/help" },
];

/** Autocomplete while the draft is a slash command being typed. */
export function slashCommandSuggestions(draft: string): SlashCommandOption[] | null {
  const match = draft.match(/^\/([^\s]*)$/);
  if (!match) return null;
  const query = (match[1] ?? "").toLowerCase();
  const aliases: Record<string, string> = {
    кости: "roll",
    кик: "votekick",
    команды: "help",
  };
  return SLASH_COMMANDS.filter((item) => {
    if (!query) return true;
    if (item.cmd.startsWith(query)) return true;
    return Object.entries(aliases).some(
      ([alias, cmd]) => cmd === item.cmd && alias.startsWith(query),
    );
  });
}

export function applySlashCommandSuggestion(draft: string, option: SlashCommandOption): string {
  if (/^\/[^\s]*$/.test(draft)) return option.insert;
  return draft;
}

export function memberTag(id: string): string {
  return `id:${id}`;
}

export function votekickMemberSuggestions(
  draft: string,
  members: Array<{ id: string; name: string; online?: boolean }>,
  selfId: string,
): VotekickMemberOption[] | null {
  const match = draft.match(/^\/(?:votekick|кик)\s*(.*)$/i);
  if (!match) return null;
  const query = (match[1] ?? "").trim().toLowerCase();
  const candidates = members.filter((member) => member.id !== selfId);
  const filtered = candidates.filter((member) => {
    if (!query) return true;
    if (query.startsWith("id:")) {
      const idNeedle = query.slice(3);
      return member.id.toLowerCase().startsWith(idNeedle);
    }
    const name = member.name.trim().toLowerCase();
    return name.includes(query) || member.id.toLowerCase().includes(query);
  });
  return filtered.slice(0, 8).map((member) => {
    const shortId = member.id.slice(0, 6);
    const sameNameCount = candidates.filter(
      (item) => item.name.trim().toLowerCase() === member.name.trim().toLowerCase(),
    ).length;
    const label =
      sameNameCount > 1
        ? `${member.name} · ${shortId}${member.online === false ? " (оффлайн)" : ""}`
        : `${member.name}${member.online === false ? " (оффлайн)" : ""}`;
    return {
      id: member.id,
      name: member.name,
      label,
      insert: `/votekick ${memberTag(member.id)} `,
    };
  });
}

export function applyVotekickMemberSuggestion(draft: string, option: VotekickMemberOption): string {
  if (/^\/(?:votekick|кик)\s*/i.test(draft)) return option.insert;
  return draft;
}

function parseRoll(arg: string): { max: number } | null {
  const raw = arg.trim();
  if (!raw) return { max: 100 };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 2 || n > 1_000_000) return null;
  return { max: Math.floor(n) };
}

function resolveVotekickTarget(
  arg: string,
  ctx: {
    members: Array<{ id: string; name: string; online?: boolean }>;
    selfId: string;
  },
): { id: string; name: string } | null {
  const raw = arg.trim();
  if (!raw) return null;

  const idTagged = raw.match(/^id:([^\s]+)$/i);
  if (idTagged) {
    const id = idTagged[1]!;
    const byId = ctx.members.find((member) => member.id === id && member.id !== ctx.selfId);
    return byId ? { id: byId.id, name: byId.name } : null;
  }

  const byExactId = ctx.members.find((member) => member.id === raw && member.id !== ctx.selfId);
  if (byExactId) return { id: byExactId.id, name: byExactId.name };

  const needle = raw.replace(/^@/, "").trim().toLowerCase();
  const sameName = ctx.members.filter(
    (member) => member.id !== ctx.selfId && member.name.trim().toLowerCase() === needle,
  );
  if (sameName.length > 1) return null;
  if (sameName.length === 1) return { id: sameName[0]!.id, name: sameName[0]!.name };

  const partial = ctx.members.filter(
    (member) =>
      member.id !== ctx.selfId &&
      (member.name.trim().toLowerCase().includes(needle) || member.id.toLowerCase().includes(needle)),
  );
  if (partial.length === 1) return { id: partial[0]!.id, name: partial[0]!.name };
  return null;
}

export function tryParseChatCommand(
  input: string,
  ctx: {
    selfName: string;
    members: Array<{ id: string; name: string; online?: boolean }>;
    selfId: string;
    onlineCount?: number;
  },
): ChatCommandResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [cmdRaw, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();
  const onlineCount = ctx.onlineCount ?? ctx.members.filter((member) => member.online !== false).length;
  const needed = voteKickVotesNeeded(onlineCount);

  if (cmd === "help" || cmd === "команды") {
    return {
      kind: "help",
      text: `Команды: /roll [число] · /votekick (выбор участника) · /help. Кик: нужно ${needed} «За» при ${onlineCount} онлайн.`,
    };
  }

  if (cmd === "roll" || cmd === "кости") {
    const parsed = parseRoll(arg);
    if (!parsed) return { kind: "error", text: "Использование: /roll или /roll 100" };
    const value = 1 + Math.floor(Math.random() * parsed.max);
    return {
      kind: "roll",
      text: `🎲 ${ctx.selfName} выбрасывает 1–${parsed.max}: ${value}`,
    };
  }

  if (cmd === "votekick" || cmd === "кик") {
    if (!arg) {
      return { kind: "error", text: "Выберите участника из списка после /votekick" };
    }
    const target = resolveVotekickTarget(arg, ctx);
    if (!target) {
      const needle = arg.replace(/^@/, "").trim().toLowerCase();
      const dupes = ctx.members.filter(
        (member) => member.id !== ctx.selfId && member.name.trim().toLowerCase() === needle,
      );
      if (dupes.length > 1) {
        return {
          kind: "error",
          text: `Несколько «${arg}» — выберите из списка (у каждого свой id).`,
        };
      }
      return { kind: "error", text: `Участник «${arg}» не найден` };
    }
    return {
      kind: "votekick",
      targetId: target.id,
      targetName: target.name,
      neededVotes: needed,
      onlineSnapshot: onlineCount,
      text: `🗳️ Голосование: кикнуть ${target.name}. Нужно ${needed} «За» (зафиксировано при ${onlineCount} онлайн).`,
    };
  }

  return { kind: "error", text: `Неизвестная команда /${cmd}. /help — список.` };
}
