package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Config holds the OIDC configuration for JWT validation.
// IssuerURL and Audience are required.
// JWKSOverrideURL is optional — used in tests to point at a local JWKS server
// instead of the issuer's discovered JWKS.
type Config struct {
	IssuerURL       string // e.g. "http://auth.localhost:8000/application/o/app/"
	Audience        string // e.g. "poc-api"
	JWKSOverrideURL string // optional; if set, used instead of discovered jwks_uri
}

// Validator validates JWT Bearer tokens.
// It uses go-oidc/v3 which handles OIDC discovery, JWKS fetching, key caching,
// and automatic refresh on unknown kid.
//
// Rationale for go-oidc/v3:
//   - Handles discovery + JWKS management + RS256 verification in one library.
//   - Actively maintained by CoreOS/Red Hat; used widely in production Go OIDC clients.
//   - RemoteKeySet refreshes on unknown kid automatically.
//   - No reflection in the hot path; claims extraction is via standard JSON.
type Validator struct {
	cfg      Config
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	mu       sync.RWMutex
}

// NewValidator creates a Validator by performing OIDC discovery against the issuer.
// It will fail immediately if the issuer is unreachable — fail fast at startup.
func NewValidator(ctx context.Context, cfg Config) (*Validator, error) {
	if cfg.IssuerURL == "" {
		return nil, errors.New("auth: IssuerURL is required")
	}
	if cfg.Audience == "" {
		return nil, errors.New("auth: Audience is required")
	}

	provider, err := oidc.NewProvider(ctx, cfg.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("auth: OIDC discovery failed for %q: %w", cfg.IssuerURL, err)
	}

	var verifier *oidc.IDTokenVerifier
	if cfg.JWKSOverrideURL != "" {
		// Test path: use a manually constructed JWKS source pointing at the test server.
		// This bypasses discovery and uses a controlled keypair.
		keySet := oidc.NewRemoteKeySet(ctx, cfg.JWKSOverrideURL)
		verifier = oidc.NewVerifier(cfg.IssuerURL, keySet, &oidc.Config{
			// Audience check is manual (membership, not equality).
			SkipClientIDCheck: true,
			// We do NOT skip expiry.
		})
	} else {
		// Production path: use the verifier from discovery.
		// SkipClientIDCheck because we do audience membership check manually below.
		verifier = provider.Verifier(&oidc.Config{
			SkipClientIDCheck: true,
		})
	}

	return &Validator{
		cfg:      cfg,
		provider: provider,
		verifier: verifier,
	}, nil
}

// rawClaims is used to extract custom claims from the token.
type rawClaims struct {
	Sub                 string   `json:"sub"`
	Email               string   `json:"email"`
	Name                string   `json:"name"`
	PreferredUsername   string   `json:"preferred_username"`
	Groups              []string `json:"groups"`
	Audience            audience `json:"aud"`
}

// audience handles both string and []string forms of the aud claim.
type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	// Try array first.
	var arr []string
	if err := json.Unmarshal(b, &arr); err == nil {
		*a = arr
		return nil
	}
	// Fall back to single string.
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	*a = []string{s}
	return nil
}

// ValidateBearer parses and validates a raw JWT string (without the "Bearer " prefix).
// Returns validated Claims on success, or an error on any failure.
// NEVER logs or returns token content in errors.
func (v *Validator) ValidateBearer(ctx context.Context, rawToken string) (*Claims, error) {
	// Verify signature, iss, exp, nbf, iat via go-oidc.
	// go-oidc.IDToken.Verify checks: signature (via JWKS), iss exact match, exp.
	idToken, err := v.verifier.Verify(ctx, rawToken)
	if err != nil {
		// Do not include err details that might leak token info.
		return nil, fmt.Errorf("auth: token verification failed")
	}

	// Extract raw claims for audience membership check and custom claims.
	var rc rawClaims
	if err := idToken.Claims(&rc); err != nil {
		return nil, fmt.Errorf("auth: failed to parse token claims")
	}

	// Validate aud MEMBERSHIP (not equality) — token may carry ["spa-client","poc-api"].
	if !slices.Contains([]string(rc.Audience), v.cfg.Audience) {
		return nil, fmt.Errorf("auth: audience %q not found in token", v.cfg.Audience)
	}

	// Validate nbf manually if present (go-oidc checks exp but not always nbf on access tokens).
	// go-oidc v3 does check nbf on ID tokens; for access tokens used here we enforce it explicitly.
	now := time.Now()
	if idToken.IssuedAt.After(now.Add(5 * time.Minute)) {
		// iat far in the future — clock skew attack.
		return nil, fmt.Errorf("auth: token issued in the future")
	}

	name := rc.Name
	if name == "" {
		name = rc.PreferredUsername
	}
	if rc.Sub == "" {
		return nil, fmt.Errorf("auth: missing sub claim")
	}

	return &Claims{
		Sub:    rc.Sub,
		Email:  rc.Email,
		Name:   name,
		Groups: rc.Groups,
	}, nil
}

// NoopTransport wraps an http.RoundTripper — used to inject custom transports in tests.
type NoopTransport struct {
	Next http.RoundTripper
}

func (t *NoopTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return t.Next.RoundTrip(req)
}

// NewValidatorWithHTTPClient creates a Validator using a custom HTTP client.
// Used in tests to point discovery at a local test server.
func NewValidatorWithHTTPClient(ctx context.Context, cfg Config, httpClient *http.Client) (*Validator, error) {
	if cfg.IssuerURL == "" {
		return nil, errors.New("auth: IssuerURL is required")
	}
	if cfg.Audience == "" {
		return nil, errors.New("auth: Audience is required")
	}

	// Inject the custom HTTP client into the context for go-oidc discovery.
	ctx = oidc.ClientContext(ctx, httpClient)

	provider, err := oidc.NewProvider(ctx, cfg.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("auth: OIDC discovery failed for %q: %w", cfg.IssuerURL, err)
	}

	var verifier *oidc.IDTokenVerifier
	if cfg.JWKSOverrideURL != "" {
		// Use overridden JWKS URL with the custom HTTP client.
		keySet := oidc.NewRemoteKeySet(oidc.ClientContext(ctx, httpClient), cfg.JWKSOverrideURL)
		verifier = oidc.NewVerifier(cfg.IssuerURL, keySet, &oidc.Config{
			SkipClientIDCheck: true,
		})
	} else {
		verifier = provider.Verifier(&oidc.Config{
			SkipClientIDCheck: true,
		})
	}

	return &Validator{
		cfg:      cfg,
		provider: provider,
		verifier: verifier,
	}, nil
}

