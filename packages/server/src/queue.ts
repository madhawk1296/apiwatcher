import type { ScanTrigger } from './db.js';

/**
 * What one scan needs to know. Everything else is looked up at run time.
 */
export interface ScanRequest {
  fullName: string;
  installationId: number;
  /** Commit to scan. */
  sha: string;
  trigger: ScanTrigger;
  /** `latest` resolves at run time against the synced changesets. */
  targetVersion: string;
  /** Present for pull_request triggers; a check run is posted on the head. */
  prNumber?: number;
  /** Post or update the tracking issue (default-branch pushes and version alerts). */
  updateIssue: boolean;
  /** Post a check run on the commit (pushes and PRs). */
  postCheck: boolean;
  requestedAt: string;
}

export type ScanRunner = (request: ScanRequest) => Promise<void>;

interface Slot {
  /** The request currently running for this repo, if any. */
  running: ScanRequest | null;
  /** At most one queued follow-up; a newer request replaces an older one. */
  pending: ScanRequest | null;
}

/**
 * In-process scan queue with per-repo coalescing.
 *
 * Three pushes to the same repo during one scan produce one follow-up scan of
 * the newest commit, not three scans. Concurrency is bounded because clones are
 * the expensive part and a small box only has so much I/O.
 *
 * This is deliberately not durable: if the process dies, in-flight requests are
 * lost. That is acceptable because every trigger is recoverable — the next push
 * re-triggers, and the version poller re-fans-out anything it has not marked as
 * alerted.
 */
export class ScanQueue {
  private readonly slots = new Map<string, Slot>();
  private readonly waiting: string[] = [];
  private active = 0;
  private stopped = false;

  constructor(
    private readonly runner: ScanRunner,
    private readonly concurrency: number,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Number of repos with work queued or running. */
  get size(): number {
    return this.slots.size;
  }

  get inFlight(): number {
    return this.active;
  }

  enqueue(request: ScanRequest): 'queued' | 'coalesced' | 'replaced' {
    const key = request.fullName.toLowerCase();
    const slot = this.slots.get(key) ?? { running: null, pending: null };

    let outcome: 'queued' | 'coalesced' | 'replaced';
    if (slot.pending) {
      // Keep the newer request; the older one is now stale.
      slot.pending = mergeRequests(slot.pending, request);
      outcome = 'replaced';
    } else if (slot.running) {
      slot.pending = request;
      outcome = 'coalesced';
    } else {
      slot.pending = request;
      this.waiting.push(key);
      outcome = 'queued';
    }
    this.slots.set(key, slot);
    void this.pump();
    return outcome;
  }

  /** Resolve once everything currently queued has finished. For tests and shutdown. */
  async drain(): Promise<void> {
    while (this.active > 0 || this.waiting.length > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.active < this.concurrency && this.waiting.length > 0) {
      const key = this.waiting.shift();
      if (key === undefined) break;
      const slot = this.slots.get(key);
      if (!slot || !slot.pending) continue;

      const request = slot.pending;
      slot.pending = null;
      slot.running = request;
      this.active += 1;

      void this.run(key, slot, request);
    }
  }

  private async run(key: string, slot: Slot, request: ScanRequest): Promise<void> {
    try {
      await this.runner(request);
    } catch (err) {
      // The runner records its own failures; this catches bugs in the runner.
      this.log(`scan ${request.fullName}@${request.sha.slice(0, 7)} crashed: ${(err as Error).message}`);
    } finally {
      this.active -= 1;
      slot.running = null;
      if (slot.pending) {
        // A follow-up arrived while we ran; schedule it.
        this.waiting.push(key);
      } else {
        this.slots.delete(key);
      }
      void this.pump();
    }
  }
}

/**
 * Two requests for one repo collapse into the newer one, but keep any posting
 * obligation either of them had — a PR check owed by the first should not be
 * dropped because a default-branch push arrived second.
 */
function mergeRequests(older: ScanRequest, newer: ScanRequest): ScanRequest {
  return {
    ...newer,
    updateIssue: older.updateIssue || newer.updateIssue,
    postCheck: older.postCheck || newer.postCheck,
  };
}
