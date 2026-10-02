import { loadTheme, type AppThemeId } from "@/lib/theme";

/** Stable RF military-style ranks for patriot theme display names. */
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

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function rfRankFor(seed: string): string {
  const index = hashSeed(seed || "peer") % RF_RANKS.length;
  return RF_RANKS[index]!;
}

/** Prefix display name with a stable RF rank when patriot theme is active. */
export function themedDisplayName(name: string, seed?: string, theme?: AppThemeId): string {
  const active = theme ?? loadTheme();
  if (active !== "patriot") return name;
  const rank = rfRankFor(seed || name);
  if (name.startsWith(`${rank} `)) return name;
  return `${rank} ${name}`;
}
