export type AppThemeId = "light" | "dark" | "pink" | "dota" | "patriot";

const KEY = "p2pchat-theme";

export const APP_THEMES: { id: AppThemeId; label: string }[] = [
  { id: "light", label: "Светлая" },
  { id: "dark", label: "Тёмная" },
  { id: "pink", label: "Розовая" },
  { id: "dota", label: "DOTA 2" },
  { id: "patriot", label: "Патриотическая" },
];

export function loadTheme(): AppThemeId {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (APP_THEMES.some((item) => item.id === raw)) return raw as AppThemeId;
  } catch {
    // ignore
  }
  return "light";
}

export function saveTheme(theme: AppThemeId): void {
  window.localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: AppThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark" || theme === "dota");
}

export function initTheme(): void {
  applyTheme(loadTheme());
}
