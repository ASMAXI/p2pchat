import { useEffect, useState } from "react";

export type AppThemeId = "light" | "dark" | "pink" | "dota" | "patriot" | "gachi";

const KEY = "p2pchat-theme";

export const APP_THEMES: { id: AppThemeId; label: string }[] = [
  { id: "light", label: "Светлая" },
  { id: "dark", label: "Тёмная" },
  { id: "pink", label: "Розовая" },
  { id: "dota", label: "DOTA 2" },
  { id: "patriot", label: "Патриотическая" },
  { id: "gachi", label: "Гачимучи" },
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
  window.dispatchEvent(new CustomEvent("p2pchat-theme", { detail: theme }));
}

export function applyTheme(theme: AppThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark" || theme === "dota" || theme === "gachi");
}

export function initTheme(): void {
  applyTheme(loadTheme());
}

export function useAppTheme(): AppThemeId {
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => {
    const sync = () => setTheme(loadTheme());
    window.addEventListener("p2pchat-theme", sync);
    return () => window.removeEventListener("p2pchat-theme", sync);
  }, []);
  return theme;
}
