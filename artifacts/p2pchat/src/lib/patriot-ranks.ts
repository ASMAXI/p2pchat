import { loadTheme, type AppThemeId } from "@/lib/theme";

/** RF military-style ranks for patriot theme display names. */
const RF_RANKS = [
  "Рядовой",
  "Ефрейтор",
  "Мл. сержант",
  "Сержант",
  "Ст. сержант",
  "Старшина",
  "Прапорщик",
  "Ст. прапорщик",
  "Мл. лейтенант",
  "Лейтенант",
  "Ст. лейтенант",
  "Капитан",
  "Майор",
  "Подполковник",
  "Полковник",
  "Генерал-майор",
  "Генерал-лейтенант",
  "Генерал-полковник",
] as const;

const SALT_KEY = "p2pchat-patriot-rank-salt";

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** New random salt each time the user enters a server (reshuffles ranks). */
export function refreshPatriotRankSalt(): string {
  const salt = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    window.sessionStorage.setItem(SALT_KEY, salt);
  } catch {
    // ignore
  }
  return salt;
}

function getPatriotRankSalt(): string {
  try {
    const existing = window.sessionStorage.getItem(SALT_KEY);
    if (existing) return existing;
  } catch {
    // ignore
  }
  return refreshPatriotRankSalt();
}

export function rfRankFor(seed: string): string {
  const index = hashSeed(`${getPatriotRankSalt()}::${seed || "peer"}`) % RF_RANKS.length;
  return RF_RANKS[index]!;
}

/** Prefix display name with a session-random RF rank when patriot theme is active. */
export function themedDisplayName(name: string, seed?: string, theme?: AppThemeId): string {
  const active = theme ?? loadTheme();
  if (active !== "patriot") return name;
  const rank = rfRankFor(seed || name);
  if (name.startsWith(`${rank} `)) return name;
  return `${rank} ${name}`;
}
