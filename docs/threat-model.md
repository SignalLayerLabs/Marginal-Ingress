# Threat model

The ingress boundary assumes callers and network clients may be malicious. Recursive closed-schema parsing rejects unknown fields, unsafe model names, free text, oversized bodies, malformed JSON, and invalid idempotency keys. Responses are fixed acknowledgements or generic errors and do not reflect evidence.

The service reduces duplicate and crash-window risk with a 24-hour idempotency-key digest and a pending target/blob reconciliation descriptor. GitHub Contents updates use the current blob SHA and at most one conflict retry. This is not a distributed transaction: an unavailable GitHub API returns a generic failure for a later client retry.

The GitHub sink is constrained to one repository, deterministic model paths, and a fixed committer. A dedicated least-privilege credential limits the impact of credential compromise. Aggregate Commons data is informational only; it cannot grant MARGINAL enforcement authority.
