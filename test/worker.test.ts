import { describe, expect, it } from "vitest";

import { createWorker, type CoordinatorClient } from "../src/index";

const validEnvelope = {
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
};

function workerWith(
  result: { accepted: true; duplicate: boolean } = {
    accepted: true,
    duplicate: false,
  },
) {
  const coordinator: CoordinatorClient = {
    submit: async () => result,
  };
  return createWorker(() => coordinator);
}

describe("Marginal Ingress worker", () => {
  it("serves a payload-free health response", async () => {
    const response = await workerWith().fetch(
      new Request("https://worker.invalid/healthz"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a non-JSON evidence request", async () => {
    const response = await workerWith().fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Idempotency-Key": "a".repeat(32),
        },
        body: JSON.stringify(validEnvelope),
      }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "invalid_request",
    });
  });

  it("rejects malformed, oversized, and recursively unknown evidence", async () => {
    const malformed = await workerWith().fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "a".repeat(32),
        },
        body: "{",
      }),
    );
    const oversized = await workerWith().fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "70000",
          "Idempotency-Key": "b".repeat(32),
        },
        body: JSON.stringify(validEnvelope),
      }),
    );
    const unknown = structuredClone(validEnvelope) as {
      atoms: Array<Record<string, unknown>>;
    };
    unknown.atoms[0]!.canary = "customer-acme";
    const unknownResponse = await workerWith().fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "c".repeat(32),
        },
        body: JSON.stringify(unknown),
      }),
    );

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(unknownResponse.status).toBe(400);
  });

  it("rejects an oversized streamed body without relying on Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024 + 1)));
        controller.close();
      },
    });
    const response = await workerWith().fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "g".repeat(32),
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "invalid_request",
    });
  });

  it("rejects an unsafe model and free-text field", async () => {
    const unsafe = structuredClone(validEnvelope) as {
      model_namespace: string;
      atoms: Array<Record<string, unknown>>;
    };
    unsafe.model_namespace = "openai/gpt-5.6-sol-private";
    unsafe.atoms[0]!.note = "customer-acme";
    const response = await workerWith().fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "d".repeat(32),
        },
        body: JSON.stringify(unsafe),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns only the acknowledgement and never echoes evidence", async () => {
    const canary = structuredClone(validEnvelope) as {
      atoms: Array<Record<string, unknown>>;
    };
    canary.atoms[0]!.reason_code = "APPROVED";
    const response = await workerWith().fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "e".repeat(32),
        },
        body: JSON.stringify(canary),
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"accepted":true,"duplicate":false}');
  });

  it("converts a coordinator failure to a generic sink failure", async () => {
    const worker = createWorker(() => ({
      submit: async () => Promise.reject(new Error("secret")),
    }));
    const response = await worker.fetch(
      new Request("https://worker.invalid/v1/evidence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "f".repeat(32),
        },
        body: JSON.stringify(validEnvelope),
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "sink_unavailable",
    });
  });
});
