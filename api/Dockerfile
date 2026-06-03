# =============================================================================
# authentik-poc — Go API
# Multi-stage build: compile with golang:1.24-alpine, run on alpine:3.21.
# =============================================================================
# Stage 1: Build
# Uses the latest stable Go (1.24.x) on Alpine for a small build image.
# =============================================================================
# golang:1.26-alpine is the latest stable Go as of 2026-06 (matches local go 1.25+ requirement).
# go.mod requires go 1.25.0; golang:1.26 satisfies this.
FROM golang:1.26-alpine AS builder

WORKDIR /src

# Copy dependency manifests first for layer caching.
COPY go.mod go.sum ./
RUN go mod download

# Copy source.
COPY . .

# Regenerate ogen code from the OpenAPI spec.
# This ensures the build always uses the canonical spec even in a fresh clone
# where internal/oapi/ may be git-ignored.
RUN go run github.com/ogen-go/ogen/cmd/ogen \
      --target ./internal/oapi \
      --package oapi \
      --clean \
      ./openapi/openapi.yaml

# Build the binary (statically linked; CGO disabled for Alpine compatibility).
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /api ./cmd/api

# =============================================================================
# Stage 2: Runtime
# Minimal Alpine image — no shell tools, no package manager in the hot path.
# =============================================================================
FROM alpine:3.21

# ca-certificates: needed to make HTTPS/HTTP calls to the authentik issuer.
# wget: used for the docker-compose healthcheck.
RUN apk add --no-cache ca-certificates wget

WORKDIR /app
COPY --from=builder /api .

# Configuration is passed via environment variables (CONTRACT §6):
#   OIDC_ISSUER    — OIDC issuer URL (default: http://auth.localhost:8000/application/o/app/)
#   OIDC_AUDIENCE  — Expected audience (default: poc-api)
#   OIDC_JWKS_URL  — Optional JWKS override (empty = discovered from issuer)
#   LISTEN_ADDR    — Listen address (default: :8080)
ENV OIDC_ISSUER="http://auth.localhost:8000/application/o/app/" \
    OIDC_AUDIENCE="poc-api" \
    LISTEN_ADDR=":8080"

EXPOSE 8080

ENTRYPOINT ["/app/api"]
