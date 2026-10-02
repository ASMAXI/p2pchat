import { useEffect, useState } from "react";
import { loadTheme, useAppTheme } from "@/lib/theme";

const POPUP_MS = 10_000;
const POPUP_SRC = "/themes/patriot-popup.png";

/** Fire from join/leave handlers — no-op unless patriot theme is active. */
export function shouldShowPatriotPopup(): boolean {
  return loadTheme() === "patriot";
}

type Props = {
  /** Increment to show / restart the 10s timer. */
  token: number;
};

export function PatriotJoinPopup({ token }: Props) {
  const theme = useAppTheme();
  const [visible, setVisible] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const [progressKey, setProgressKey] = useState(0);

  useEffect(() => {
    if (!token || theme !== "patriot") {
      setVisible(false);
      return;
    }
    setFadeOut(false);
    setVisible(true);
    setProgressKey((n) => n + 1);
    const fadeTimer = window.setTimeout(() => setFadeOut(true), POPUP_MS - 700);
    const hideTimer = window.setTimeout(() => setVisible(false), POPUP_MS);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(hideTimer);
    };
  }, [token, theme]);

  if (!visible || theme !== "patriot") return null;

  return (
    <div
      className={`patriot-join-popup${fadeOut ? " is-out" : ""}`}
      role="presentation"
      aria-hidden
      data-testid="patriot-join-popup"
    >
      <div className="patriot-join-popup-card">
        <img src={POPUP_SRC} alt="" className="patriot-join-popup-img" draggable={false} />
        <div className="patriot-join-popup-bar" aria-hidden>
          <div
            key={progressKey}
            className="patriot-join-popup-bar-fill"
            style={{ animationDuration: `${POPUP_MS}ms` }}
          />
        </div>
      </div>
    </div>
  );
}
