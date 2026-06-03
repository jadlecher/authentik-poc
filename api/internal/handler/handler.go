// Package handler implements the ogen-generated Handler and SecurityHandler interfaces.
//
// Security design:
//   - HandleBearerAuth validates the JWT, stores claims in context, returns 401 on any failure.
//   - Handlers retrieve claims from context — they never touch HTTP headers directly.
//   - X-authentik-* headers are ignored. Identity comes ONLY from JWT claims.
//
// CORS: Not implemented. The SPA and API share origin app.localhost:8000 (CONTRACT §2),
// so no CORS headers are needed. Adding permissive CORS would broaden the attack surface
// with zero benefit for same-origin requests.
//
// Persistence: Todos are stored in-memory (see internal/store). They are NOT persisted
// across restarts. This is intentional for the PoC.
package handler

import (
	"context"
	"fmt"

	"github.com/poc/authentik-poc/api/internal/auth"
	"github.com/poc/authentik-poc/api/internal/oapi"
	"github.com/poc/authentik-poc/api/internal/store"
)

// Handler implements oapi.Handler and oapi.SecurityHandler.
type Handler struct {
	validator *auth.Validator
	store     *store.Store
}

// New creates a new Handler with the given Validator and Store.
func New(v *auth.Validator, s *store.Store) *Handler {
	return &Handler{validator: v, store: s}
}

// ---------------------------------------------------------------------------
// SecurityHandler implementation
// ---------------------------------------------------------------------------

// HandleBearerAuth is called by the ogen-generated server for every operation
// that declares bearerAuth security. It validates the JWT, extracts claims, and
// stores them in the context for downstream handlers.
//
// On ANY failure → returns an error that ogen translates to 401.
// NEVER logs or echoes the token.
func (h *Handler) HandleBearerAuth(ctx context.Context, operationName oapi.OperationName, t oapi.BearerAuth) (context.Context, error) {
	if t.Token == "" {
		return ctx, fmt.Errorf("missing bearer token")
	}

	claims, err := h.validator.ValidateBearer(ctx, t.Token)
	if err != nil {
		// Do not include validation details in the returned error — they will
		// appear in the 401 response body and could leak information.
		return ctx, fmt.Errorf("unauthorized")
	}

	return auth.WithClaims(ctx, claims), nil
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

// GetMe implements GET /api/me.
// Returns the authenticated user's profile from JWT claims.
func (h *Handler) GetMe(ctx context.Context) (oapi.GetMeRes, error) {
	c := auth.ClaimsFromContext(ctx)
	if c == nil {
		return &oapi.Error{Error: "unauthorized"}, nil
	}

	u := &oapi.User{
		Sub:    c.Sub,
		Email:  c.Email,
		Name:   c.Name,
		Groups: c.Groups,
	}
	if c.IsAdmin() {
		u.SetIsAdmin(oapi.OptBool{Value: true, Set: true})
	}
	return u, nil
}

// ListTodos implements GET /api/todos.
// Returns todos owned by the authenticated user (scoped by JWT sub).
func (h *Handler) ListTodos(ctx context.Context) (oapi.ListTodosRes, error) {
	c := auth.ClaimsFromContext(ctx)
	if c == nil {
		return &oapi.Error{Error: "unauthorized"}, nil
	}

	todos := h.store.ListForUser(c.Sub)
	result := make(oapi.ListTodosOKApplicationJSON, 0, len(todos))
	for _, t := range todos {
		result = append(result, oapi.Todo{
			ID:    t.ID,
			Title: t.Title,
			Done:  t.Done,
			Owner: t.Owner,
		})
	}
	return &result, nil
}

// CreateTodo implements POST /api/todos.
// Creates a new todo. Owner is set to JWT sub — callers cannot spoof ownership.
func (h *Handler) CreateTodo(ctx context.Context, req *oapi.CreateTodoRequest) (oapi.CreateTodoRes, error) {
	c := auth.ClaimsFromContext(ctx)
	if c == nil {
		return &oapi.CreateTodoUnauthorized{Error: "unauthorized"}, nil
	}

	done := false
	if req.Done.Set {
		done = req.Done.Value
	}

	t := h.store.Create(c.Sub, req.Title, done)
	return &oapi.Todo{
		ID:    t.ID,
		Title: t.Title,
		Done:  t.Done,
		Owner: t.Owner,
	}, nil
}

// GetTodo implements GET /api/todos/{id}.
// Returns the todo only if it exists and is owned by the authenticated user.
// Returns 404 for not-found or wrong-owner (ownership not leaked).
func (h *Handler) GetTodo(ctx context.Context, params oapi.GetTodoParams) (oapi.GetTodoRes, error) {
	c := auth.ClaimsFromContext(ctx)
	if c == nil {
		return &oapi.GetTodoUnauthorized{Error: "unauthorized"}, nil
	}

	t := h.store.GetForUser(params.ID, c.Sub)
	if t == nil {
		return &oapi.GetTodoNotFound{Error: "not found"}, nil
	}
	return &oapi.Todo{
		ID:    t.ID,
		Title: t.Title,
		Done:  t.Done,
		Owner: t.Owner,
	}, nil
}
