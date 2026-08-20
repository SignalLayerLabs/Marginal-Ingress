import { describe, expect, it } from "vitest";

import {
  GITHUB_COMMITTER,
  GITHUB_REPOSITORY,
  GitHubSink,
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
});
