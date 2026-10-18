// Contract: docs/BLUEPRINT.md F-002. Only one holder at a time may drive the bot's body
// (pathfinder, control states, looking, attacking, using the held item).

export const PRIORITY = {
  URGENT_INSTINCT: 30,
  MANUAL: 20,
  INSTINCT: 15,
  TASK: 10
} as const;

export type Priority = typeof PRIORITY[keyof typeof PRIORITY];
export type PreemptorKind = 'instinct' | 'manual';
export type LeaseState = 'active' | 'suspended' | 'revoked' | 'released';

export interface HolderInfo {
  holder: string;
  priority: Priority;
}

export interface Preemptor extends HolderInfo {
  kind: PreemptorKind;
}

export interface LeaseRequest {
  holder: string;
  priority: Priority;
  /** Called when a higher priority holder takes over. `revoked` means the lease will not come back on its own. */
  onSuspend?: (by: Preemptor, revoked: boolean) => void;
  onResume?: () => void;
}

export interface Lease extends HolderInfo {
  readonly state: LeaseState;
  isActive(): boolean;
  release(): void;
}

export type AcquireResult =
  | { ok: true; lease: Lease; preempted: HolderInfo[]; waitedMs: number; waitedFor?: HolderInfo }
  | { ok: false; busy: HolderInfo; waitedMs: number };

const DEFAULT_MANUAL_WAIT_MS = 10000;

function kindOf(priority: Priority): PreemptorKind {
  return priority === PRIORITY.MANUAL ? 'manual' : 'instinct';
}

class LeaseImpl implements Lease {
  state: LeaseState;

  constructor(
    readonly request: LeaseRequest,
    private readonly onRelease: (lease: LeaseImpl) => void,
    initial: LeaseState
  ) {
    this.state = initial;
  }

  get holder(): string {
    return this.request.holder;
  }

  get priority(): Priority {
    return this.request.priority;
  }

  isActive(): boolean {
    return this.state === 'active';
  }

  release(): void {
    if (this.state === 'released' || this.state === 'revoked') return;
    this.onRelease(this);
  }
}

interface Waiter {
  request: LeaseRequest;
  started: number;
  blockedBy: HolderInfo | null;
  resolve: (result: AcquireResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ArbiterOptions {
  /** Safety net run on every preemption: stop the pathfinder and clear control states. */
  stopBody: () => void;
  log?: (level: string, message: string) => void;
}

export class ActionArbiter {
  private current: LeaseImpl | null = null;
  // Holders preempted by the instinct, most recent last; they resume when it lets go.
  private suspended: LeaseImpl[] = [];
  private waiters: Waiter[] = [];

  constructor(private readonly options: ArbiterOptions) {}

  holder(): HolderInfo | null {
    return this.current ? { holder: this.current.holder, priority: this.current.priority } : null;
  }

  /**
   * Take the body now if possible, otherwise queue behind the current holder in the suspended state.
   * Used by tasks, which must not be dropped just because an instinct action or manual command is running.
   */
  acquireOrQueue(request: LeaseRequest): Lease {
    if (this.canTake(request.priority)) {
      return this.grant(request, Date.now()).lease;
    }
    const lease = new LeaseImpl(request, released => this.handleRelease(released), 'suspended');
    this.insertSuspended(lease);
    return lease;
  }

  /**
   * Take the body right now, or return null. Used by the instinct, which cannot wait. `replacing` is the
   * caller's own current lease: it is handed over directly, so nothing paused resumes in between (one instinct action
   * interrupting another of the same priority).
   */
  acquireNow(request: LeaseRequest, replacing?: Lease): Lease | null {
    if (replacing && this.current === replacing) {
      this.current.state = 'released';
      this.current = null;
      // A handover is still a preemption: clear the old holder's goal and controls (G4).
      this.safeStop();
    }
    if (!this.canTake(request.priority)) return null;
    return this.grant(request, Date.now()).lease;
  }

  /** Take the body, preempting lower priorities and waiting up to `waitMs` behind equal or higher ones. */
  acquire(request: LeaseRequest, waitMs = request.priority === PRIORITY.MANUAL ? DEFAULT_MANUAL_WAIT_MS : 0): Promise<AcquireResult> {
    const started = Date.now();
    if (this.canTake(request.priority)) {
      return Promise.resolve(this.grant(request, started));
    }
    if (waitMs <= 0) {
      return Promise.resolve({ ok: false, busy: this.holder()!, waitedMs: 0 });
    }
    return new Promise(resolve => {
      const waiter: Waiter = {
        request,
        started,
        blockedBy: this.holder(),
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(w => w !== waiter);
          resolve({ ok: false, busy: this.holder() ?? { holder: 'unknown', priority: request.priority }, waitedMs: Date.now() - started });
        }, waitMs)
      };
      this.waiters.push(waiter);
    });
  }

  private canTake(priority: Priority): boolean {
    return !this.current || priority > this.current.priority;
  }

  private grant(request: LeaseRequest, started: number): { ok: true; lease: Lease; preempted: HolderInfo[]; waitedMs: number } {
    const preempted: HolderInfo[] = [];
    const preemptor: Preemptor = { holder: request.holder, priority: request.priority, kind: kindOf(request.priority) };

    if (this.current) {
      const previous = this.current;
      this.current = null;
      this.safeStop();
      preempted.push({ holder: previous.holder, priority: previous.priority });
      if (preemptor.kind === 'manual') {
        this.revoke(previous, preemptor);
      } else {
        previous.state = 'suspended';
        this.suspended.push(previous);
        this.notifySuspend(previous, preemptor, false);
      }
    }

    // A manual command means the LLM has taken over: nothing that was waiting to resume comes back by itself.
    if (preemptor.kind === 'manual') {
      for (const lease of this.suspended.splice(0)) {
        preempted.push({ holder: lease.holder, priority: lease.priority });
        this.revoke(lease, preemptor);
      }
    }

    const lease = new LeaseImpl(request, released => this.handleRelease(released), 'active');
    this.current = lease;
    return { ok: true, lease, preempted, waitedMs: Date.now() - started };
  }

  private revoke(lease: LeaseImpl, by: Preemptor): void {
    lease.state = 'revoked';
    this.notifySuspend(lease, by, true);
  }

  private insertSuspended(lease: LeaseImpl): void {
    // Keep the stack ordered so the highest priority resumes first; equal priorities keep arrival order.
    let index = 0;
    while (index < this.suspended.length && this.suspended[index].priority <= lease.priority) index++;
    this.suspended.splice(index, 0, lease);
  }

  private handleRelease(lease: LeaseImpl): void {
    const wasCurrent = this.current === lease;
    lease.state = 'released';
    this.suspended = this.suspended.filter(entry => entry !== lease);
    if (!wasCurrent) return;
    this.current = null;
    this.promoteNext();
  }

  private promoteNext(): void {
    const topSuspended = this.suspended[this.suspended.length - 1];
    const bestWaiter = this.waiters.reduce<Waiter | undefined>(
      (best, waiter) => (!best || waiter.request.priority > best.request.priority ? waiter : best),
      undefined
    );

    if (bestWaiter && (!topSuspended || bestWaiter.request.priority >= topSuspended.priority)) {
      this.waiters = this.waiters.filter(waiter => waiter !== bestWaiter);
      clearTimeout(bestWaiter.timer);
      bestWaiter.resolve({ ...this.grant(bestWaiter.request, bestWaiter.started), waitedFor: bestWaiter.blockedBy ?? undefined });
      return;
    }

    if (topSuspended) {
      this.suspended.pop();
      topSuspended.state = 'active';
      this.current = topSuspended;
      try {
        topSuspended.request.onResume?.();
      } catch (error) {
        this.options.log?.('warn', `Resume callback of ${topSuspended.holder} failed: ${error}`);
      }
    }
  }

  private notifySuspend(lease: LeaseImpl, by: Preemptor, revoked: boolean): void {
    try {
      lease.request.onSuspend?.(by, revoked);
    } catch (error) {
      this.options.log?.('warn', `Suspend callback of ${lease.holder} failed: ${error}`);
    }
  }

  private safeStop(): void {
    try {
      this.options.stopBody();
    } catch (error) {
      this.options.log?.('warn', `Stopping the bot during preemption failed: ${error}`);
    }
  }
}
