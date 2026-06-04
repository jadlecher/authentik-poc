# authentik Identity-Broker PoC

A local proof-of-concept demonstrating an identity-brokering flow:

```
Browser / SPA
  → Traefik (ingress, :8000)
    → authentik (OIDC broker, auth.localhost)
      → Dex (upstream IdP, idp.localhost)
    → Go API (JWT validation, app.localhost/api)
  → React SPA (app.localhost)
```

**HTTP only. Local development only. All secrets are intentionally public demo values.**

---

## URLs

All traffic enters through Traefik on port **8000**. No other service publishes a host port.

| URL                                        | Destination        | Notes                              |
|--------------------------------------------|--------------------|------------------------------------|
| `http://app.localhost:8000/`               | React SPA          | Vite + React + TypeScript          |
| `http://app.localhost:8000/api/...`        | Go API             | Same-origin as SPA (no CORS)       |
| `http://auth.localhost:8000/`              | authentik          | OIDC broker + UI                   |
| `http://idp.localhost:8000/`               | Dex                | Upstream IdP (static password DB)  |
| `http://traefik.localhost:8000/dashboard/` | Traefik dashboard  | **Local-only.** Do not expose.     |

---

## Demo users (Dex static passwords)

| Username | Email               | Password   | Role in authentik |
|----------|---------------------|------------|-------------------|
| alice    | alice@example.com   | `password` | admins            |
| bob      | bob@example.com     | `password` | users             |

Roles (`admins` / `users`) are **derived in authentik** from the email claim brokered from
Dex. Dex itself does not emit groups.

Break-glass admin: `akadmin` / `akadmin-local-demo-password` — for debugging only.

---

## How to run

### Prerequisites

- Docker ≥ 24 with Compose v2
- [go-task](https://taskfile.dev/installation/) (`task`)
- `/etc/hosts` entries (or use a wildcard DNS resolver such as `dnsmasq`):
  ```
  127.0.0.1  app.localhost auth.localhost idp.localhost traefik.localhost
  ```
  > Most systems resolve `*.localhost` to `127.0.0.1` natively; if not, add the lines above.

### Start

```bash
cp .env.example .env   # first time only
task dev               # brings up full stack (TODO: fully implemented in Phase 3)
```

### Stop / clean

```bash
task dev:clean         # docker compose down -v --remove-orphans
```

### Other tasks

```bash
task logs              # tail all service logs
task validate          # run infra + API + E2E checks (Phase 4)
task test              # unit/integration tests (Phase 4)
task test:e2e          # Playwright browser tests (Phase 4)
```

---

## Dex (upstream enterprise IdP stub)

Dex acts as a stand-in for an enterprise OIDC IdP (e.g. Okta, Azure AD). authentik federates
with it via an OAuth Source, brokering identities to the SPA/API.

| Property         | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Issuer           | `http://idp.localhost:8000/dex`                                        |
| Discovery URL    | `http://idp.localhost:8000/dex/.well-known/openid-configuration`       |
| Storage          | SQLite3 (`/var/dex/dex.db` in named volume); survives restart, wiped on `down -v` |
| Approval screen  | Disabled (`skipApprovalScreen: true`) — smooth PoC UX                 |

### Demo users (LOCAL/DEMO ONLY — passwords are intentionally public)

| Username | Email               | Password   | authentik role |
|----------|---------------------|------------|----------------|
| alice    | alice@example.com   | `password` | admins         |
| bob      | bob@example.com     | `password` | users          |

Passwords are stored as bcrypt hashes (rounds=10) in `dex/config.yml`.
Roles (`admins`/`users`) are derived **in authentik** from the email claim; Dex does not emit groups.

### authentik OIDC client (LOCAL/DEMO ONLY)

| Property        | Value                                                      |
|-----------------|------------------------------------------------------------|
| `client_id`     | `authentik`                                                |
| `client_secret` | `authentik-dex-secret-LOCAL-DEMO-ONLY` (see `.env`)       |
| `redirect_uri`  | `http://auth.localhost:8000/source/oauth/callback/dex/`    |

The secret is passed via the `DEX_CLIENT_SECRET` environment variable (defined in `.env`);
Dex config expands `$DEX_CLIENT_SECRET` at runtime. This avoids committing the secret directly
in `dex/config.yml` — though the value is still public for this PoC.

---

## Pinned image versions

| Image                              | Version      | Notes                        |
|------------------------------------|--------------|------------------------------|
| `traefik`                          | `v3.7.1`     | Traefik v3 stable; pinned    |
| `ghcr.io/dexidp/dex`               | `v2.45.1`    | Dex stable; pinned Phase 1a  |
| `ghcr.io/goauthentik/server`       | `2026.5.2`   | authentik stable; pinned Phase 1b |
| `docker.io/library/postgres`       | `18-alpine`  | PostgreSQL 18; volume mounted at `/var/lib/postgresql`; clean PoC volume required after major upgrade |
| `golang` (build stage)             | `1.26-alpine` | Go 1.26 Alpine; Go API builder Phase 2a |
| `alpine` (runtime stage)           | `3.23`       | Minimal runtime; Go API Phase 2a |
| `node` (build stage)               | `24-alpine`  | Node 24 LTS Alpine; SPA builder Phase 2b |
| `nginx` (runtime stage)            | `1.30-alpine` | NGINX stable Alpine; SPA runtime Phase 2b |

---

## authentik (OIDC broker)

### Image and version

| Component         | Image                                | Version    |
|-------------------|--------------------------------------|------------|
| Server + Worker   | `ghcr.io/goauthentik/server`         | `2026.5.2` |
| Database          | `docker.io/library/postgres`         | `18-alpine` |

Redis is no longer part of this PoC's authentik deployment. The service was removed to align
with authentik 2026.5's current Docker Compose shape.

### OIDC URLs (all on `:8000`)

| Endpoint             | URL                                                                    |
|----------------------|------------------------------------------------------------------------|
| Discovery            | `http://auth.localhost:8000/application/o/app/.well-known/openid-configuration` |
| Authorization        | `http://auth.localhost:8000/application/o/authorize/`                  |
| Token                | `http://auth.localhost:8000/application/o/token/`                      |
| JWKS                 | `http://auth.localhost:8000/application/o/app/jwks/`                   |
| Issuer (exact)       | `http://auth.localhost:8000/application/o/app/`                        |

**Issuer is byte-exact**: `http://auth.localhost:8000/application/o/app/` — the Go API must validate this exactly.

### Blueprint files (`authentik/blueprints/`)

| File                      | What it declares                                                    |
|---------------------------|---------------------------------------------------------------------|
| `10-scope-mappings.yaml`  | Two custom scope mappings: `groups` (email→role) and `api` (injects `poc-api` audience) |
| `20-provider.yaml`        | OAuth2Provider `app-provider`: public PKCE client `spa-client`, RS256 JWT, per-provider issuer |
| `30-sources.yaml`         | OAuth Source `dex`: OpenID Connect, consumer_key `authentik`, well-known URL points to Dex |

All blueprints are applied automatically on cold start by the `authentik-worker` container.

### Break-glass admin

| Field    | Value                        |
|----------|------------------------------|
| Username | `akadmin`                    |
| Password | `akadmin-local-demo-password` (from `.env`) |
| Email    | `akadmin@localhost`           |

**Not for normal use.** Normal users come from Dex via the OAuth source.
Bootstrap token: `local-demo-bootstrap-token-0123456789` (scripted API access only).

### GATE 3 — Internal hostname resolution

The `authentik-server` and `authentik-worker` containers need to resolve `auth.localhost`,
`idp.localhost`, and `app.localhost` to the Traefik container (not `127.0.0.1`).

**Problem**: glibc inside the container resolves `*.localhost` to `127.0.0.1` by default
(bypasses Docker DNS). This would break the Dex OIDC source (authentik needs to fetch
`http://idp.localhost:8000/dex/.well-known/openid-configuration` from inside the container).

**Fix**: `extra_hosts: host-gateway` in compose maps all three hostnames to the host's
gateway IP (which routes back through Traefik). This is overridden by the container's
`/etc/hosts` file, forcing DNS resolution to the correct IP.

Verified: both `http://auth.localhost:8000/...` and `http://idp.localhost:8000/...` resolve
and return correct responses from inside the `authentik-server` container.

### GATE 2 — Single-port invariant

**Problem**: authentik's Go proxy (port 9000) strips the port from the `Host` header
before forwarding to gunicorn/Python. Django's `build_absolute_uri()` reads `HTTP_HOST`
and returns `http://auth.localhost/...` (without `:8000`).

**Fix**: Two-part:
1. Traefik `authentik-headers@file` middleware injects `X-Forwarded-Host: auth.localhost:8000`
2. Mounted `authentik/settings/custom_settings.py` sets `USE_X_FORWARDED_HOST = True`
   (Django then uses `X-Forwarded-Host` for URL building instead of `Host`)

Result: issuer = `http://auth.localhost:8000/application/o/app/` ✓

---

## Architecture notes

### Single-port invariant (CONTRACT §0)

Traefik's `web` entrypoint is `8000:8000` (NOT `80→8000`). This ensures the authority
string `host.localhost:8000` is **byte-for-byte identical** from the browser and from
inside the Docker network. JWT `iss` and JWKS URLs work on both sides without
translation.

### Routing

- All routing is label-driven on each compose service.
- The `traefik/dynamic/` directory is the file-provider drop zone for anything
  label-less. Currently empty; later workers may add middleware there.
- Traefik carries network aliases `app.localhost`, `auth.localhost`, `idp.localhost`,
  `traefik.localhost` on the `poc` bridge so intra-container calls use the same URLs.

### IaC — no manual UI configuration

authentik is fully configured via **blueprints** mounted at `/blueprints/custom/` and
auto-applied on cold start. See `authentik/blueprints/` (populated by Phase 1b worker).

### API

- Module path: `github.com/poc/authentik-poc/api`
- OpenAPI spec: `api/openapi/openapi.yaml` (canonical; SPA client generated from it)
- Generator: `ogen` v1.20.3 (spec-first, type-safe handlers, built-in validation, SecurityHandler interface)
  - **Why ogen:** spec-first approach generates typed server interfaces and a `SecurityHandler` interface for auth; built-in request validation against the OpenAPI schema; no reflection in the hot path; the generated `SecurityHandler` makes it trivial to plug in fail-closed JWT validation at the framework level.
- Generated code: `api/internal/oapi/` (regenerated by `task api:generate`; git-ignored)
- JWT validation: `github.com/coreos/go-oidc/v3` v3.18.0
  - **Why go-oidc/v3:** handles OIDC discovery + JWKS caching + RS256 verification in one library; RemoteKeySet auto-refreshes on unknown kid; actively maintained by CoreOS/Red Hat.
- In-memory todo store (non-persistent by design; todos lost on restart)
- CORS: None (SPA and API share origin `app.localhost:8000`)
- `/healthz` endpoint (unauthenticated): returns 200 for healthchecks (Traefik v3 Docker provider requires healthy status to route)

### Traefik router naming note (for spa worker)

The api router is named `poc-api` (labels: `traefik.http.routers.poc-api.*`) to avoid
conflicting with Traefik's internal `api@internal` service. The api router uses priority 10.
The spa worker **MUST** set a lower priority (e.g. `traefik.http.routers.spa.priority: "1"`)
on its `Host(app.localhost)` router so `/api/*` traffic always hits the Go API first.

### SPA

- Vite + React + TypeScript
- OIDC: `react-oidc-context` + `oidc-client-ts`, Authorization Code + PKCE, public client
- API client generated from `api/openapi/openapi.yaml` via `openapi-typescript`
- Container internal port: `80` (nginx static)

---

## Repository layout

```
.
├── CONTRACT.md              # Interface contract — authoritative source of truth
├── docker-compose.yml       # Compose file (Traefik now; others added per phase)
├── traefik/
│   ├── traefik.yml          # Static Traefik config
│   └── dynamic/             # File-provider dynamic config (drop zone)
├── dex/                     # Dex IdP config (Phase 1a)
├── authentik/
│   └── blueprints/          # authentik blueprint YAML files (Phase 1b)
├── api/                     # Go API (Phase 2a)
│   └── openapi/openapi.yaml # Canonical OpenAPI 3 spec (shared with SPA)
├── spa/                     # React SPA (Phase 2b)
├── tests/                   # Playwright E2E tests (Phase 4)
├── docs/                    # Additional documentation
├── Taskfile.yml             # go-task v3 task runner
├── .env.example             # Template env vars (tracked)
└── .env                     # Live env vars (git-ignored, copy of .env.example)
```
