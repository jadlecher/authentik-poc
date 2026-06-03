// Package auth provides JWT validation for the authentik-poc API.
//
// All validation is fail-closed: any error returns 401.
// Tokens are NEVER logged or echoed in error responses.
//
// Identity comes ONLY from validated JWT claims.
// X-authentik-* headers (or any proxy identity header) are explicitly ignored.
package auth

import (
	"context"
	"slices"
)

// contextKey is an unexported type for context keys in this package.
type contextKey int

const claimsKey contextKey = 0

// Claims holds the validated JWT claims extracted for a request.
// All fields are populated from the JWT — never from HTTP headers.
type Claims struct {
	Sub    string   // sub: stable opaque user ID
	Email  string   // email claim
	Name   string   // name claim (may be empty; falls back to preferred_username)
	Groups []string // groups claim array
}

// IsAdmin returns true if the user is in the "admins" group.
func (c *Claims) IsAdmin() bool {
	return slices.Contains(c.Groups, "admins")
}

// WithClaims stores validated claims in a context.
func WithClaims(ctx context.Context, c *Claims) context.Context {
	return context.WithValue(ctx, claimsKey, c)
}

// ClaimsFromContext retrieves validated claims from context.
// Returns nil if no claims are stored (unauthenticated request).
func ClaimsFromContext(ctx context.Context) *Claims {
	v, _ := ctx.Value(claimsKey).(*Claims)
	return v
}
