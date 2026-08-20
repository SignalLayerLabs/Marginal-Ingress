# Privacy model

SignalLayerLabs' application does not collect, persist, or associate source IP addresses with submitted evidence. The Worker source does not read Cloudflare `request.cf`, user-agent, referrer, cookies, or arbitrary request headers, and it emits no request-specific console output.

Cloudflare may process a source IP address at its network layer when delivering an HTTP request. That infrastructure behavior is outside the application data model; SignalLayerLabs' app does not collect, persist, or associate that address with evidence.

The only durable ingress state is a SHA-256 digest of the caller-supplied idempotency key, retained for 24 hours, together with a model aggregate path and intended Git blob SHA while a GitHub write is reconciled. Aggregate files contain only the closed contract dimensions and counts. They contain no raw envelope, contributor account, local identifier, repository name, URL, path, hash, or free text.
