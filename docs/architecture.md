# Architecture

The edge Worker accepts only `GET /healthz` and `POST /v1/evidence`. It reads only the request content type, declared content length, and required idempotency key; it does not inspect `request.cf` or request-identifying headers. The Worker bounds the body, parses the closed contract, and forwards a sanitized reconstruction to one globally named Durable Object.

`EvidenceCoordinator` serializes aggregate updates. Its SQLite table holds a SHA-256 idempotency-key digest, expiry, fixed aggregate target, and desired Git blob SHA. It never stores the evidence envelope. Before treating a retry as a duplicate, it reads the GitHub target and matches that desired blob SHA. If a write conflict occurs, it rereads, re-aggregates, replaces the pending descriptor, and retries once.

The sink reads and writes only the fixed Commons repository and model aggregate path. Each Contents API write supplies the current blob SHA and a fixed service committer. It aggregates allowed atom counts; it does not publish a contributor identity or raw request envelope.
