# Architecture

The edge Worker accepts only `GET /healthz` and `POST /v1/evidence`. It reads only the request content type, declared content length, and required idempotency key; it does not inspect `request.cf` or request-identifying headers. The Worker bounds the body, parses the closed contract, and forwards a sanitized reconstruction to one globally named Durable Object.

`EvidenceCoordinator` serializes normal-instance reconciliations with a short-lived in-memory queue, while durable state makes recovery safe after a restart. Its SQLite table holds a SHA-256 idempotency-key digest, expiry, `pending`/`completed` status, fixed aggregate target, and desired Git blob SHA. It never stores the evidence envelope. A successful write marks the digest completed for its full 24-hour TTL, so later model updates cannot turn a retry into another aggregate write. A crash-window pending entry is reconciled against the current blob and a bounded Git history lookup before it can be retried.

GitHub calls have a 10-second abort deadline. The Durable Object does not hold `blockConcurrencyWhile()` across network I/O; conditional blob writes and the bounded conflict retry preserve aggregate consistency while keeping the DO responsive. Its alarm wakes it at the earliest TTL expiry to purge idle idempotency state and schedule the next expiry.

The sink reads and writes only the fixed Commons repository and model aggregate path. Each Contents API write supplies the current blob SHA and a fixed service committer. It aggregates allowed atom counts; it does not publish a contributor identity or raw request envelope.
