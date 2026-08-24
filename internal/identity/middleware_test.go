package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 中间件：无头 401、坏 token 401、org_mismatch 403 且 body 带 reason、合法请求透出 Context。
func TestMiddleware(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, _ := jwksServer(t, &key.PublicKey)
	verifier := NewVerifier(srv.URL, testIssuer, testClientID)
	resolver := newResolver()

	resetTables(t)
	orgID, memberID := ulidStr(), ulidStr()
	insertOrg(t, orgID, "active")
	insertMember(t, memberID, orgID, "sub-1", "active")

	var gotCtx *Context
	handler := Middleware(verifier, resolver)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCtx, _ = ContextFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	t.Run("missing header → 401", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("code = %d, want 401", rec.Code)
		}
	})

	t.Run("bad token → 401", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer not-a-jwt")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("code = %d, want 401", rec.Code)
		}
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error.Code != "invalid_token" {
			t.Fatalf("code = %q", body.Error.Code)
		}
	})

	t.Run("org_mismatch → 403 带 reason", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+signToken(t, key, testKid, validClaims("sub-1")))
		req.Header.Set("X-Org-Id", ulidStr())
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403", rec.Code)
		}
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error.Code != ReasonOrgMismatch {
			t.Fatalf("code = %q, want %s", body.Error.Code, ReasonOrgMismatch)
		}
	})

	t.Run("valid token → 200 且 Context 透出", func(t *testing.T) {
		gotCtx = nil
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+signToken(t, key, testKid, validClaims("sub-1")))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("code = %d, want 200", rec.Code)
		}
		if gotCtx == nil || gotCtx.MemberID != memberID || gotCtx.OrgID != orgID {
			t.Fatalf("ctx = %+v", gotCtx)
		}
	})
}
