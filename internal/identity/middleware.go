package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type ctxKey struct{}

// DevToken 是本地联调跳过 Chandler 时使用的 Bearer（仅 WithDevAuth 开启时有效）。
const DevToken = "dev"

// ContextFrom 取中间件塞进 request context 的身份上下文。
func ContextFrom(ctx context.Context) (*Context, bool) {
	c, ok := ctx.Value(ctxKey{}).(*Context)
	return c, ok
}

// Middleware 是身份链的 HTTP 入口（薄层）：
// Authorization: Bearer → 验签（401）→ Resolve（403）→ Context 塞 request context。
// X-Org-Id/X-Unit-Id 以请求头为准，绝不接受模型填写（设计 §5）。
func Middleware(verifier *Verifier, resolver *Resolver, opts ...MiddlewareOption) func(http.Handler) http.Handler {
	cfg := middlewareConfig{}
	for _, o := range opts {
		o(&cfg)
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || token == "" {
				writeErr(w, http.StatusUnauthorized, "missing_token", "missing or malformed Authorization header")
				return
			}
			sub, err := Subject(verifier, token, cfg.devSub)
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid_token", "token verification failed")
				return
			}
			ictx, err := resolver.Resolve(r.Context(), sub, r.Header.Get("X-Org-Id"), r.Header.Get("X-Unit-Id"))
			if err != nil {
				var re *ResolveError
				if errors.As(err, &re) {
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

type middlewareConfig struct {
	devSub string
}

// MiddlewareOption 配置身份中间件。
type MiddlewareOption func(*middlewareConfig)

// WithDevAuth 允许 Authorization: Bearer dev 解析为指定 chandler_sub。
// 仅本地联调：生产不得设置 CODELPHI_DEV_AUTH_SUB。
func WithDevAuth(sub string) MiddlewareOption {
	return func(c *middlewareConfig) { c.devSub = strings.TrimSpace(sub) }
}

// Subject 从 Bearer 取出 chandler sub。devSub 非空且 token 为 DevToken 时跳过 JWKS。
func Subject(verifier *Verifier, token, devSub string) (string, error) {
	if strings.TrimSpace(devSub) != "" && token == DevToken {
		return strings.TrimSpace(devSub), nil
	}
	claims, err := verifier.Parse(token)
	if err != nil {
		return "", err
	}
	return claims.Sub, nil
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
