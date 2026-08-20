# MARGINAL Ingress

MARGINAL Ingress is the optional public boundary for closed-schema, aggregate MARGINAL Commons evidence. It accepts only the versioned aggregate envelope in [`schemas/commons-evidence-envelope-v1.json`](schemas/commons-evidence-envelope-v1.json), serializes updates through one Durable Object, and writes aggregate counts to the fixed `SignalLayerLabs/Marginal-Commons` repository.

`GET /healthz` returns `{ "ok": true }`. `POST /v1/evidence` accepts `application/json` plus a 32–64-character base64url `Idempotency-Key` header. A successful submission returns only `{ "accepted": true, "duplicate": false }` (or `true` for a reconciled retry); the service never echoes submitted evidence.

This service has no contributor account, user ID, request log, or raw-envelope store. It retains only a SHA-256 digest of the idempotency key for 24 hours and, while reconciling a GitHub write, the target path and intended Git blob SHA.

See [deployment](docs/deployment.md), [architecture](docs/architecture.md), [privacy model](docs/privacy-model.md), and [threat model](docs/threat-model.md).

## Development

```sh
npm ci
npm run format
npm run lint
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

No production deployment is performed by this repository's test workflow.
