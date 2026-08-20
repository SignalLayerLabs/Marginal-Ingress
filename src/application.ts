import type { CommonsEvidenceEnvelopeV1 } from "./schema";

export type CoordinatorClient = {
  submit(
    evidence: CommonsEvidenceEnvelopeV1,
    idempotencyKey: string,
  ): Promise<{ accepted: true; duplicate: boolean }>;
};

export type ParsedIngressRequest =
  | Readonly<{ kind: "health" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid"; status: 400 | 413 | 415 }>
  | Readonly<{
      kind: "evidence";
      evidence: CommonsEvidenceEnvelopeV1;
      idempotencyKey: string;
    }>;

export type ApplicationResult = Readonly<{ status: number; body: unknown }>;

export async function handleIngress(
  input: ParsedIngressRequest,
  coordinator: CoordinatorClient,
): Promise<ApplicationResult> {
  if (input.kind === "health") return { status: 200, body: { ok: true } };
  if (input.kind === "not_found")
    return { status: 404, body: { accepted: false, error: "not_found" } };
  if (input.kind === "invalid")
    return {
      status: input.status,
      body: { accepted: false, error: "invalid_request" },
    };
  try {
    return {
      status: 202,
      body: await coordinator.submit(input.evidence, input.idempotencyKey),
    };
  } catch {
    return {
      status: 502,
      body: { accepted: false, error: "sink_unavailable" },
    };
  }
}
