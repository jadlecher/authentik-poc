# Interface Contract — authentik Identity-Broker PoC

> **This file is the single source of truth.** Every worker MUST read it and conform
> exactly to these names, ports, URLs, IDs, and secrets. If something here is wrong or
> impossible, STOP and report to the orchestrator — do not silently diverge.

All secrets in this file are **LOCAL / DEMO ONLY** and are intentionally committed to
the repo for reproducibility. They must never be reused outside this local PoC.

---

## 0. Global decisions (non-negotiable)

- **Transport:** HTTP only (no TLS). Documented local shortcut.
- **Ingress:** Traefik is the ONLY service that publishes host ports.
- **Host ingress port:** `8000` (web). `8443` reserved but unused for now.
- **CRITICAL — single port inside and out:** Traefik's `web` entrypoint listens on
  container port **8000**, published as host `8000:8000` (NOT 80→8000). This makes the
  authority string `host.localhost:8000` resolve identically from the browser and from
  inside the Docker network, so JWT issuer/JWKS URLs are byte-for-byte identical on both
  sides. Do not introduce a port remap.
- **IaC:** authentik via mounted **blueprints**, auto-applied on cold start. No UI edits.
- **Worker model:** Sonnet.

---

## 1. Docker / compose topology

- **Compose project:** default (directory `authentik-poc`).
- **Shared network:** `poc` (single user-defined bridge; all services attach).
- **Service names** (also their in-network DNS names):
  - `traefik`
  - `dex`
  - `authentik-postgresql`
  - `authentik-redis`
  - `authentik-server`
  - `authentik-worker`
  - `api`
  - `spa`
- **Network aliases on `traefik`** (so internal callers resolve public hostnames to
  Traefik): `app.localhost`, `auth.localhost`, `idp.localhost`, `traefik.localhost`.
  Implement via compose:
  ```yaml
  services:
    traefik:
      networks:
        poc:
          aliases: [app.localhost, auth.localhost, idp.localhost, traefik.localhost]
  ```
- **Only `traefik` has a `ports:` mapping** (`"8000:8000"`). No other service may
  publish a host port. Use Traefik labels for routing.

---

## 2. Hostnames & routes (all on `:8000`)

| URL                                   | Routes to          | Notes                              |
|---------------------------------------|--------------------|------------------------------------|
| `http://app.localhost:8000/`          | `spa`              | React SPA (static)                 |
| `http://app.localhost:8000/api/...`   | `api`              | Go API, same-origin as SPA         |
| `http://auth.localhost:8000/`         | `authentik-server` | authentik UI + OIDC endpoints      |
| `http://idp.localhost:8000/`          | `dex`              | Dex (served under `/dex` path too) |
| `http://traefik.localhost:8000/`      | Traefik dashboard  | local-only, documented             |

- SPA and API share origin `app.localhost:8000` → **no CORS needed** for SPA→API.
- API path prefix `/api` is stripped? **No** — the API serves routes under `/api/...`
  directly (OpenAPI paths are `/api/me`, `/api/todos`). Traefik routes
  `Host(app.localhost) && PathPrefix(/api)` to `api` WITHOUT stripping the prefix.
- Traefik dashboard: enabled via a router on `traefik.localhost`, `api.dashboard=true`,
  `api.insecure=false`. Documented as local-only.

---

## 3. Dex (upstream IdP) — `idp.localhost`

- **Image:** `ghcr.io/dexidp/dex:<latest stable>` (pin tag; document).
- **Issuer:** `http://idp.localhost:8000/dex`
  (Dex `issuer` config = exactly this string; Dex serves under path `/dex`).
- **Traefik route:** `Host(idp.localhost)` → `dex` container port `5556`. No host port.
- **Discovery:** `http://idp.localhost:8000/dex/.well-known/openid-configuration`.
- **Static OIDC client for authentik (confidential):**
  - `client_id`: `authentik`
  - `client_secret`: `authentik-dex-secret-LOCAL-DEMO-ONLY`
  - `redirect_uris`: `["http://auth.localhost:8000/source/oauth/callback/dex/"]`
    (authentik OAuth-source callback; source slug = `dex`).
- **Demo users (static passwords; distinct identities):**

  | username | email             | password   | intended role |
  |----------|-------------------|------------|---------------|
  | alice    | alice@example.com | `password` | admin         |
  | bob      | bob@example.com   | `password` | user          |

  - Passwords stored as bcrypt hashes in Dex config (worker generates).
  - Dex `staticPasswords` do not emit `groups`. Roles/groups are derived **downstream in
    authentik** from the email (see §4). Dex's job is authentication + email/name/sub.
  - `enablePasswordDB: true`.
- Dex must NOT publish a host port.

---

## 4. authentik (broker + downstream OP) — `auth.localhost`

- **Images:** `ghcr.io/goauthentik/server:<latest stable>` for both `authentik-server`
  (command `server`) and `authentik-worker` (command `worker`). Pin tag; document.
- **DB:** `authentik-postgresql` (`docker.io/library/postgres:16-alpine` or per
  authentik's recommended version). **Cache/broker:** `authentik-redis`
  (`docker.io/library/redis:<stable>`).
- **Env (LOCAL/DEMO):**
  - `AUTHENTIK_SECRET_KEY=local-demo-secret-key-change-me-please-0123456789abcdef`
  - `AUTHENTIK_BOOTSTRAP_PASSWORD=akadmin-local-demo-password` (break-glass admin)
  - `AUTHENTIK_BOOTSTRAP_TOKEN=local-demo-bootstrap-token-0123456789` (optional, for
    scripted checks only)
  - `AUTHENTIK_BOOTSTRAP_EMAIL=akadmin@localhost`
  - Postgres: `POSTGRES_DB=authentik`, `POSTGRES_USER=authentik`,
    `POSTGRES_PASSWORD=authentik-local-demo-db-password`
  - Disable outbound error reporting; set `AUTHENTIK_DISABLE_UPDATE_CHECK=true`,
    `AUTHENTIK_ERROR_REPORTING__ENABLED=false`.
- **Break-glass admin** `akadmin` exists ONLY for debugging. Normal users come from Dex.
- **Blueprints** (mounted at `/blueprints/custom/…`, auto-applied on boot) must declare,
  idempotently, with no UI edits:
  1. **OAuth Source `dex`** (provider type generic OpenID / OIDC):
     - slug `dex`, name "Dex"
     - `consumer_key` = `authentik`, `consumer_secret` =
       `authentik-dex-secret-LOCAL-DEMO-ONLY`
     - OIDC well-known: `http://idp.localhost:8000/dex/.well-known/openid-configuration`
     - scopes: `openid profile email`
     - enrollment/authentication flows: use authentik default source flows so brokered
       users are created automatically on first login.
  2. **OIDC Provider for the SPA/API** (`authentik-server` issues these tokens):
     - name `app-provider`, application slug **`app`**
     - **client type: public** (PKCE), **client_id `spa-client`**, **no client secret**
     - `sub_mode`: based on the authentik user (stable per brokered Dex user)
     - **access token format: JWT** signed with an RS256 key (so the API can verify via
       JWKS). Use authentik's managed RSA signing key.
     - redirect URIs (exact):
       - `http://app.localhost:8000/callback`
       - `http://app.localhost:8000/silent-renew`
       - post-logout: `http://app.localhost:8000/`
     - issuer (resulting): `http://auth.localhost:8000/application/o/app/`
     - **audience: `poc-api`** must appear in the access-token `aud`. Implement via a
       scope mapping (below). If authentik also adds the client_id to `aud`, that's fine
       as long as `poc-api` is present.
  3. **Property / scope mappings** bound to the provider so access tokens carry:
     - `email` (from brokered Dex email)
     - `groups`: derived expression — return `["admins"]` if the user email is
       `alice@example.com`, else `["users"]`. (Demonstrates broker claim-mapping; this is
       authentik enriching upstream identity, which is expected per the flow.)
     - `aud`: include `poc-api` (the API audience). Tie to a scope named `api`.
     - Standard `sub`, `email`, `name`, `preferred_username` from profile/email scopes.
  4. **Application** `app` linked to `app-provider`, accessible to brokered users.
- **OIDC discovery for SPA/API:**
  `http://auth.localhost:8000/application/o/app/.well-known/openid-configuration`
  - authorization, token, jwks endpoints under `http://auth.localhost:8000/application/o/app/…`
  - JWKS: `http://auth.localhost:8000/application/o/app/jwks/`
- authentik must NOT publish a host port (only via Traefik on `auth.localhost`).
- Set `AUTHENTIK_HOST`/cookie domain appropriately so sessions work on `auth.localhost`
  over plain HTTP (worker confirms session works without TLS).

---

## 5. Token claims contract (what the API can rely on)

authentik-issued **access token (JWT)** MUST contain:

- `iss` = `http://auth.localhost:8000/application/o/app/`
- `aud` includes `poc-api`
- `sub` = stable opaque user id (per brokered Dex user)
- `email` = e.g. `alice@example.com`
- `name` / `preferred_username`
- `groups` = array, e.g. `["admins"]` or `["users"]`
- `exp`, `iat`, `nbf` (standard)
- signed RS256, key published at the JWKS URL above.

---

## 6. Go API

- **Module path:** `github.com/poc/authentik-poc/api` (or similar; document).
- **Spec:** `api/openapi/openapi.yaml` — the canonical OpenAPI 3 spec. **The SPA generates
  its client from THIS file.** Keep it the single shared spec.
- **Generator:** `ogen` (justify in README; ogen gives spec-first, type-safe handlers and
  built-in validation). Generated code lives in `api/internal/oapi/` (regenerated by
  `task`).
- **Endpoints:** `GET /api/me`, `GET /api/todos`, `POST /api/todos`,
  `GET /api/todos/{id}`.
- **Auth middleware (real, fail-closed):** validate every protected request's
  `Authorization: Bearer <jwt>`:
  - signature via JWKS fetched from discovery (cache keys; refresh on unknown kid)
  - `iss` exact match (§5)
  - `aud` contains `poc-api`
  - `exp` (and `nbf`/`iat` where present)
  - reject missing/malformed/expired/wrong-iss/wrong-aud → `401` (or `403` for scope),
    with a generic JSON error, **never** echoing the token.
  - **MUST NOT** trust `X-authentik-*` (or any proxy identity header) as authentication.
- **Behavior:** todos are per-user keyed on `sub`; `GET /api/me` returns claims-derived
  profile (sub, email, name, groups). In-memory store is fine (document non-persistence).
  Optionally use `groups` to show admin-only behavior.
- **Config via env:**
  - `OIDC_ISSUER=http://auth.localhost:8000/application/o/app/`
  - `OIDC_AUDIENCE=poc-api`
  - (JWKS discovered from issuer; allow override `OIDC_JWKS_URL` if needed)
  - `LISTEN_ADDR=:8080` (container port; Traefik targets this)
- **Never log tokens.**

---

## 7. React SPA

- **Stack:** Vite + React + TypeScript (latest stable). Served as static build behind
  Traefik (e.g. nginx or a static server container). Container listens on port `80`
  internally (or `8080`); Traefik targets it. Document the port chosen.
- **OIDC:** `react-oidc-context` + `oidc-client-ts`, **Authorization Code + PKCE**,
  **public client, NO secret**.
  - `authority`: `http://auth.localhost:8000/application/o/app/`
  - `client_id`: `spa-client`
  - `redirect_uri`: `http://app.localhost:8000/callback`
  - `post_logout_redirect_uri`: `http://app.localhost:8000/`
  - `scope`: `openid profile email groups api offline_access`
  - `response_type`: `code`
- **API client:** generate TypeScript types from `api/openapi/openapi.yaml` via
  `openapi-typescript` (+ a thin typed fetch wrapper, or `openapi-fetch`). Calls go to
  same-origin `/api/...` with `Authorization: Bearer <access_token>`.
- **UI:** login, logout, authenticated user display (from ID token), API profile display
  (`GET /api/me`), todos list + create.
- **Never log tokens.** Store per oidc-client-ts defaults; document the choice.
- **Build-time env** (Vite `VITE_…`): expose the OIDC values above. Document.

---

## 8. Taskfile (developer workflow)

- `task dev` → up the full stack (build images, codegen, `docker compose up -d`,
  wait for health), print the URLs and demo creds.
- `task dev:clean` → `docker compose down -v --remove-orphans` + remove generated runtime
  state (generated code may stay or be cleaned — document); idempotent.
- `task validate` → run infra checks + API neg/pos tests + browser E2E.
- `task logs`, `task test`, `task test:e2e` as helpers.
- Must require NO manual UI configuration at any point.

---

## 9. Validation (Phase 4) expectations

- **Infra:** only `traefik` publishes host ports; hostname routing resolves; Dex &
  authentik discovery reachable through Traefik.
- **Browser E2E (Playwright):** open `app.localhost:8000`, login → redirected to
  authentik → delegated to Dex → log in as alice → back to SPA → tokens obtained → API
  called → user-specific data (email `alice@example.com`, groups `admins`) rendered.
- **API negative/positive:** no token → 401; malformed → 401; expired → 401; wrong `iss`
  → 401; wrong `aud` → 401; spoofed `X-authentik-*` only (no bearer) → 401; valid token →
  200 with user-scoped data.

---

## 10. Worker reporting requirements (every worker)

Each worker returns: (a) assumptions made, (b) full list of files created/changed,
(c) the exact validation commands it ran and their results, (d) any deviation from this
contract with justification, (e) risks/blockers for the orchestrator.
