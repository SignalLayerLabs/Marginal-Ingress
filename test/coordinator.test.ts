import { describe, expect, it } from "vitest";

import {
  CoordinatorCore,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "../src/coordinator";
import {
  GitHubConflictError,
  type GitHubSink,
  type PendingDescriptor,
  type WritePlan,
} from "../src/github-sink";

const descriptor: PendingDescriptor = {
  target: "models/openai/gpt-5.6-sol/aggregates.json",
  blobSha: "a".repeat(40),
};
const envelope = {
  schema_version: "1.0",
  model_namespace: "openai/gpt-5.6-sol",
  atoms: [
    {
      record_type: "decision",
      action_kind: "tool",
      cost_bucket: "low",
      gain_bucket: "medium",
      recommendation: "allow",
      applied_decision: "allow",
      reason_code: "APPROVED",
      outcome_class: "not_applicable",
      count: 1,
      minimum_group_size: 1,
    },
  ],
} as const;

class MemoryStore implements IdempotencyStore {
  public readonly records = new Map<string, IdempotencyRecord>();

  public async get(digest: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(digest);
  }

  public async put(record: IdempotencyRecord): Promise<void> {
    this.records.set(record.digest, record);
  }

  public async remove(digest: string): Promise<void> {
    this.records.delete(digest);
  }

  public async purgeExpired(now: number): Promise<void> {
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(digest);
    }
  }

  public async nextExpiry(): Promise<number | undefined> {
    return [...this.records.values()].reduce<number | undefined>(
      (earliest, record) =>
        earliest === undefined || record.expiresAt < earliest
          ? record.expiresAt
          : earliest,
      undefined,
    );
  }
}

class AlarmAtomicMemoryStore extends MemoryStore {
  public alarmAt: number | undefined;

  public async putAndSchedule(record: IdempotencyRecord): Promise<void> {
    this.records.set(record.digest, record);
    this.alarmAt = await this.nextExpiry();
  }

  public async purgeExpiredAndSchedule(now: number): Promise<void> {
    await this.purgeExpired(now);
    this.alarmAt = await this.nextExpiry();
  }
}

function plan(blobSha = descriptor.blobSha): WritePlan {
  return { descriptor: { ...descriptor, blobSha }, content: "{}" };
}

async function idempotencyDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("serialized idempotency coordinator", () => {
  it("reconciles an already-written blob as a duplicate without another aggregate write", async () => {
    const store = new MemoryStore();
    let commits = 0;
    const sink = {
      prepare: async () => plan(),
      commit: async () => {
        commits += 1;
      },
      isApplied: async () => true,
    } as unknown as GitHubSink;
    const coordinator = new CoordinatorCore(store, sink, () => 10);

    expect(await coordinator.submit(envelope, "a".repeat(32))).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(await coordinator.submit(envelope, "a".repeat(32))).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(commits).toBe(1);
    const stored = [...store.records.values()];
    expect(stored[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("APPROVED");
  });

  it("replans exactly once when GitHub reports a blob conflict", async () => {
    const store = new MemoryStore();
    let preparations = 0;
    let commits = 0;
    const sink = {
      prepare: async () => {
        preparations += 1;
        return plan(preparations === 1 ? "a".repeat(40) : "b".repeat(40));
      },
      commit: async () => {
        commits += 1;
        if (commits === 1) throw new GitHubConflictError();
      },
      isApplied: async () => false,
    } as unknown as GitHubSink;

    const result = await new CoordinatorCore(store, sink, () => 10).submit(
      envelope,
      "b".repeat(32),
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(preparations).toBe(2);
    expect(commits).toBe(2);
    expect([...store.records.values()][0]?.descriptor.blobSha).toBe(
      "b".repeat(40),
    );
  });

  it("reconciles the original pending blob before replanning a conflict", async () => {
    const store = new MemoryStore();
    let preparations = 0;
    const sink = {
      prepare: async () => {
        preparations += 1;
        return plan();
      },
      commit: async () => {
        throw new GitHubConflictError();
      },
      isApplied: async () => true,
    } as unknown as GitHubSink;

    const result = await new CoordinatorCore(store, sink, () => 10).submit(
      envelope,
      "z".repeat(32),
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(preparations).toBe(1);
  });

  it("recognizes an original write that lands after an absence check and retry conflict", async () => {
    const store = new MemoryStore();
    let reconciliations = 0;
    let commits = 0;
    const sink = {
      prepare: async () => plan(),
      commit: async () => {
        commits += 1;
        throw new GitHubConflictError();
      },
      isApplied: async () => {
        reconciliations += 1;
        return reconciliations === 2;
      },
    } as unknown as GitHubSink;

    const result = await new CoordinatorCore(store, sink, () => 10).submit(
      envelope,
      "w".repeat(32),
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(commits).toBe(2);
    expect(reconciliations).toBe(2);
  });

  it("keeps an unknown GitHub write outcome inconclusive instead of replanning it", async () => {
    const store = new MemoryStore();
    let preparations = 0;
    const sink = {
      prepare: async () => {
        preparations += 1;
        return plan();
      },
      commit: async () => {
        throw new Error("connection reset after upload");
      },
      isApplied: async () => false,
    } as unknown as GitHubSink;
    const coordinator = new CoordinatorCore(store, sink, () => 10);

    await expect(coordinator.submit(envelope, "y".repeat(32))).rejects.toThrow(
      "connection reset after upload",
    );
    await expect(coordinator.submit(envelope, "y".repeat(32))).rejects.toThrow(
      "inconclusive",
    );

    expect(preparations).toBe(1);
  });

  it("fails closed across a reset during dispatch until a delayed original lands", async () => {
    const store = new MemoryStore();
    const key = "i".repeat(32);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delayedWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstSink = {
      prepare: async () => plan(),
      commit: async () => {
        expect(store.records.get(await idempotencyDigest(key))?.status).toBe(
          "in_flight",
        );
        started?.();
        await delayedWrite;
        throw new Error("simulated reset after dispatch");
      },
      isApplied: async () => false,
    } as unknown as GitHubSink;
    const first = new CoordinatorCore(store, firstSink, () => 10).submit(
      envelope,
      key,
    );
    await dispatched;

    let recoveryCommits = 0;
    await expect(
      new CoordinatorCore(
        store,
        {
          prepare: async () => plan(),
          commit: async () => {
            recoveryCommits += 1;
          },
          isApplied: async () => false,
        } as unknown as GitHubSink,
        () => 10,
      ).submit(envelope, key),
    ).rejects.toThrow("inconclusive");

    expect(recoveryCommits).toBe(0);
    release?.();
    await expect(first).rejects.toThrow("simulated reset after dispatch");
    const reconciled = await new CoordinatorCore(
      store,
      {
        prepare: async () => plan(),
        commit: async () => {
          recoveryCommits += 1;
        },
        isApplied: async () => true,
      } as unknown as GitHubSink,
      () => 10,
    ).submit(envelope, key);
    expect(reconciled).toEqual({ accepted: true, duplicate: true });
    expect(recoveryCommits).toBe(0);
  });

  it("leaves a known second conflict absent as retryable pending work", async () => {
    const store = new MemoryStore();
    let commits = 0;
    const sink = {
      prepare: async () => plan(),
      commit: async () => {
        commits += 1;
        if (commits < 3) throw new GitHubConflictError();
      },
      isApplied: async () => false,
    } as unknown as GitHubSink;
    const coordinator = new CoordinatorCore(store, sink, () => 10);

    await expect(coordinator.submit(envelope, "k".repeat(32))).rejects.toThrow(
      "GitHub conflict",
    );
    expect([...store.records.values()][0]?.status).toBe("pending");
    await expect(coordinator.submit(envelope, "k".repeat(32))).resolves.toEqual(
      { accepted: true, duplicate: false },
    );
    expect(commits).toBe(3);
  });

  it("keeps a completed retry duplicate after a later same-model write", async () => {
    const store = new MemoryStore();
    let commits = 0;
    const sink = {
      prepare: async () => plan(),
      commit: async () => {
        commits += 1;
      },
      isApplied: async () => false,
    } as unknown as GitHubSink;
    const coordinator = new CoordinatorCore(store, sink, () => 10);

    await coordinator.submit(envelope, "a".repeat(32));
    await coordinator.submit(envelope, "b".repeat(32));
    const retry = await coordinator.submit(envelope, "a".repeat(32));

    expect(retry).toEqual({ accepted: true, duplicate: true });
    expect(commits).toBe(2);
  });

  it("does not start a later reconciliation while an earlier GitHub write is pending", async () => {
    const store = new MemoryStore();
    let releaseFirstCommit: (() => void) | undefined;
    let firstCommitStarted: (() => void) | undefined;
    const firstCommit = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstCommitStarted = resolve;
    });
    let secondPreparationObserved: (() => void) | undefined;
    const secondPreparation = new Promise<void>((resolve) => {
      secondPreparationObserved = resolve;
    });
    let preparations = 0;
    const sink = {
      prepare: async () => {
        preparations += 1;
        if (preparations === 2) secondPreparationObserved?.();
        return plan();
      },
      commit: async () => {
        firstCommitStarted?.();
        await firstCommit;
      },
      isApplied: async () => false,
    } as unknown as GitHubSink;
    const coordinator = new CoordinatorCore(store, sink, () => 10);

    const first = coordinator.submit(envelope, "a".repeat(32));
    await started;
    const later = coordinator.submit(envelope, "b".repeat(32));

    expect(
      await Promise.race([
        secondPreparation.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10)),
      ]),
    ).toBe(false);
    expect(preparations).toBe(1);
    releaseFirstCommit?.();
    await Promise.all([first, later]);
  });

  it("marks a crash-window pending write completed when reconciliation finds its blob", async () => {
    const store = new MemoryStore();
    const key = "c".repeat(32);
    await store.put({
      digest: await idempotencyDigest(key),
      expiresAt: 86_410_000,
      descriptor,
      status: "pending",
    });
    let commits = 0;
    const sink = {
      prepare: async () => plan(),
      commit: async () => {
        commits += 1;
      },
      isApplied: async () => true,
    } as unknown as GitHubSink;

    const result = await new CoordinatorCore(store, sink, () => 10).submit(
      envelope,
      key,
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(commits).toBe(0);
    expect(store.records.get(await idempotencyDigest(key))?.status).toBe(
      "completed",
    );
  });

  it("expires an idle digest when the Durable Object alarm runs", async () => {
    const store = new MemoryStore();
    const scheduled: { at: number | undefined } = { at: undefined };
    type Scheduler = { schedule(at: number | undefined): Promise<void> };
    const scheduler: Scheduler = {
      schedule: async (at: number | undefined) => {
        scheduled.at = at;
      },
    };
    let now = 10;
    const AlarmCapableCore = CoordinatorCore as unknown as new (
      store: IdempotencyStore,
      sink: GitHubSink,
      clock: () => number,
      scheduler: Scheduler,
    ) => CoordinatorCore & { expire(): Promise<void> };
    const sink = {
      prepare: async () => plan(),
      commit: async () => undefined,
      isApplied: async () => false,
    } as unknown as GitHubSink;
    const coordinator = new AlarmCapableCore(store, sink, () => now, scheduler);

    await coordinator.submit(envelope, "d".repeat(32));
    expect(scheduled.at).toBe(86_400_010);
    now = 86_400_010;
    await coordinator.expire();

    expect(store.records.size).toBe(0);
    expect(scheduled.at).toBeUndefined();
  });

  it("establishes the expiry alarm before a reset can resume a persisted digest", async () => {
    const store = new AlarmAtomicMemoryStore();
    let now = 10;
    const sink = {
      prepare: async () => plan(),
      commit: async () => undefined,
      isApplied: async () => false,
    } as unknown as GitHubSink;
    const firstInstance = new CoordinatorCore(store, sink, () => now);

    await firstInstance.submit(envelope, "r".repeat(32));
    expect(store.alarmAt).toBe(86_400_010);

    now = 86_400_010;
    await new CoordinatorCore(store, sink, () => now).expire();

    expect(store.records.size).toBe(0);
    expect(store.alarmAt).toBeUndefined();
  });
});
