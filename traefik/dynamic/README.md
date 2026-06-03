# Traefik Dynamic Configuration Directory

Files in this directory are loaded by the Traefik file provider (watched, hot-reloaded).

Use this directory for:
- Middleware definitions that are not tied to a single container label
- Any router/service config that cannot be expressed via Docker labels
- TLS options (if TLS is ever introduced — not used in this PoC)

Current contents:
- (empty — all routing is label-driven on compose services for this PoC)

Later workers (traefik-dex, authentik-iac) may add files here if needed.
