import type { EventEnvelope } from "@farmlink/schema";

/** Seqs that never arrived on a branch: between `after` and `next`. */
export interface Gap {
  branchId: string;
  after: number;
  next: number;
  missing: number;
}

export interface BranchSummary {
  branchId: string;
  first: number;
  last: number;
  events: number;
  parentBranchId: string | null;
  forkSeq: number | null;
}

interface BranchState extends BranchSummary {}

/**
 * The gap check (docs/HANDOFF.md, Supabase sync). Each branch's seqs must run on without a hole: a
 * root branch from 1, and a branch forked from an older save from its fork seq + 1, which its first
 * line, a `session` event, names. A seq seen again is a duplicate and counts once.
 */
export class SequenceCheck {
  private readonly branches = new Map<string, BranchState>();
  readonly gaps: Gap[] = [];
  duplicates = 0;

  /** Adds an event in log order. Returns the gap it revealed, if any, or "duplicate". */
  add(event: EventEnvelope): Gap | "duplicate" | undefined {
    const { branchId, seq } = event;
    const branch = this.branches.get(branchId);
    if (branch === undefined) {
      const fork = event.type === "session" ? event.data : undefined;
      const parentBranchId = fork?.parentBranchId ?? null;
      const forkSeq = fork?.forkSeq ?? null;
      this.branches.set(branchId, {
        branchId,
        first: seq,
        last: seq,
        events: 1,
        parentBranchId,
        forkSeq,
      });
      // Where the branch has to start: after its fork, or at 1. A branch first seen further on
      // (its earlier files already cleared) has no known start.
      const expected = forkSeq !== null ? forkSeq + 1 : seq === 1 ? 1 : undefined;
      if (expected !== undefined && seq > expected) return this.gap(branchId, expected - 1, seq);
      return undefined;
    }
    if (seq <= branch.last) {
      this.duplicates += 1;
      return "duplicate";
    }
    const previous = branch.last;
    branch.last = seq;
    branch.events += 1;
    if (seq > previous + 1) return this.gap(branchId, previous, seq);
    return undefined;
  }

  /** The branches seen, in the order they first appeared. */
  get summary(): BranchSummary[] {
    return [...this.branches.values()].map((branch) => ({ ...branch }));
  }

  lastSeq(branchId: string): number | undefined {
    return this.branches.get(branchId)?.last;
  }

  private gap(branchId: string, after: number, next: number): Gap {
    const gap = { branchId, after, next, missing: next - after - 1 };
    this.gaps.push(gap);
    return gap;
  }
}
