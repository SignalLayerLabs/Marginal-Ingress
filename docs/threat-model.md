# Threat model

The ingress boundary assumes callers and network clients may be malicious. Recursive closed-schema parsing rejects unknown fields, unsafe model names, free text, oversized bodies, malformed JSON, and invalid idempotency keys. Responses are fixed acknowledgements or generic errors and do not reflect evidence.

The service reduces duplicate and crash-window risk with a 24-hour idempotency-key digest, `pending`/`completed` state, and a target/blob reconciliation descriptor. An idle-expiry alarm removes records even without another request. GitHub Contents updates use the current blob SHA and at most one conflict retry; every GitHub request aborts after 10 seconds. This is not a distributed transaction: an unavailable or inconclusive reconciliation returns a generic failure for a later client retry rather than risking a second aggregate write.

The GitHub sink is constrained to one repository, deterministic model paths, and a fixed committer. A dedicated least-privilege credential limits the impact of credential compromise. Aggregate Commons data is informational only; it cannot grant MARGINAL enforcement authority.
