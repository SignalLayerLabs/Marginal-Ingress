# Security policy

Report suspected vulnerabilities privately to the SignalLayerLabs security contact rather than opening a public issue. Do not include real contributor evidence, credentials, or request payloads in reports; use synthetic fixtures.

The production GitHub credential must be a dedicated fine-grained bot personal access token (PAT), restricted to exactly one selected repository: `SignalLayerLabs/Marginal-Commons`. It must grant Contents read/write only, expire in 90 days or less, and have no administration, workflow, organization, or broad repository permissions. Never reuse a developer's current personal token, and do not use a classic or broadly scoped PAT.

Rotate the bot PAT on a fixed cadence of at most 90 days and immediately after suspected exposure. Before revoking the prior token, retain a dated screenshot/manual attestation showing exactly that selected repository and Contents read/write, install the replacement as `GITHUB_TOKEN`, and perform the reproducible authenticated Contents **read** in the deployment guide. GitHub has no non-mutating Contents-write permission probe; CI cannot prove secret scope. An authorized release owner must therefore approve that external attestation before the prior token is revoked. Then perform only the synthetic health/rejection verification. Do not send real evidence during credential verification.
