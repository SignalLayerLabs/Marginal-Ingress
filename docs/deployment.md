# Deployment

Set only a dedicated `GITHUB_TOKEN` Worker secret. Use a fine-grained GitHub service credential with write access limited to the contents of the fixed `SignalLayerLabs/Marginal-Commons` repository. Do not use a developer's personal token.

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
