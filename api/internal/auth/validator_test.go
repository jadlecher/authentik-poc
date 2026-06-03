package auth_test

import (
	"context"
	"testing"
	"time"

	"github.com/poc/authentik-poc/api/internal/auth"
)

const (
	testAudience = "poc-api"
	testSub      = "test-user-sub-123"
	testEmail    = "alice@example.com"
)

// newTestValidator creates a Validator pointed at the test OIDC server.
// The test server serves discovery + JWKS with the generated keypair.
func newTestValidator(t *testing.T, ts *testKeySet) *auth.Validator {
	t.Helper()
	cfg := auth.Config{
		IssuerURL:       ts.issuer,
		Audience:        testAudience,
		JWKSOverrideURL: ts.jwksURL,
	}
	v, err := auth.NewValidatorWithHTTPClient(context.Background(), cfg, ts.server.Client())
	if err != nil {
		t.Fatalf("NewValidatorWithHTTPClient: %v", err)
	}
	return v
}

func TestValidToken(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	token := ts.MintToken(t, defaultClaims(ts.issuer, testAudience, testSub, testEmail))

	claims, err := v.ValidateBearer(context.Background(), token)
	if err != nil {
		t.Fatalf("expected valid token to succeed, got: %v", err)
	}
	if claims.Sub != testSub {
		t.Errorf("sub: got %q, want %q", claims.Sub, testSub)
	}
	if claims.Email != testEmail {
		t.Errorf("email: got %q, want %q", claims.Email, testEmail)
	}
}

func TestExpiredToken(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	c := defaultClaims(ts.issuer, testAudience, testSub, testEmail)
	c["exp"] = time.Now().Add(-time.Hour).Unix() // already expired

	token := ts.MintToken(t, c)

	_, err := v.ValidateBearer(context.Background(), token)
	if err == nil {
		t.Fatal("expected expired token to fail, got nil error")
	}
}

func TestNotYetValidToken(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	c := defaultClaims(ts.issuer, testAudience, testSub, testEmail)
	c["nbf"] = time.Now().Add(time.Hour).Unix() // not valid for another hour

	token := ts.MintToken(t, c)

	_, err := v.ValidateBearer(context.Background(), token)
	if err == nil {
		t.Fatal("expected nbf-in-future token to fail, got nil error")
	}
}

func TestWrongIssuer(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	c := defaultClaims("http://evil.attacker.com/", testAudience, testSub, testEmail)
	token := ts.MintToken(t, c)

	_, err := v.ValidateBearer(context.Background(), token)
	if err == nil {
		t.Fatal("expected wrong-issuer token to fail, got nil error")
	}
}

func TestWrongAudience(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	c := defaultClaims(ts.issuer, "not-poc-api", testSub, testEmail)
	token := ts.MintToken(t, c)

	_, err := v.ValidateBearer(context.Background(), token)
	if err == nil {
		t.Fatal("expected wrong-audience token to fail, got nil error")
	}
}

func TestAudienceMembership(t *testing.T) {
	// Token with aud = ["spa-client", "poc-api"] — should succeed (membership check).
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	c := defaultClaims(ts.issuer, testAudience, testSub, testEmail)
	c["aud"] = []string{"spa-client", testAudience} // multi-audience token

	token := ts.MintToken(t, c)

	claims, err := v.ValidateBearer(context.Background(), token)
	if err != nil {
		t.Fatalf("expected multi-aud token with poc-api to succeed, got: %v", err)
	}
	if claims.Sub != testSub {
		t.Errorf("sub: got %q, want %q", claims.Sub, testSub)
	}
}

func TestUnknownKID(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	// Mint a token with a kid that does NOT match any key in the JWKS.
	c := defaultClaims(ts.issuer, testAudience, testSub, testEmail)
	token := ts.MintTokenWithKID(t, "unknown-kid-xyz", c)

	_, err := v.ValidateBearer(context.Background(), token)
	if err == nil {
		t.Fatal("expected unknown-kid token to fail, got nil error")
	}
}

func TestEmptyToken(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	_, err := v.ValidateBearer(context.Background(), "")
	if err == nil {
		t.Fatal("expected empty token to fail, got nil error")
	}
}

func TestMalformedToken(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	_, err := v.ValidateBearer(context.Background(), "not.a.jwt")
	if err == nil {
		t.Fatal("expected malformed token to fail, got nil error")
	}
}

func TestGroupsClaim(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	c := defaultClaims(ts.issuer, testAudience, testSub, testEmail)
	c["groups"] = []string{"admins"}

	token := ts.MintToken(t, c)

	claims, err := v.ValidateBearer(context.Background(), token)
	if err != nil {
		t.Fatalf("valid token with groups: %v", err)
	}
	if !claims.IsAdmin() {
		t.Error("expected IsAdmin()=true for groups=[admins]")
	}
}

func TestNonAdminGroups(t *testing.T) {
	ts := newTestKeySet(t)
	v := newTestValidator(t, ts)

	c := defaultClaims(ts.issuer, testAudience, testSub, testEmail)
	c["groups"] = []string{"users"}

	token := ts.MintToken(t, c)

	claims, err := v.ValidateBearer(context.Background(), token)
	if err != nil {
		t.Fatalf("valid token with groups=[users]: %v", err)
	}
	if claims.IsAdmin() {
		t.Error("expected IsAdmin()=false for groups=[users]")
	}
}
