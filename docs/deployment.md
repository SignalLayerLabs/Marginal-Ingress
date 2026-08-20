# Deployment

Set only a dedicated `GITHUB_TOKEN` Worker secret. Use a dedicated fine-grained GitHub bot PAT that selects exactly `SignalLayerLabs/Marginal-Commons`, grants Contents read/write only, and expires in 90 days or less. Never reuse a developer's current personal token; classic or broadly scoped PATs are not acceptable.

Rotate the bot PAT on a fixed cadence of at most 90 days and immediately after suspected exposure. Before revoking its predecessor, capture a dated screenshot/manual attestation of the fine-grained-token screen showing exactly one selected repository and Contents read/write, then install the replacement secret and perform this authenticated fixed-repository read:

```sh
gh api repos/SignalLayerLabs/Marginal-Commons/contents/models/openai/gpt-5.6-sol/aggregates.json \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

This proves the replacement can read the fixed repository without mutating production. GitHub provides no non-mutating Contents-write permission check; CI also cannot inspect a deployed secret's scope. An authorized release owner must review the screenshot/attestation and read result as the explicit external approval before revoking the old token. The synthetic ingress rejection below is a non-mutating aggregate dry-run; it does not prove GitHub write scope. Keep the bot token separate from personal development credentials.

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
