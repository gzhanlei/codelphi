package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type ctxKey struct{}

// ContextFrom 取中间件塞进 request context 的身份上下文。
func ContextFrom(ctx context.Context) (*Context, bool) {
	c, ok := ctx.Value(ctxKey{}).(*Context)
	return c, ok
}

// Middleware 是身份链的 HTTP 入口（薄层）：
// Authorization: Bearer → 验签（401）→ Resolve（403）→ Context 塞 request context。
// X-Org-Id/X-Unit-Id 以请求头为准，绝不接受模型填写（设计 §5）。
func Middleware(verifier *Verifier, resolver *Resolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || token == "" {
				writeErr(w, http.StatusUnauthorized, "missing_token", "missing or malformed Authorization header")
				return
			}
			claims, err := verifier.Parse(token)
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid_token", "token verification failed")
				return
			}
			ictx, err := resolver.Resolve(r.Context(), claims.Sub, r.Header.Get("X-Org-Id"), r.Header.Get("X-Unit-Id"))
			if err != nil {
				var re *ResolveError
				if errors.As(err, &re) {
					// 租户隔离类（org_mismatch/unit_mismatch）按 §5 记安全日志由调用方/日志中间件统一做；
					// 这里保证 reason 进响应体，错误面即 agent 引导脚本。
					writeErr(w, http.StatusForbidden, re.Reason, re.Detail)
					return
				}
				writeErr(w, http.StatusInternalServerError, "identity_unavailable", "identity resolution failed")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, ictx)))
		})
	}
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
