package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/ogen-go/ogen/ogenerrors"
)

// ErrorHandler is a custom ogen ErrorHandler that returns our standard
// {"error": "..."} JSON body for all framework-level errors (security failures,
// validation errors, etc.).
//
// Security properties:
//   - Does NOT echo the token or any claim in the error message.
//   - Converts SecurityError → generic "unauthorized" message.
//   - Converts all other ogen errors to their HTTP status code with a safe message.
func ErrorHandler(ctx context.Context, w http.ResponseWriter, r *http.Request, err error) {
	code := ogenerrors.ErrorCode(err)

	// Determine a safe, generic message. Never include token content.
	msg := httpStatusMessage(code)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func httpStatusMessage(code int) string {
	switch code {
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not found"
	case http.StatusBadRequest:
		return "bad request"
	case http.StatusMethodNotAllowed:
		return "method not allowed"
	case http.StatusUnsupportedMediaType:
		return "unsupported media type"
	case http.StatusNotImplemented:
		return "not implemented"
	default:
		return "internal server error"
	}
}
