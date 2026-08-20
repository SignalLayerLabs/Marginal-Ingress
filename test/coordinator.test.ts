import { describe, expect, it } from "vitest";

import { CoordinatorCore, type IdempotencyStore } from "../src/coordinator";
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
  public record:
    | { digest: string; expiresAt: number; descriptor: PendingDescriptor }
    | undefined;

  public async get(): Promise<typeof this.record> {
    return this.record;
  }

  public async put(record: NonNullable<typeof this.record>): Promise<void> {
    this.record = record;
  }

  public async remove(): Promise<void> {
    this.record = undefined;
  }

  public async purgeExpired(now: number): Promise<void> {
    if (this.record !== undefined && this.record.expiresAt <= now)
      this.record = undefined;
  }
}

function plan(blobSha = descriptor.blobSha): WritePlan {
  return { descriptor: { ...descriptor, blobSha }, content: "{}" };
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
    expect(store.record?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(store.record)).not.toContain("APPROVED");
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
    expect(store.record?.descriptor.blobSha).toBe("b".repeat(40));
  });
});
