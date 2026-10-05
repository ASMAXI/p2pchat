import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  probeNetworkHealth,
  type HealthLevel,
  type HealthRow,
  type NetworkHealthReport,
} from "@/lib/network-health";

function mark(level: HealthLevel): string {
  switch (level) {
    case "ok":
      return "✓";
    case "warn":
      return "!";
    case "fail":
      return "✕";
    case "checking":
      return "…";
    default:
      return "—";
  }
}

function markClass(level: HealthLevel): string {
  switch (level) {
    case "ok":
      return "text-[hsl(var(--primary))]";
    case "warn":
      return "text-[hsl(42_92%_48%)]";
    case "fail":
      return "text-[hsl(var(--accent))]";
    default:
      return "text-[hsl(var(--muted-foreground))]";
  }
}

function HealthGroup({ title, rows }: { title: string; rows: HealthRow[] }) {
  return (
    <div className="mt-3">
      <div className="font-mono text-[10px] font-bold uppercase tracking-[.16em] text-[hsl(var(--muted-foreground))]">
        {title}
      </div>
      <ul className="mt-2 space-y-1.5" data-testid={`network-health-${title.toLowerCase()}`}>
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-start gap-2 rounded-lg border border-[hsl(var(--border)/.7)] bg-[hsl(var(--muted)/.25)] px-3 py-2"
            data-testid={`network-health-row-${row.id}`}
          >
            <span
              className={`mt-0.5 w-4 shrink-0 text-center font-mono text-xs font-bold ${markClass(row.level)}`}
              aria-label={row.level}
            >
              {mark(row.level)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{row.label}</span>
              <span className="mt-0.5 block break-all text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
                {row.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NetworkHealthPanel() {
  const [report, setReport] = useState<NetworkHealthReport | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const next = await probeNetworkHealth();
      setReport(next);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div
      className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.55)] p-4"
      data-testid="network-health-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] font-bold uppercase tracking-[.18em] text-[hsl(var(--secondary))]">
            Network Health
          </div>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            Чат/туннель и голос (STUN/TURN) — разные пути. Проверка занимает пару секунд.
          </p>
        </div>
        <button
          type="button"
          className="ghost-btn !h-8 !px-2 text-xs"
          disabled={busy}
          onClick={() => void run()}
          data-testid="button-network-health-refresh"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
          {busy ? "Проверяем…" : "Обновить"}
        </button>
      </div>

      {report ? (
        <>
          <HealthGroup title="Control" rows={report.control} />
          <HealthGroup title="Voice" rows={report.voice} />
        </>
      ) : (
        <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">Собираем статус…</p>
      )}
    </div>
  );
}
