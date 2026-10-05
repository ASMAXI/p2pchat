/** Slash commands parsed before sending chat. */

export type ChatCommandResult =
  | { kind: "roll"; text: string }
  | { kind: "votekick"; targetId: string; targetName: string; text: string }
  | { kind: "help"; text: string }
  | { kind: "error"; text: string };

export type SlashCommandOption = {
  cmd: string;
  usage: string;
  description: string;
  /** Inserted into the composer when picked (usually `/cmd `). */
  insert: string;
};

export const SLASH_COMMANDS: SlashCommandOption[] = [
  { cmd: "roll", usage: "/roll [число]", description: "Бросок 1…N (по умолчанию 100)", insert: "/roll " },
  { cmd: "votekick", usage: "/votekick <ник>", description: "Голосование за кик без бана", insert: "/votekick " },
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

function parseRoll(arg: string): { max: number } | null {
  const raw = arg.trim();
  if (!raw) return { max: 100 };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 2 || n > 1_000_000) return null;
  return { max: Math.floor(n) };
}

export function tryParseChatCommand(
  input: string,
  ctx: {
    selfName: string;
    members: Array<{ id: string; name: string; online?: boolean }>;
    selfId: string;
  },
): ChatCommandResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [cmdRaw, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "help" || cmd === "команды") {
    return {
      kind: "help",
      text: "Команды: /roll [число] · /votekick <ник> · /help",
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
    if (!arg) return { kind: "error", text: "Использование: /votekick <ник>" };
    const needle = arg.replace(/^@/, "").trim().toLowerCase();
    const candidates = ctx.members.filter(
      (member) => member.id !== ctx.selfId && member.name.trim().toLowerCase() === needle,
    );
    const online = candidates.filter((member) => member.online !== false);
    const target = (online[0] ?? candidates[0]) as { id: string; name: string } | undefined;
    if (!target) {
      const partial = ctx.members.filter(
        (member) =>
          member.id !== ctx.selfId && member.name.trim().toLowerCase().includes(needle),
      );
      if (partial.length === 1) {
        const only = partial[0]!;
        return {
          kind: "votekick",
          targetId: only.id,
          targetName: only.name,
          text: `🗳️ Голосование: кикнуть ${only.name} (без бана). Нужно большинство онлайн. Нажмите «За» под сообщением.`,
        };
      }
      return { kind: "error", text: `Участник «${arg}» не найден` };
    }
    return {
      kind: "votekick",
      targetId: target.id,
      targetName: target.name,
      text: `🗳️ Голосование: кикнуть ${target.name} (без бана). Нужно большинство онлайн. Нажмите «За» под сообщением.`,
    };
  }

  return { kind: "error", text: `Неизвестная команда /${cmd}. /help — список.` };
}
