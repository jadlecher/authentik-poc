//go:build tools

// Package tools pins build-time tool dependencies so they appear in go.mod/go.sum.
// This ensures `go generate` uses the exact same ogen version as the runtime code.
//
// Why ogen?
//   - Spec-first: generate server interfaces and client code from OpenAPI 3.x YAML.
//   - Type-safe: every handler has typed request/response structs; no interface{} casts.
//   - Built-in validation: ogen validates incoming requests against the spec before
//     calling your handler — schema constraints, required fields, etc.
//   - No reflection at request time: all dispatch is statically compiled.
//   - SecurityHandler interface: ogen generates a SecurityHandler interface for declared
//     security schemes, making it easy to plug in fail-closed JWT validation.
package tools

import _ "github.com/ogen-go/ogen/cmd/ogen"
