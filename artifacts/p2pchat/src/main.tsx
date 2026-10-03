import { createRoot } from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { debugLog, installDebugLogHooks, setDebugReportEnricher } from "@/lib/debug-log";
import { getLastVoiceNatReport, iceConfigFlags } from "@/lib/voice-diagnostics";

import { initTheme } from "@/lib/theme";
import { playStartupSound } from "@/lib/ui-sounds";

import "./index.css";

initTheme();

installDebugLogHooks();
setDebugReportEnricher(() => ({
  iceFlags: iceConfigFlags(),
  voiceNat: getLastVoiceNatReport(),
}));
debugLog("boot", "app start", { desktop: "__TAURI_INTERNALS__" in window });
playStartupSound();

createRoot(document.getElementById("root")!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    debugLog("react", "caught render error", { error, stack: errorInfo.componentStack }, "error");
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
