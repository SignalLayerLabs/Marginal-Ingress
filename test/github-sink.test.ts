import { describe, expect, it } from "vitest";

import {
  GITHUB_COMMITTER,
  GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_REPOSITORY,
  HISTORY_LIMIT,
  HISTORY_PAGE_LIMIT,
  MAX_AGGREGATE_ATOMS,
  GitHubSink,
  type PendingDescriptor,
} from "../src/github-sink";
import type { CommonsEvidenceEnvelopeV1 } from "../src/schema";

const atom = {
  record_type: "decision",
  action_kind: "tool",
  cost_bucket: "low",
  gain_bucket: "medium",
  recommendation: "allow",
  applied_decision: "allow",
  reason_code: "APPROVED",
  outcome_class: "not_applicable",
  count: 2,
  minimum_group_size: 1,
} as const;

const envelope = {
  schema_version: "1.0",
  model_namespace: "openai/gpt-5.6-sol",
  atoms: [atom],
} as const;

function encoded(value: unknown): string {
  return btoa(JSON.stringify(value));
}

describe("GitHub aggregate sink", () => {
  it("reads the current blob and writes a fixed anonymous aggregate commit", async () => {
    let putBody: Record<string, unknown> | undefined;
    const sink = new GitHubSink("service-token", async (input, init) => {
      const url = String(input);
      expect(url).toContain(
        `/repos/${GITHUB_REPOSITORY}/contents/models/openai/gpt-5.6-sol/aggregates.json`,
      );
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          sha: "current-blob-sha",
          content: encoded({ ...envelope, atoms: [{ ...atom, count: 3 }] }),
        }),
        { status: 200 },
      );
    });

    const plan = await sink.prepare(envelope);
    await sink.commit(plan);

    expect(plan.currentSha).toBe("current-blob-sha");
    expect(putBody).toMatchObject({
      sha: "current-blob-sha",
      committer: GITHUB_COMMITTER,
    });
    const content = atob(String(putBody?.content));
    expect(JSON.parse(content)).toMatchObject({
      atoms: [{ ...atom, count: 5 }],
    });
  });

  it("rejects an existing aggregate document containing an unknown field", async () => {
    const sink = new GitHubSink(
      "service-token",
      async () =>
        new Response(
          JSON.stringify({
            sha: "current-blob-sha",
            content: encoded({ ...envelope, canary: "customer-acme" }),
          }),
          { status: 200 },
        ),
    );

    await expect(sink.prepare(envelope)).rejects.toThrow(
      "invalid aggregate document",
    );
  });

  it("reconciles a crash after a later write by finding the pending blob in bounded history", async () => {
    const pending: PendingDescriptor = {
      target: "models/openai/gpt-5.6-sol/aggregates.json",
      blobSha: "a".repeat(40),
    };
    const sink = new GitHubSink("service-token", async (input) => {
      const url = String(input);
      if (url.includes("/commits?")) {
        return new Response(
          JSON.stringify([{ sha: "commit-before-later-write" }]),
        );
      }
      if (url.includes("ref=commit-before-later-write")) {
        return new Response(JSON.stringify({ sha: pending.blobSha }));
      }
      return new Response(JSON.stringify({ sha: "b".repeat(40) }));
    });

    await expect(sink.isApplied(pending)).resolves.toBe(true);
  });

  it("searches every entry in a full first history page before treating it as incomplete", async () => {
    const pending: PendingDescriptor = {
      target: "models/openai/gpt-5.6-sol/aggregates.json",
      blobSha: "a".repeat(40),
    };
    const commits = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
      sha: `commit-${index}`,
    }));
    const sink = new GitHubSink("service-token", async (input) => {
      const url = String(input);
      if (url.includes("/commits?"))
        return new Response(JSON.stringify(commits));
      if (url.includes(`ref=commit-${HISTORY_LIMIT - 1}`)) {
        return new Response(JSON.stringify({ sha: pending.blobSha }));
      }
      return new Response(JSON.stringify({ sha: "b".repeat(40) }));
    });

    await expect(sink.isApplied(pending)).resolves.toBe(true);
  });

  it("bounds an absent reconciliation below the 50-subrequest plan budget", async () => {
    const pending: PendingDescriptor = {
      target: "models/openai/gpt-5.6-sol/aggregates.json",
      blobSha: "a".repeat(40),
    };
    const commits = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
      sha: `commit-${index}`,
    }));
    let requests = 0;
    const sink = new GitHubSink("service-token", async (input) => {
      const url = String(input);
      if (url.includes("/commits?")) {
        requests += 1;
        const page = url.includes("page=3")
          ? 3
          : url.includes("page=2")
            ? 2
            : 1;
        return new Response(JSON.stringify(commits), {
          headers:
            page < HISTORY_PAGE_LIMIT
              ? {
                  Link: `<https://api.github.com/repos/SignalLayerLabs/Marginal-Commons/commits?path=models%2Fopenai%2Fgpt-5.6-sol%2Faggregates.json&per_page=${HISTORY_LIMIT}&page=${page + 1}>; rel="next"`,
                }
              : {},
        });
      }
      requests += 1;
      return new Response(JSON.stringify({ sha: "b".repeat(40) }));
    });

    await expect(sink.isApplied(pending)).resolves.toBe(false);
    expect(requests).toBe(1 + HISTORY_PAGE_LIMIT * (1 + HISTORY_LIMIT));
    expect(requests).toBeLessThanOrEqual(50);
  });

  it("rejects a history page that exceeds the requested bounded page size", async () => {
    const pending: PendingDescriptor = {
      target: "models/openai/gpt-5.6-sol/aggregates.json",
      blobSha: "a".repeat(40),
    };
    const sink = new GitHubSink("service-token", async (input) => {
      if (String(input).includes("/commits?")) {
        return new Response(
          JSON.stringify(
            Array.from({ length: HISTORY_LIMIT + 1 }, (_, index) => ({
              sha: `too-many-${index}`,
            })),
          ),
        );
      }
      return new Response(JSON.stringify({ sha: "b".repeat(40) }));
    });

    await expect(sink.isApplied(pending)).rejects.toThrow(
      "exceeds requested limit",
    );
  });

  it("caps aggregate cardinality before it can exceed a subsequently readable file", async () => {
    const actionKinds = [
      "command",
      "file_read",
      "file_write",
      "generation",
      "llm",
      "model_call",
      "reasoning",
      "research",
      "review",
      "search",
      "subagent",
      "test",
      "tool",
      "verification",
      "unknown",
    ];
    const reasonCodes = [
      "APPROVED",
      "BUDGET_REJECTED",
      "DENY",
      "DUPLICATE_ACTION",
      "DUPLICATE_PENDING",
      "EXPECTED_GAIN_REJECTED",
      "FUNDED",
      "MARGINAL_ROI_REJECTED",
      "OTHER",
      "PARENT_BUDGET_REJECTED",
      "RECOMMEND_OVERRIDE",
      "SHADOW_OVERRIDE",
      "TARGET_REACHED",
      "UNSPECIFIED",
      "not_applicable",
    ];
    const atoms = Array.from({ length: MAX_AGGREGATE_ATOMS }, (_, index) => ({
      ...atom,
      action_kind: actionKinds[index % actionKinds.length],
      reason_code: reasonCodes[Math.floor(index / actionKinds.length)],
    }));
    const sink = new GitHubSink(
      "service-token",
      async () =>
        new Response(
          JSON.stringify({
            sha: "current",
            content: encoded({ ...envelope, atoms }),
          }),
          { status: 200 },
        ),
    );
    const newAtomEnvelope: CommonsEvidenceEnvelopeV1 = {
      ...envelope,
      atoms: [{ ...atom, action_kind: "other", reason_code: "not_applicable" }],
    };

    await expect(sink.prepare(newAtomEnvelope)).rejects.toThrow(
      "aggregate capacity exceeded",
    );
  });

  it("keeps a readable 129-atom legacy aggregate losslessly mergeable without allowing new cardinality", async () => {
    const actionKinds = [
      "command",
      "file_read",
      "file_write",
      "generation",
      "llm",
      "model_call",
      "reasoning",
      "research",
      "review",
      "search",
      "subagent",
      "test",
      "tool",
      "verification",
      "unknown",
    ];
    const reasonCodes = [
      "APPROVED",
      "BUDGET_REJECTED",
      "DENY",
      "DUPLICATE_ACTION",
      "DUPLICATE_PENDING",
      "EXPECTED_GAIN_REJECTED",
      "FUNDED",
      "MARGINAL_ROI_REJECTED",
      "OTHER",
      "PARENT_BUDGET_REJECTED",
      "RECOMMEND_OVERRIDE",
      "SHADOW_OVERRIDE",
      "TARGET_REACHED",
      "UNSPECIFIED",
      "not_applicable",
    ];
    const atoms = Array.from(
      { length: MAX_AGGREGATE_ATOMS + 1 },
      (_, index) => ({
        ...atom,
        action_kind: actionKinds[index % actionKinds.length],
        reason_code: reasonCodes[Math.floor(index / actionKinds.length)],
      }),
    );
    const sink = new GitHubSink(
      "service-token",
      async () =>
        new Response(
          JSON.stringify({
            sha: "legacy",
            content: encoded({ ...envelope, atoms }),
          }),
          { status: 200 },
        ),
    );
    const matchingSubmission: CommonsEvidenceEnvelopeV1 = {
      ...envelope,
      atoms: [{ ...atom, action_kind: "command", reason_code: "APPROVED" }],
    };

    const plan = await sink.prepare(matchingSubmission);

    expect(JSON.parse(plan.content).atoms).toHaveLength(
      MAX_AGGREGATE_ATOMS + 1,
    );
    expect(JSON.parse(plan.content).atoms[0].count).toBe(4);
  });

  it("aborts while consuming a stalled GitHub response body", async () => {
    const sink = new GitHubSink(
      "service-token",
      async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
    );

    await expect(sink.prepare(envelope)).rejects.toThrow();
  }, 12_000);

  it("aborts each GitHub request before the Durable Object lock deadline", async () => {
    const sink = new GitHubSink(
      "service-token",
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const started = Date.now();
    await expect(sink.prepare(envelope)).rejects.toThrow(
      "GitHub request timed out",
    );
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBeLessThan(30_000);
  }, 15_000);
});
