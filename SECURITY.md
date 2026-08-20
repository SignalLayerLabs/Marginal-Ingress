# Security policy

Report suspected vulnerabilities privately to the SignalLayerLabs security contact rather than opening a public issue. Do not include real contributor evidence, credentials, or request payloads in reports; use synthetic fixtures.

The production GitHub credential must be a dedicated fine-grained bot personal access token (PAT), restricted to the contents of `SignalLayerLabs/Marginal-Commons`. It must have no administration, workflow, organization, or broad repository permissions. Never reuse a developer's current personal token, and do not use a classic or broadly scoped PAT.

Rotate the bot PAT every 90 days and immediately after suspected exposure. Before revoking the prior token, install the replacement as `GITHUB_TOKEN`, authenticate it with a GitHub Contents **read** against the fixed Commons repository, and verify that its repository-scoped permissions are sufficient. Then perform only the synthetic health/rejection verification and revoke the predecessor. Do not send real evidence during credential verification.
