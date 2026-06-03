// Package main is the entrypoint for the authentik-poc Go API.
//
// Configuration (all via environment variables):
//
//	OIDC_ISSUER   - Exact issuer URL (default: http://auth.localhost:8000/application/o/app/)
//	OIDC_AUDIENCE - Required audience (default: poc-api)
//	OIDC_JWKS_URL - Optional JWKS URL override (default: discovered from issuer)
//	LISTEN_ADDR   - Listen address (default: :8080)
//
// JWKS is fetched from the issuer's OIDC discovery document at startup.
// The api container must be able to reach the issuer over HTTP — see docker-compose.yml
// extra_hosts section which maps auth.localhost to the Traefik container via host-gateway.
//
//go:generate go run github.com/ogen-go/ogen/cmd/ogen --target ../../internal/oapi --package oapi --clean ../../openapi/openapi.yaml
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/poc/authentik-poc/api/internal/auth"
	"github.com/poc/authentik-poc/api/internal/handler"
	"github.com/poc/authentik-poc/api/internal/oapi"
	"github.com/poc/authentik-poc/api/internal/store"
)

func main() {
	issuer := getenv("OIDC_ISSUER", "http://auth.localhost:8000/application/o/app/")
	audience := getenv("OIDC_AUDIENCE", "poc-api")
	jwksOverride := getenv("OIDC_JWKS_URL", "")
	listenAddr := getenv("LISTEN_ADDR", ":8080")

	log.Printf("api: starting up")
	log.Printf("api: OIDC issuer=%q audience=%q", issuer, audience)
	if jwksOverride != "" {
		log.Printf("api: JWKS override URL=%q", jwksOverride)
	}

	ctx := context.Background()

	cfg := auth.Config{
		IssuerURL:       issuer,
		Audience:        audience,
		JWKSOverrideURL: jwksOverride,
	}

	// Retry OIDC discovery up to 10 times with a 3s delay — the issuer (authentik)
	// may still be starting up when the api container starts.
	var validator *auth.Validator
	var err error
	for attempt := 1; attempt <= 10; attempt++ {
		validator, err = auth.NewValidator(ctx, cfg)
		if err == nil {
			break
		}
		log.Printf("api: OIDC discovery attempt %d/10 failed: %v (retrying in 3s)", attempt, err)
		time.Sleep(3 * time.Second)
	}
	if err != nil {
		log.Fatalf("api: could not initialize OIDC validator after 10 attempts: %v", err)
	}
	log.Printf("api: OIDC validator initialized OK — JWKS keys loaded")

	s := store.New()
	h := handler.New(validator, s)

	srv, err := oapi.NewServer(h, h, oapi.WithErrorHandler(handler.ErrorHandler))
	if err != nil {
		log.Fatalf("api: failed to create ogen server: %v", err)
	}

	// Wrap the ogen server in a simple mux to add a /healthz endpoint.
	// /healthz is intentionally unauthenticated (no bearer required) — it only
	// confirms the process is alive, not that the user is authorized.
	// This allows wget/curl healthchecks to succeed (200 OK) rather than
	// failing on the 401 from protected endpoints.
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/", srv)

	log.Printf("api: listening on %s", listenAddr)
	httpSrv := &http.Server{
		Addr:         listenAddr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatalf("api: server error: %v", err)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
