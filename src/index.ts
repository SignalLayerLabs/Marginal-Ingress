import {
  EvidenceValidationError,
  parseEvidenceEnvelope,
  parseIdempotencyKey,
  type CommonsEvidenceEnvelopeV1,
} from "./schema";
import type { Env } from "./env";

export { EvidenceCoordinator } from "./coordinator";

const MAX_EVIDENCE_BYTES = 64 * 1024;

export type CoordinatorClient = {
  submit(
    evidence: CommonsEvidenceEnvelopeV1,
    idempotencyKey: string,
  ): Promise<{ accepted: true; duplicate: boolean }>;
};

export type WorkerApplication = {
  fetch(request: Request): Promise<Response>;
};

export function createWorker(
  coordinatorFor: () => CoordinatorClient,
): WorkerApplication {
  return {
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz")
        return response({ ok: true }, 200);
      if (request.method !== "POST" || url.pathname !== "/v1/evidence")
        return response({ accepted: false, error: "not_found" }, 404);

      try {
        if (!isJson(request.headers.get("Content-Type")))
          return response({ accepted: false, error: "invalid_request" }, 415);
        const declaredLength = request.headers.get("Content-Length");
        if (
          declaredLength !== null &&
          (!/^\d+$/.test(declaredLength) ||
            Number(declaredLength) > MAX_EVIDENCE_BYTES)
        ) {
          return response({ accepted: false, error: "invalid_request" }, 413);
        }
        const idempotencyKey = parseIdempotencyKey(
          request.headers.get("Idempotency-Key"),
        );
        const body = await readBoundedBody(request, MAX_EVIDENCE_BYTES);
        const evidence = parseEvidenceEnvelope(JSON.parse(body));
        try {
          const result = await coordinatorFor().submit(
            evidence,
            idempotencyKey,
          );
          return response(result, 202);
        } catch {
          return response({ accepted: false, error: "sink_unavailable" }, 502);
        }
      } catch (error) {
        if (error instanceof BodyTooLargeError)
          return response({ accepted: false, error: "invalid_request" }, 413);
        if (
          error instanceof SyntaxError ||
          error instanceof EvidenceValidationError
        ) {
          return response({ accepted: false, error: "invalid_request" }, 400);
        }
        return response({ accepted: false, error: "invalid_request" }, 400);
      }
    },
  };
}

const worker: ExportedHandler<Env> = {
  fetch: (request, env) =>
    createWorker(() => ({
      submit: async (evidence, idempotencyKey) => {
        const id = env.COORDINATOR.idFromName("global");
        const result = await env.COORDINATOR.get(id).fetch(
          new Request("https://coordinator.invalid/v1/evidence", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify(evidence),
          }),
        );
        if (!result.ok) throw new Error("coordinator failed");
        return (await result.json()) as { accepted: true; duplicate: boolean };
      },
    })).fetch(request),
};

export default worker;

class BodyTooLargeError extends Error {}

async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) throw new BodyTooLargeError();
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isJson(contentType: string | null): boolean {
  return (
    contentType !== null &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  );
}

function response(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
