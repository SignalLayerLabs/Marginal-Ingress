import { describe, expect, it } from "vitest";

import {
  GITHUB_COMMITTER,
  GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_REPOSITORY,
  GitHubSink,
  type PendingDescriptor,
} from "../src/github-sink";

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
    const commits = Array.from({ length: 16 }, (_, index) => ({
      sha: `commit-${index}`,
    }));
    const sink = new GitHubSink("service-token", async (input) => {
      const url = String(input);
      if (url.includes("/commits?"))
        return new Response(JSON.stringify(commits));
      if (url.includes("ref=commit-15")) {
        return new Response(JSON.stringify({ sha: pending.blobSha }));
      }
      return new Response(JSON.stringify({ sha: "b".repeat(40) }));
    });

    await expect(sink.isApplied(pending)).resolves.toBe(true);
  });

  it("follows a bounded next page before concluding a pending blob is absent", async () => {
    const pending: PendingDescriptor = {
      target: "models/openai/gpt-5.6-sol/aggregates.json",
      blobSha: "a".repeat(40),
    };
    const commits = Array.from({ length: 16 }, (_, index) => ({
      sha: `commit-${index}`,
    }));
    let historyRequests = 0;
    const sink = new GitHubSink("service-token", async (input) => {
      const url = String(input);
      if (url.includes("page=2")) {
        historyRequests += 1;
        return new Response(JSON.stringify([]));
      }
      if (url.includes("/commits?")) {
        historyRequests += 1;
        return new Response(JSON.stringify(commits), {
          headers: {
            Link: '<https://api.github.com/repos/SignalLayerLabs/Marginal-Commons/commits?path=models%2Fopenai%2Fgpt-5.6-sol%2Faggregates.json&per_page=16&page=2>; rel="next"',
          },
        });
      }
      return new Response(JSON.stringify({ sha: "b".repeat(40) }));
    });

    await expect(sink.isApplied(pending)).resolves.toBe(false);
    expect(historyRequests).toBe(2);
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
