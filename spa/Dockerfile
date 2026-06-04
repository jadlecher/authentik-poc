# =============================================================================
# Multi-stage build: node builder → nginx static server
# =============================================================================
# Stage 1: builder
#   - Uses Node 24 (LTS) to install dependencies and build the Vite app.
#   - npm ci --ignore-scripts ensures reproducible, no-workspace install.
#   - openapi-typescript generates src/api/schema.d.ts from the shared OpenAPI spec
#     BEFORE tsc/vite runs so the generated types are available at build time.
#
# Stage 2: nginx
#   - Copies only the compiled dist/ from stage 1 — no node_modules in final image.
#   - Container listens on port 80 (CONTRACT §7).
#   - nginx.conf provides SPA fallback (try_files $uri /index.html).
# =============================================================================

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies with exact lockfile (reproducible).
# Build context is the repo root (set in docker-compose.yml via context/dockerfile),
# so we can access both spa/ and api/ directories.
COPY spa/package.json spa/package-lock.json ./
RUN npm ci --ignore-scripts

# Copy SPA source.
COPY spa/ .

# Copy the shared OpenAPI spec (CONTRACT §6: SPA client types generated from this).
# api/openapi/openapi.yaml is the canonical spec; do NOT duplicate it.
COPY api/openapi/openapi.yaml /openapi.yaml

# Generate TypeScript types from the OpenAPI spec.
# The generated file (src/api/schema.d.ts) is consumed by the TypeScript compiler.
# We call openapi-typescript directly with the absolute spec path rather than
# relying on the relative path in the npm script (which works for local dev).
RUN npx openapi-typescript /openapi.yaml -o src/api/schema.d.ts

# Build the production SPA bundle.
# Vite reads VITE_* from .env (committed); these are build-time constants
# baked into the JS bundle — NOT runtime secrets.
RUN npm run build

# ── Stage 2: serve ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Replace the default nginx config with our SPA-aware config.
# Path is relative to build context root (repo root, per docker-compose.yml).
COPY spa/nginx.conf /etc/nginx/conf.d/default.conf

# Copy compiled assets from the builder stage.
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx listens on port 80 (CONTRACT §7).
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
