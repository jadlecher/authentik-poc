// Package handler_test provides HTTP integration tests for the ogen server.
//
// These tests prove fail-closed behavior WITHOUT a browser by:
//   1. Generating a local RSA keypair.
//   2. Serving a local OIDC discovery + JWKS via httptest.
//   3. Creating a Validator pointed at the local server.
//   4. Spinning up the ogen HTTP server.
//   5. Issuing HTTP requests with crafted tokens and asserting status codes.
//
// All security properties are verified here:
//   - valid token → 200
//   - no Authorization header → 401
//   - malformed token / wrong scheme → 401
//   - expired token → 401
//   - nbf in future → 401
//   - wrong issuer → 401
//   - wrong audience → 401
//   - unknown kid → 401
//   - spoofed X-authentik-email without bearer → 401
//   - spoofed header WITH valid token → header ignored, identity from token
package handler_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/poc/authentik-poc/api/internal/auth"
	"github.com/poc/authentik-poc/api/internal/handler"
	"github.com/poc/authentik-poc/api/internal/oapi"
	"github.com/poc/authentik-poc/api/internal/store"
)

// ---------------------------------------------------------------------------
// Test fixtures / helpers
// ---------------------------------------------------------------------------

const (
	testAudience = "poc-api"
	testSub      = "user-abc-123"
	testEmail    = "alice@example.com"
)

type testEnv struct {
	privateKey *rsa.PrivateKey
	kid        string
	oidcSrv    *httptest.Server // local OIDC discovery + JWKS server
	apiSrv     *httptest.Server // ogen HTTP server under test
	issuer     string
	jwksURL    string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}

	env := &testEnv{
		privateKey: key,
		kid:        "test-key-1",
	}

	// Build local OIDC server.
	mux := http.NewServeMux()
	oidcSrv := httptest.NewServer(mux)
	env.oidcSrv = oidcSrv
	env.issuer = oidcSrv.URL + "/"
	env.jwksURL = oidcSrv.URL + "/jwks"

	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		doc := map[string]interface{}{
			"issuer":                   env.issuer,
			"jwks_uri":                 env.jwksURL,
			"authorization_endpoint":   env.issuer + "authorize",
			"token_endpoint":           env.issuer + "token",
			"response_types_supported": []string{"code"},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	})

	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		pub := &key.PublicKey
		jwks := map[string]interface{}{
			"keys": []map[string]interface{}{
				{
					"kty": "RSA",
					"alg": "RS256",
					"use": "sig",
					"kid": env.kid,
					"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
					"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jwks)
	})

	// Build validator.
	cfg := auth.Config{
		IssuerURL:       env.issuer,
		Audience:        testAudience,
		JWKSOverrideURL: env.jwksURL,
	}
	validator, err := auth.NewValidatorWithHTTPClient(
		context.Background(), cfg, oidcSrv.Client(),
	)
	if err != nil {
		t.Fatalf("NewValidatorWithHTTPClient: %v", err)
	}

	// Build ogen server with our custom error handler (same as production).
	s := store.New()
	h := handler.New(validator, s)
	srv, err := oapi.NewServer(h, h, oapi.WithErrorHandler(handler.ErrorHandler))
	if err != nil {
		t.Fatalf("oapi.NewServer: %v", err)
	}
	env.apiSrv = httptest.NewServer(srv)

	t.Cleanup(func() {
		env.apiSrv.Close()
		env.oidcSrv.Close()
	})
	return env
}

// mintToken creates a signed JWT with the given claims.
func (e *testEnv) mintToken(t *testing.T, claims map[string]interface{}) string {
	t.Helper()
	header := map[string]interface{}{
		"alg": "RS256",
		"typ": "JWT",
		"kid": e.kid,
	}
	return signJWT(t, e.privateKey, header, claims)
}

// mintTokenKID creates a signed JWT with a custom kid.
func (e *testEnv) mintTokenKID(t *testing.T, kid string, claims map[string]interface{}) string {
	t.Helper()
	header := map[string]interface{}{
		"alg": "RS256",
		"typ": "JWT",
		"kid": kid,
	}
	return signJWT(t, e.privateKey, header, claims)
}

func signJWT(t *testing.T, key *rsa.PrivateKey, header, claims map[string]interface{}) string {
	t.Helper()
	hj, _ := json.Marshal(header)
	cj, _ := json.Marshal(claims)
	h64 := base64.RawURLEncoding.EncodeToString(hj)
	c64 := base64.RawURLEncoding.EncodeToString(cj)
	msg := h64 + "." + c64
	h := sha256.New()
	h.Write([]byte(msg))
	digest := h.Sum(nil)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest)
	if err != nil {
		t.Fatalf("sign JWT: %v", err)
	}
	return msg + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func validClaims(issuer, aud, sub, email string) map[string]interface{} {
	now := time.Now()
	return map[string]interface{}{
		"iss":    issuer,
		"aud":    []string{aud},
		"sub":    sub,
		"email":  email,
		"name":   "Alice Admin",
		"groups": []string{"admins"},
		"iat":    now.Unix(),
		"exp":    now.Add(time.Hour).Unix(),
	}
}

// do sends an HTTP request to the api server with optional extra headers.
func (e *testEnv) do(t *testing.T, method, path, bearer string, extraHeaders map[string]string, body string) *http.Response {
	t.Helper()
	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, e.apiSrv.URL+path, bodyReader)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	return resp
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestValidToken_GetMe: valid token → 200 with correct claims.
func TestValidToken_GetMe(t *testing.T) {
	env := newTestEnv(t)
	token := env.mintToken(t, validClaims(env.issuer, testAudience, testSub, testEmail))

	resp := env.do(t, "GET", "/api/me", token, nil, "")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/me: got %d, want 200", resp.StatusCode)
	}

	var u oapi.User
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		t.Fatalf("decode User: %v", err)
	}
	if u.Sub != testSub {
		t.Errorf("sub: got %q, want %q", u.Sub, testSub)
	}
	if u.Email != testEmail {
		t.Errorf("email: got %q, want %q", u.Email, testEmail)
	}
	if !u.IsAdmin.Value || !u.IsAdmin.Set {
		t.Error("expected is_admin=true for groups=[admins]")
	}
}

// TestValidToken_Todos: valid token → todos are user-scoped.
func TestValidToken_Todos(t *testing.T) {
	env := newTestEnv(t)
	token := env.mintToken(t, validClaims(env.issuer, testAudience, testSub, testEmail))

	// Create a todo.
	resp := env.do(t, "POST", "/api/todos", token, nil, `{"title":"Test todo"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST /api/todos: got %d, want 201; body: %s", resp.StatusCode, body)
	}

	var created oapi.Todo
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode Todo: %v", err)
	}
	if created.Owner != testSub {
		t.Errorf("todo owner: got %q, want %q", created.Owner, testSub)
	}

	// List todos.
	listResp := env.do(t, "GET", "/api/todos", token, nil, "")
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/todos: got %d, want 200", listResp.StatusCode)
	}
	var todos []oapi.Todo
	if err := json.NewDecoder(listResp.Body).Decode(&todos); err != nil {
		t.Fatalf("decode todos: %v", err)
	}
	if len(todos) == 0 {
		t.Fatal("expected at least one todo")
	}
	for _, td := range todos {
		if td.Owner != testSub {
			t.Errorf("todo %q owned by %q, want %q", td.ID, td.Owner, testSub)
		}
	}

	// Get the specific todo.
	getResp := env.do(t, "GET", "/api/todos/"+created.ID, token, nil, "")
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/todos/%s: got %d, want 200", created.ID, getResp.StatusCode)
	}
}

// TestUserScoping: two users have isolated todo lists.
func TestUserScoping(t *testing.T) {
	env := newTestEnv(t)

	subAlice := "sub-alice-001"
	subBob := "sub-bob-002"

	aliceToken := env.mintToken(t, validClaims(env.issuer, testAudience, subAlice, "alice@example.com"))
	bobToken := env.mintToken(t, validClaims(env.issuer, testAudience, subBob, "bob@example.com"))

	// Alice creates a todo.
	r := env.do(t, "POST", "/api/todos", aliceToken, nil, `{"title":"Alice's secret task"}`)
	defer r.Body.Close()
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("Alice POST /api/todos: got %d", r.StatusCode)
	}
	var aliceTodo oapi.Todo
	_ = json.NewDecoder(r.Body).Decode(&aliceTodo)

	// Bob cannot see Alice's todo by ID.
	r2 := env.do(t, "GET", "/api/todos/"+aliceTodo.ID, bobToken, nil, "")
	defer r2.Body.Close()
	if r2.StatusCode != http.StatusNotFound {
		t.Errorf("Bob GET Alice's todo: got %d, want 404", r2.StatusCode)
	}

	// Bob's list is empty.
	r3 := env.do(t, "GET", "/api/todos", bobToken, nil, "")
	defer r3.Body.Close()
	var bobTodos []oapi.Todo
	_ = json.NewDecoder(r3.Body).Decode(&bobTodos)
	if len(bobTodos) != 0 {
		t.Errorf("Bob's todo list should be empty, got %d todos", len(bobTodos))
	}
}

// TestNoAuthHeader: missing Authorization header → 401.
func TestNoAuthHeader(t *testing.T) {
	env := newTestEnv(t)
	resp := env.do(t, "GET", "/api/me", "", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no auth header: got %d, want 401", resp.StatusCode)
	}
}

// TestNoAuthHeader_Todos: missing header on todos → 401.
func TestNoAuthHeader_Todos(t *testing.T) {
	env := newTestEnv(t)
	resp := env.do(t, "GET", "/api/todos", "", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no auth header on /api/todos: got %d, want 401", resp.StatusCode)
	}
}

// TestMalformedToken: garbage in Authorization → 401.
func TestMalformedToken(t *testing.T) {
	env := newTestEnv(t)
	resp := env.do(t, "GET", "/api/me", "not-a-jwt-at-all", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("malformed token: got %d, want 401", resp.StatusCode)
	}
}

// TestWrongScheme: "Token xyz" instead of "Bearer xyz" → 401.
// (ogen extracts the Bearer token from Authorization: Bearer <tok>; wrong scheme = no token = 401.)
func TestWrongScheme(t *testing.T) {
	env := newTestEnv(t)
	token := env.mintToken(t, validClaims(env.issuer, testAudience, testSub, testEmail))

	req, _ := http.NewRequest("GET", env.apiSrv.URL+"/api/me", nil)
	req.Header.Set("Authorization", "Token "+token) // wrong scheme
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong scheme: got %d, want 401", resp.StatusCode)
	}
}

// TestExpiredToken: exp in the past → 401.
func TestExpiredToken(t *testing.T) {
	env := newTestEnv(t)
	c := validClaims(env.issuer, testAudience, testSub, testEmail)
	c["exp"] = time.Now().Add(-time.Hour).Unix()
	token := env.mintToken(t, c)

	resp := env.do(t, "GET", "/api/me", token, nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired token: got %d, want 401", resp.StatusCode)
	}
}

// TestNBFInFuture: nbf in the future → 401.
func TestNBFInFuture(t *testing.T) {
	env := newTestEnv(t)
	c := validClaims(env.issuer, testAudience, testSub, testEmail)
	c["nbf"] = time.Now().Add(time.Hour).Unix()
	token := env.mintToken(t, c)

	resp := env.do(t, "GET", "/api/me", token, nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("nbf-future token: got %d, want 401", resp.StatusCode)
	}
}

// TestWrongIssuer: iss doesn't match → 401.
func TestWrongIssuer(t *testing.T) {
	env := newTestEnv(t)
	c := validClaims("http://evil.attacker.com/", testAudience, testSub, testEmail)
	token := env.mintToken(t, c)

	resp := env.do(t, "GET", "/api/me", token, nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong issuer: got %d, want 401", resp.StatusCode)
	}
}

// TestWrongAudience: aud does not contain poc-api → 401.
func TestWrongAudience(t *testing.T) {
	env := newTestEnv(t)
	c := validClaims(env.issuer, "wrong-audience", testSub, testEmail)
	token := env.mintToken(t, c)

	resp := env.do(t, "GET", "/api/me", token, nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong audience: got %d, want 401", resp.StatusCode)
	}
}

// TestUnknownKID: valid signature but kid not in JWKS → 401.
func TestUnknownKID(t *testing.T) {
	env := newTestEnv(t)
	c := validClaims(env.issuer, testAudience, testSub, testEmail)
	token := env.mintTokenKID(t, "unknown-kid-9999", c)

	resp := env.do(t, "GET", "/api/me", token, nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown kid: got %d, want 401", resp.StatusCode)
	}
}

// TestSpoofedHeaderNoBearer: X-authentik-email without any Bearer token → 401.
// Proves that proxy identity headers are not trusted as authentication.
func TestSpoofedHeaderNoBearer(t *testing.T) {
	env := newTestEnv(t)
	resp := env.do(t, "GET", "/api/me", "", map[string]string{
		"X-authentik-email":    "attacker@evil.com",
		"X-authentik-username": "attacker",
		"X-authentik-groups":   "admins",
	}, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("spoofed X-authentik headers without bearer: got %d, want 401", resp.StatusCode)
	}
}

// TestSpoofedHeaderWithValidToken: spoofed X-authentik-email WITH a valid token for a
// different user → header must be ignored; identity comes from the token.
func TestSpoofedHeaderWithValidToken(t *testing.T) {
	env := newTestEnv(t)

	realSub := "real-user-sub-456"
	realEmail := "real@example.com"
	token := env.mintToken(t, validClaims(env.issuer, testAudience, realSub, realEmail))

	resp := env.do(t, "GET", "/api/me", token, map[string]string{
		"X-authentik-email": "attacker@evil.com",
		"X-authentik-sub":   "attacker-sub",
	}, "")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid token with spoofed header: got %d, want 200", resp.StatusCode)
	}

	var u oapi.User
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		t.Fatalf("decode User: %v", err)
	}
	// Identity MUST come from the token, not the spoofed header.
	if u.Email == "attacker@evil.com" {
		t.Error("spoofed X-authentik-email was used as identity — SECURITY FAILURE")
	}
	if u.Email != realEmail {
		t.Errorf("email: got %q, want %q (from token)", u.Email, realEmail)
	}
	if u.Sub != realSub {
		t.Errorf("sub: got %q, want %q (from token)", u.Sub, realSub)
	}
}

// TestErrorBodyIsJSON: 401 response must be JSON with an error field, no token content.
func TestErrorBodyIsJSON(t *testing.T) {
	env := newTestEnv(t)
	resp := env.do(t, "GET", "/api/me", "", nil, "")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type: got %q, want application/json", ct)
	}

	var e oapi.Error
	if err := json.NewDecoder(resp.Body).Decode(&e); err != nil {
		t.Fatalf("401 body not JSON: %v", err)
	}
	if e.Error == "" {
		t.Error("401 error field is empty")
	}
}
