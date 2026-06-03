// Package store provides an in-memory todo store.
//
// IMPORTANT: The store is NOT persistent. All todos are lost on process restart.
// This is intentional for the PoC — the goal is to demonstrate per-user isolation
// (todos are scoped by JWT sub claim), not durability.
package store

import (
	"sync"

	"github.com/google/uuid"
)

// Todo represents a single todo item.
type Todo struct {
	ID    string
	Title string
	Done  bool
	Owner string // JWT sub claim of the owning user
}

// Store is a thread-safe in-memory store for todos, keyed by user sub.
type Store struct {
	mu    sync.RWMutex
	todos map[string]*Todo // key: todo ID
}

// New creates an empty Store.
func New() *Store {
	return &Store{todos: make(map[string]*Todo)}
}

// Create adds a new todo for the given user and returns it.
func (s *Store) Create(owner, title string, done bool) *Todo {
	t := &Todo{
		ID:    uuid.New().String(),
		Title: title,
		Done:  done,
		Owner: owner,
	}
	s.mu.Lock()
	s.todos[t.ID] = t
	s.mu.Unlock()
	return t
}

// ListForUser returns all todos owned by the given sub.
func (s *Store) ListForUser(sub string) []*Todo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Todo
	for _, t := range s.todos {
		if t.Owner == sub {
			out = append(out, t)
		}
	}
	return out
}

// GetForUser returns the todo with the given id if it is owned by sub.
// Returns nil if the todo does not exist or belongs to a different user.
// Ownership is not leaked: the caller gets the same nil for "not found" and "wrong owner".
func (s *Store) GetForUser(id, sub string) *Todo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.todos[id]
	if !ok || t.Owner != sub {
		return nil
	}
	return t
}
