import {
  handleIngress,
  type CoordinatorClient,
  type ParsedIngressRequest,
} from "./application";
import type { Env } from "./env";
import {
  EvidenceValidationError,
  parseEvidenceEnvelope,
  parseIdempotencyKey,
} from "./schema";

const MAX_EVIDENCE_BYTES = 64 * 1024;

export type WorkerApplication = {
  fetch(value: unknown): Promise<Response>;
};

// This is the sole incoming-request capability boundary. Its direct header
// reads are intentionally limited to the three contract headers below.
export async function parseIngressRequest(
  value: unknown,
): Promise<ParsedIngressRequest> {
  if (!(value instanceof Request)) return { kind: "invalid", status: 400 };
  const url = new URL(value.url);
  if (value.method === "GET" && url.pathname === "/healthz")
    return { kind: "health" };
  if (value.method !== "POST" || url.pathname !== "/v1/evidence")
    return { kind: "not_found" };
  try {
    if (!isJson(value.headers.get("Content-Type")))
      return { kind: "invalid", status: 415 };
    const declaredLength = value.headers.get("Content-Length");
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MAX_EVIDENCE_BYTES)
    ) {
      return { kind: "invalid", status: 413 };
    }
    const idempotencyKey = parseIdempotencyKey(
      value.headers.get("Idempotency-Key"),
    );
    const body = await readBoundedBody(value, MAX_EVIDENCE_BYTES);
    return {
      kind: "evidence",
      evidence: parseEvidenceEnvelope(JSON.parse(body)),
      idempotencyKey,
    };
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return { kind: "invalid", status: 413 };
    if (
      error instanceof SyntaxError ||
      error instanceof EvidenceValidationError
    )
      return { kind: "invalid", status: 400 };
    return { kind: "invalid", status: 400 };
  }
}

export function createWorker(
  coordinatorFor: () => CoordinatorClient,
): WorkerApplication {
  return {
    fetch: async (value) =>
      response(
        await handleIngress(await parseIngressRequest(value), coordinatorFor()),
      ),
  };
}

const worker: ExportedHandler<Env> = {
  fetch: (value, env) =>
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
        return (await result.json()) as {
          accepted: true;
          duplicate: boolean;
        };
      },
    })).fetch(value),
};

export default worker;

class BodyTooLargeError extends Error {}

async function readBoundedBody(
  value: Request,
  maximum: number,
): Promise<string> {
  const reader = value.body?.getReader();
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

function response(result: Awaited<ReturnType<typeof handleIngress>>): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}
