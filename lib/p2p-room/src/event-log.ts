export type OrderedEvent = {
  eventId: string;
  sequence: number;
  predecessorId?: string;
};

/** Idempotent event buffer: duplicates are ignored, events with missing predecessors wait. */
export class EventLog<T extends OrderedEvent> {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, T>();
  private readonly applied: T[] = [];

  constructor(private readonly maxPending = 1000) {}

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  stage(event: T): "duplicate" | "pending" | "applied" {
    if (this.seen.has(event.eventId) || this.pending.has(event.eventId)) return "duplicate";
    if (event.predecessorId && !this.seen.has(event.predecessorId)) {
      if (this.pending.size >= this.maxPending) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      this.pending.set(event.eventId, event);
      return "pending";
    }
    this.applyNow(event);
    this.drainPending();
    return "applied";
  }

  private applyNow(event: T): void {
    this.seen.add(event.eventId);
    this.applied.push(event);
  }

  private drainPending(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [eventId, event] of this.pending) {
        if (event.predecessorId && !this.seen.has(event.predecessorId)) continue;
        this.pending.delete(eventId);
        this.applyNow(event);
        progressed = true;
      }
    }
  }

  listApplied(): T[] {
    return [...this.applied].sort((left, right) => left.sequence - right.sequence);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
