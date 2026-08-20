export const MODEL_NAMESPACES = [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
] as const;

const recordTypes = ["decision", "outcome"] as const;
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
  "other",
] as const;
const buckets = ["low", "medium", "high", "unknown"] as const;
const decisions = ["allow", "deny", "unknown", "not_applicable"] as const;
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
] as const;
const outcomeClasses = [
  "verified_success",
  "verified_failure",
  "positive_reward",
  "non_positive_reward",
  "unknown",
  "not_applicable",
] as const;

type RecordType = (typeof recordTypes)[number];
type ActionKind = (typeof actionKinds)[number];
type Bucket = (typeof buckets)[number];
type Decision = (typeof decisions)[number];
type ReasonCode = (typeof reasonCodes)[number];
type OutcomeClass = (typeof outcomeClasses)[number];

export type CommonsEvidenceAtomV1 = Readonly<{
  record_type: RecordType;
  action_kind: ActionKind;
  cost_bucket: Bucket;
  gain_bucket: Bucket;
  recommendation: Decision;
  applied_decision: Decision;
  reason_code: ReasonCode;
  outcome_class: OutcomeClass;
  count: number;
  minimum_group_size: number;
}>;

export type CommonsEvidenceEnvelopeV1 = Readonly<{
  schema_version: "1.0";
  model_namespace: (typeof MODEL_NAMESPACES)[number];
  atoms: readonly CommonsEvidenceAtomV1[];
}>;

export class EvidenceValidationError extends Error {
  public constructor() {
    super("invalid evidence envelope");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseAtom(value: unknown): CommonsEvidenceAtomV1 {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "record_type",
      "action_kind",
      "cost_bucket",
      "gain_bucket",
      "recommendation",
      "applied_decision",
      "reason_code",
      "outcome_class",
      "count",
      "minimum_group_size",
    ]) ||
    !oneOf(value.record_type, recordTypes) ||
    !oneOf(value.action_kind, actionKinds) ||
    !oneOf(value.cost_bucket, buckets) ||
    !oneOf(value.gain_bucket, buckets) ||
    !oneOf(value.recommendation, decisions) ||
    !oneOf(value.applied_decision, decisions) ||
    !oneOf(value.reason_code, reasonCodes) ||
    !oneOf(value.outcome_class, outcomeClasses) ||
    !isBoundedInteger(value.count) ||
    !isBoundedInteger(value.minimum_group_size)
  ) {
    throw new EvidenceValidationError();
  }

  return {
    record_type: value.record_type,
    action_kind: value.action_kind,
    cost_bucket: value.cost_bucket,
    gain_bucket: value.gain_bucket,
    recommendation: value.recommendation,
    applied_decision: value.applied_decision,
    reason_code: value.reason_code,
    outcome_class: value.outcome_class,
    count: value.count,
    minimum_group_size: value.minimum_group_size,
  };
}

function isBoundedInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 1000
  );
}

export function parseEvidenceEnvelope(
  value: unknown,
): CommonsEvidenceEnvelopeV1 {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["schema_version", "model_namespace", "atoms"]) ||
    value.schema_version !== "1.0" ||
    !oneOf(value.model_namespace, MODEL_NAMESPACES) ||
    !Array.isArray(value.atoms) ||
    value.atoms.length === 0
  ) {
    throw new EvidenceValidationError();
  }

  return {
    schema_version: "1.0",
    model_namespace: value.model_namespace,
    atoms: value.atoms.map(parseAtom),
  };
}

export function parseIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9_-]{32,64}$/.test(value)) {
    throw new EvidenceValidationError();
  }
  return value;
}
