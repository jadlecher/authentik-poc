# authentik Identity-Broker PoC — Final Report

> Status: **COMPLETE.** `task dev:clean && task dev && task validate` succeeds from a
> clean state. Browser-level E2E proves the full brokered login; API neg/pos and infra
> checks pass. Zero manual authentik UI edits; all identity config is declarative
> (authentik blueprints + Dex config). No runtime seeding in the test path.

## 1. Summary

A Docker-Compose proof-of-concept demonstrating a production-shaped auth architecture:

- A **React SPA** (public client) logs in via **OIDC Authorization Code + PKCE** against
  **authentik**.
- **authentik** acts as an identity **broker**, delegating the actual login to **Dex**
  (a stub upstream enterprise IdP) over Authorization Code with a **confidential** client.
- A **Go REST API** validates authentik-issued **JWT access tokens** directly (issuer,
  audience, RS256 signature via JWKS, expiry), fails closed, and serves user-scoped todos.
- **Traefik** is the sole ingress; every service is reached by hostname on `:8000` only.

The whole system rebuilds from a clean teardown with **no UI clicks** — authentik is
configured entirely via mounted blueprints.

## 2. Task decomposition (orchestrator + Sonnet workers)

| Phase | Worker | Outcome |
|------|--------|---------|
| Contract | orchestrator | `CONTRACT.md` single source of truth |
| 0 scaffold | scaffold | compose skeleton, Traefik on `:8000`, network aliases |
| 1a Dex | traefik-dex | Dex IdP, 2 users, confidential client for authentik |
| 1b authentik | authentik-iac | server/worker/pg/redis + blueprints (source, provider, mappings, app) |
| 2a Go API | go-api | ogen + go-oidc, fail-closed JWT middleware, 22 unit tests |
| 2b SPA | react-spa | Vite+React+TS, react-oidc-context PKCE, openapi-typescript client |
| 3 workflow | taskfile | `dev`/`dev:clean`/`validate`/`test`/`test:e2e` + health-wait/validate scripts |
| 4 validation | validation + fixes | Playwright E2E + API neg/pos; **found & fixed** two real bugs |
| 5 sign-off | orchestrator | root-caused the bugs into blueprint/config, removed test seeding, final cold-start run |

**Two real defects were caught at integration and fixed at the source (not papered over):**

1. **Dex source not bound to the login stage.** The blueprint created the Dex OAuth
   source but never added it to `default-authentication-identification.sources`, so no
   "Login with Dex" button rendered. Fixed declaratively in `30-sources.yaml` (plus a
   non-interactive `poc-source-enrollment` flow so first-login enrollment needs no form).
2. **Dex client-secret mismatch.** Dex v2.41.1 does **not** expand `$DEX_CLIENT_SECRET`
   in its config — it took the literal string, so the authentik↔Dex token exchange failed
   with `invalid_client`. Fixed by inlining the CONTRACT §3 secret in `dex/config.yml`.

A test-side band-aid (runtime `PUT`/`PATCH` of authentik via the admin API from
`global-setup`) was **rejected and removed** — it would have hidden these bugs and broken
the "blueprint-only, survives cold start" guarantee. The test harness now seeds nothing.

## 3. Repository structure

```
authentik-poc/
├── CONTRACT.md                  # authoritative interface contract
├── docker-compose.yml           # all services; only traefik publishes :8000
├── Taskfile.yml                 # dev / dev:clean / validate / test / test:e2e
├── .env(.example)               # LOCAL/DEMO secrets (committed by design)
├── scripts/                     # wait-healthy.sh, validate.sh (infra checks)
├── traefik/                     # static + dynamic (X-Forwarded-Host for authentik)
├── dex/config.yml               # Dex IdP: 2 users, confidential client (secret inlined)
├── authentik/
│   ├── blueprints/              # 10-scope-mappings, 20-provider, 30-sources (IaC)
│   └── settings/                # USE_X_FORWARDED_HOST custom Django settings
├── api/                         # Go API: ogen spec-first + go-oidc; oapi gen'd
│   └── openapi/openapi.yaml     # single shared spec (API server + SPA client)
├── spa/                         # Vite+React+TS; nginx static; openapi-typescript client
├── tests/                       # Playwright: login-helpers, e2e-login, api-auth, api-negative
└── docs/FINAL_REPORT.md         # this file
```

## 4. Commands

| Command | Effect |
|--------|--------|
| `task dev` | codegen → build → up → wait-for-health → print URLs/creds (idempotent) |
| `task dev:clean` | `docker compose down -v --remove-orphans` (idempotent) |
| `task validate` | infra/port/routing checks + Go tests + Playwright E2E (neg/pos + browser) |
| `task test` | regenerate ogen code, then `go test ./...` |
| `task test:e2e` | install deps + run Playwright suite |
| `task logs` | follow all service logs |

## 5. Hostnames & routes (all on `:8000`)

| URL | Service | Notes |
|-----|---------|-------|
| `http://app.localhost:8000/` | spa | React SPA (nginx static) |
| `http://app.localhost:8000/api/...` | api | Go API, same-origin (no CORS); router priority 10 |
| `http://auth.localhost:8000/` | authentik-server | UI + OIDC endpoints |
| `http://idp.localhost:8000/` | dex | upstream IdP under `/dex` |
| `http://traefik.localhost:8000/` | dashboard | local-only |

Single-port invariant: Traefik's `web` entrypoint listens on container `8000`, published
`8000:8000` (no 80→8000 remap), so `host.localhost:8000` is byte-identical inside the
Docker network and in the browser — issuer/JWKS URLs match on both sides.

## 6. Demo users (Dex static, LOCAL/DEMO)

| email | password | groups | is_admin |
|-------|----------|--------|----------|
| alice@example.com | `password` | `["admins"]` | true |
| bob@example.com | `password` | `["users"]` | false |

Break-glass authentik admin `akadmin@localhost` / `akadmin-local-demo-password` exists for
debugging only; normal users come exclusively from Dex.

## 7. OIDC flow (end to end)

1. SPA `signinRedirect` → authentik authorize (`/application/o/authorize/`), AuthCode+PKCE,
   `client_id=spa-client`, **no secret**.
2. authentik identification stage shows the **Dex** source button → redirects to Dex
   (`/source/oauth/login/dex/`).
3. Dex authenticates alice (static password DB) and redirects back to authentik's
   source callback (`/source/oauth/callback/dex/`) — confidential client `authentik`.
4. authentik runs the brokered source flow: first login enrolls the user non-interactively
   (username auto-filled from the Dex claim), links by email, issues an authentik session.
5. authentik redirects back to the SPA `/callback` with an authorization code.
6. oidc-client-ts exchanges the code (PKCE) for **id_token + access_token** and lands on `/`.
7. SPA calls `GET /api/me`, `GET/POST /api/todos` with the **access token** as
   `Authorization: Bearer`. The API validates and returns user-scoped data
   (email `alice@example.com`, groups `admins`, `is_admin: true`).

## 8. Per-leg client-secret rationale

| Leg | Client type | Secret? | Why |
|-----|-------------|---------|-----|
| SPA → authentik | **public** (PKCE) | **No** | Browser code can't keep a secret; PKCE binds the code to the client without one. |
| authentik → Dex | **confidential** | **Yes** (`authentik-dex-secret-LOCAL-DEMO-ONLY`) | authentik is a server-side broker and can hold a secret; Dex authenticates it on the token exchange. |
| API ← authentik | n/a (resource server) | **No** | The API never calls authentik with a secret; it only verifies JWTs against the public JWKS. |

## 9. JWT validation (Go API, fail-closed)

For every protected request the middleware checks the `Authorization: Bearer` JWT:

- **Signature** via JWKS fetched from discovery (cached; refreshed on unknown `kid`).
- **`iss`** exact match `http://auth.localhost:8000/application/o/app/`.
- **`aud`** contains `poc-api` (membership; the token may also carry `spa-client`).
- **`exp` / `nbf` / `iat`** validity.
- Missing / malformed / expired / wrong-iss / wrong-aud → **401** with a generic JSON
  error; the token is **never** echoed or logged.
- **`X-authentik-*` proxy identity headers are never trusted** as authentication — a
  request with those headers and no Bearer is rejected 401 (tested).

## 10. IaC approach

- **authentik:** mounted blueprints under `/blueprints/custom`, auto-applied by the worker
  on boot — OAuth source (Dex), OIDC provider (`app-provider`, JWT/RS256, audience
  `poc-api`), scope/property mappings (`email`, `groups` from email expression, `aud`),
  application `app`, identification-stage source binding, and a non-interactive source
  enrollment flow. Idempotent; survives `dev:clean`.
- **Dex:** declarative `config.yml` (issuer, static client, static users).
- **Everything else:** `docker-compose.yml` + Traefik labels/dynamic files. No imperative
  setup, no UI edits, no runtime API mutation.

## 11. Validation evidence (final cold-start run)

`task dev:clean && task dev && task validate` from scratch:

- **Infra (scripts/validate.sh):** 6/6 PASS — only traefik publishes host ports;
  `app.localhost`→200; `auth.localhost`→302; Dex discovery reachable; authentik discovery
  reachable; `GET /api/me` no token →401.
- **Go API:** `go test ./...` ok (auth + handler packages; 22 cases).
- **Playwright: 17 passed, 0 flaky.**
  - Browser E2E: SPA → authentik → **Dex login as alice** → enrollment/consent → SPA
    callback → authenticated; asserts email `alice@example.com`, groups `admins`,
    `GET /api/me` `is_admin: true`, creates a todo. Screenshot saved to
    `tests/test-results/authenticated-state.png`.
  - API negative (through Traefik): no token, malformed, expired, wrong-iss, wrong-aud,
    spoofed `X-authentik-*` only → all **401**.
  - API positive: a real captured access token → **200** with alice's scoped data.

## 12. Known limitations

- **HTTP only** (no TLS) — a documented local shortcut; OIDC over `http://*.localhost`.
- **In-memory todo store** — not persisted across API restarts.
- **Single browser project** (chromium) in Playwright.
- **Demo secrets committed** intentionally for reproducibility; clearly marked LOCAL/DEMO.
- **Dex `skipApprovalScreen: true`** for smooth UX; a production upstream would show consent.
- **Pinned images** (`traefik:v3.3.5`, `dex:v2.41.1`, `goauthentik/server:2024.12.3`,
  `postgres:16-alpine`, `redis:7-alpine`) — bump deliberately.

## 13. Production hardening (what changes for real)

- **TLS everywhere** (Traefik ACME / real certs); secure + `SameSite` cookies; HSTS.
- **Secrets** from a manager (not committed `.env`); rotate the Dex client secret; real
  authentik `AUTHENTIK_SECRET_KEY`.
- **Persistent, backed-up** API datastore; authentik DB on managed Postgres.
- **Real upstream IdP** (Okta/Entra/Keycloak) instead of Dex static passwords; MFA.
- **Token lifetimes & refresh** tuned; consider DPoP/sender-constrained tokens.
- **Authorization** beyond `groups` (fine-grained scopes/roles); per-route policy.
- **Observability:** structured logs (never tokens), metrics, tracing, alerting.
- **CI** running `task validate` (incl. browser E2E) on every change; image scanning.

## 14. Unresolved risks

- **Image/version churn:** `latest stable` pins will drift; authentik blueprint schema and
  the identification-stage default may change across authentik majors — re-validate on bump.
- **`*.localhost` resolution** depends on the host resolver (glibc/Linux). Inside
  containers we use `extra_hosts: host-gateway`; on other host OSes the browser-side
  `*.localhost`→127.0.0.1 assumption should be re-confirmed.
- **First-login enrollment timing:** the brokered enrollment path is slower than the
  returning-user path; the E2E now polls for the authenticated UI (URL/stage agnostic) to
  absorb this, but a much slower host could still need larger timeouts.
- **Dex env-var expansion gotcha** is now documented in `dex/config.yml`; a future edit
  reintroducing `$VAR` indirection would silently rebreak the token exchange.
