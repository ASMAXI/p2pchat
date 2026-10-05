const KEY = "p2pchat-onboarding-guide";

export type OnboardingGuideState = {
  roomId: string;
  dismissed: boolean;
  createdAt: number;
};

export function markServerCreatedGuide(roomId: string): void {
  if (!roomId) return;
  const state: OnboardingGuideState = {
    roomId,
    dismissed: false,
    createdAt: Date.now(),
  };
  window.localStorage.setItem(KEY, JSON.stringify(state));
}

export function loadOnboardingGuide(roomId?: string | null): OnboardingGuideState | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OnboardingGuideState;
    if (!parsed?.roomId || parsed.dismissed) return null;
    if (roomId && parsed.roomId !== roomId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function dismissOnboardingGuide(): void {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as OnboardingGuideState;
    parsed.dismissed = true;
    window.localStorage.setItem(KEY, JSON.stringify(parsed));
  } catch {
    window.localStorage.removeItem(KEY);
  }
}
