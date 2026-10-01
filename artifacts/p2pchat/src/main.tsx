import { createRoot } from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { debugLog, installDebugLogHooks } from "@/lib/debug-log";

import "./index.css";

installDebugLogHooks();
debugLog("boot", "app start", { desktop: "__TAURI_INTERNALS__" in window });

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
