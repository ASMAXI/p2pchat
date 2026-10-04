import { useEffect } from 'react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { VoiceOverlayPage } from '@/components/voice-overlay-page';
import { emitPendingInvite, installInviteDeepLinkHandler } from '@/lib/invite-deep-link';
import { Home } from '@/components/home-page';
import { Workspace } from '@/components/workspace';
import { Diagnostics } from '@/components/diagnostics-panel';
import { SettingsPage } from '@/components/settings-page';

const queryClient = new QueryClient();

function voiceOverlayRouteActive(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('voiceOverlay') === '1') return true;
  } catch {
    // ignore
  }
  if ((window.location.hash || '').includes('voice-overlay')) return true;
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  return path.endsWith('/voice-overlay');
}

function Router() {
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (voiceOverlayRouteActive()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void installInviteDeepLinkHandler((url) => {
      if (cancelled) return;
      emitPendingInvite(url);
      setLocation('/');
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setLocation]);

  if (voiceOverlayRouteActive()) {
    return (
      <ErrorBoundary resetKey={location}>
        <VoiceOverlayPage />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary resetKey={location}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/server" component={Workspace} />
        <Route path="/diagnostics">{() => <Diagnostics />}</Route>
        <Route path="/settings">{() => <SettingsPage />}</Route>
        <Route path="/voice-overlay">{() => <VoiceOverlayPage />}</Route>
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  const overlayShell = voiceOverlayRouteActive();
  const router = (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Router />
    </WouterRouter>
  );
  if (overlayShell) {
    return router;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {router}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
