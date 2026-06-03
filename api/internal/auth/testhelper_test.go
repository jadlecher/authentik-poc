package auth_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// testKeySet holds a generated RSA keypair and a test OIDC server.
type testKeySet struct {
	privateKey *rsa.PrivateKey
	kid        string
	server     *httptest.Server
	issuer     string // base URL of the test server
	jwksURL    string
}

// newTestKeySet generates a 2048-bit RSA key, starts a local httptest.Server
// that serves both the OIDC discovery doc and the JWKS, and returns a testKeySet.
func newTestKeySet(t *testing.T) *testKeySet {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}

	ts := &testKeySet{
		privateKey: key,
		kid:        "test-key-1",
	}

	mux := http.NewServeMux()

	// We set up the httptest server first with a placeholder, then set the issuer.
	srv := httptest.NewServer(mux)
	ts.server = srv
	ts.issuer = srv.URL + "/"
	ts.jwksURL = srv.URL + "/jwks"

	// OIDC discovery endpoint.
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		doc := map[string]interface{}{
			"issuer":                 ts.issuer,
			"jwks_uri":               ts.jwksURL,
			"authorization_endpoint": ts.issuer + "authorize",
			"token_endpoint":         ts.issuer + "token",
			"response_types_supported": []string{"code"},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	})

	// JWKS endpoint — serves the public key.
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		pub := &key.PublicKey
		jwks := map[string]interface{}{
			"keys": []map[string]interface{}{
				{
					"kty": "RSA",
					"alg": "RS256",
					"use": "sig",
					"kid": ts.kid,
					"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
					"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jwks)
	})

	t.Cleanup(srv.Close)
	return ts
}

// MintToken mints a signed JWT with the given claims.
// All claims are explicit — caller controls iss, aud, exp, nbf, sub, email, groups.
func (ts *testKeySet) MintToken(t *testing.T, claims map[string]interface{}) string {
	t.Helper()

	// Build header.
	header := map[string]interface{}{
		"alg": "RS256",
		"typ": "JWT",
		"kid": ts.kid,
	}

	headerJSON, _ := json.Marshal(header)
	claimsJSON, _ := json.Marshal(claims)

	h64 := base64.RawURLEncoding.EncodeToString(headerJSON)
	c64 := base64.RawURLEncoding.EncodeToString(claimsJSON)
	msg := h64 + "." + c64

	sig, err := signRS256(ts.privateKey, []byte(msg))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	return msg + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// MintTokenWithKID mints a token but uses a different kid (for unknown-kid test).
func (ts *testKeySet) MintTokenWithKID(t *testing.T, kid string, claims map[string]interface{}) string {
	t.Helper()

	header := map[string]interface{}{
		"alg": "RS256",
		"typ": "JWT",
		"kid": kid,
	}

	headerJSON, _ := json.Marshal(header)
	claimsJSON, _ := json.Marshal(claims)

	h64 := base64.RawURLEncoding.EncodeToString(headerJSON)
	c64 := base64.RawURLEncoding.EncodeToString(claimsJSON)
	msg := h64 + "." + c64

	sig, err := signRS256(ts.privateKey, []byte(msg))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	return msg + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// DefaultClaims returns a valid claim set for the given issuer/audience.
func defaultClaims(issuer, audience, sub, email string) map[string]interface{} {
	now := time.Now()
	return map[string]interface{}{
		"iss":    issuer,
		"aud":    []string{audience},
		"sub":    sub,
		"email":  email,
		"name":   "Test User",
		"groups": []string{"users"},
		"iat":    now.Unix(),
		"exp":    now.Add(time.Hour).Unix(),
	}
}
