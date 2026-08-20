# Deployment

Set only a dedicated `GITHUB_TOKEN` Worker secret. Use a dedicated fine-grained GitHub bot PAT with write access limited to the contents of the fixed `SignalLayerLabs/Marginal-Commons` repository. Never reuse a developer's current personal token; classic or broadly scoped PATs are not acceptable.

Rotate the bot PAT every 90 days and immediately after suspected exposure: install a replacement secret, authenticate it with a GitHub Contents **read** against `SignalLayerLabs/Marginal-Commons`, and verify its repository-scoped permission before revoking the predecessor. Then run only the synthetic checks below. Keep the token separate from personal development credentials.

Before a deployment, verify the intended Cloudflare account, configure the dedicated secret, run `npm ci`, and run:

```sh
npx wrangler deploy --dry-run
```

Then deploy only from an authorized release workflow and verify `/healthz` plus a synthetic closed-schema rejection request. Do not send real evidence as a probe:

```sh
curl --fail-with-body -X POST "$INGRESS_URL/v1/evidence" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(printf 'a%.0s' {1..32})" \
  --data '{"schema_version":"1.0","model_namespace":"unsafe/model","atoms":[]}'
```

The response must be a generic `400` rejection and must not echo the supplied body. Production deployment remains blocked until Wrangler authentication and the dedicated GitHub service credential are both independently verified.
