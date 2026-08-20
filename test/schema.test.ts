import { describe, expect, it } from "vitest";

import { parseEvidenceEnvelope } from "../src/schema";

const atom = {
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
};

describe("strict evidence parser", () => {
  it("returns only the contract fields from a valid aggregate", () => {
    expect(
      parseEvidenceEnvelope({
        schema_version: "1.0",
        model_namespace: "openai/gpt-5.6-sol",
        atoms: [atom],
      }),
    ).toEqual({
      schema_version: "1.0",
      model_namespace: "openai/gpt-5.6-sol",
      atoms: [atom],
    });
  });

  it("rejects unknown fields at every contract level", () => {
    expect(() =>
      parseEvidenceEnvelope({
        schema_version: "1.0",
        model_namespace: "openai/gpt-5.6-sol",
        atoms: [{ ...atom, path: "/private" }],
      }),
    ).toThrow("invalid evidence envelope");
  });
});
