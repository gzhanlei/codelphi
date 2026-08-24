package identity

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Claims 是 chandler access token 里网关关心的最小集合（设计 §5）。
type Claims struct {
	Sub string
	Iss string
	Aud []string
	Exp time.Time
}

// ErrInvalidToken：验签/claims 校验失败的统一哨兵，中间件据此回 401。
var ErrInvalidToken = errors.New("identity: invalid token")

// Verifier 校验 chandler 签发的 RS256 JWT。
// JWKS 进程内缓存（默认 5 分钟），拉取失败保留旧缓存并告警（设计 §5）。
type Verifier struct {
	jwksURL  string
	issuer   string // iss 按字符串比对，不当 URL 解析
	clientID string // aud 必须等于它——防其他合作方 token 打进来
	ttl      time.Duration
	client   *http.Client

	mu        sync.RWMutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

// VerifierOption 主要用于测试（覆盖 http client / 缓存 TTL）。
type VerifierOption func(*Verifier)

func WithHTTPClient(c *http.Client) VerifierOption {
	return func(v *Verifier) { v.client = c }
}

func WithJWKSCacheTTL(ttl time.Duration) VerifierOption {
	return func(v *Verifier) { v.ttl = ttl }
}

// NewVerifier jwksURL/issuer/clientID 来自 config（CHANDLER_JWKS_URL / CHANDLER_ISSUER / CHANDLER_CLIENT_ID）。
func NewVerifier(jwksURL, issuer, clientID string, opts ...VerifierOption) *Verifier {
	v := &Verifier{
		jwksURL:  jwksURL,
		issuer:   issuer,
		clientID: clientID,
		ttl:      5 * time.Minute,
		client:   &http.Client{Timeout: 10 * time.Second},
		keys:     make(map[string]*rsa.PublicKey),
	}
	for _, o := range opts {
		o(v)
	}
	return v
}

// Parse 验签并校验 iss/aud/exp；kid 未命中时强制刷新一次 JWKS 再试（密钥轮换场景）。
func (v *Verifier) Parse(tokenString string) (*Claims, error) {
	t, err := parseCompactJWS(tokenString)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if alg, _ := t.header["alg"].(string); alg != "RS256" {
		return nil, fmt.Errorf("%w: unsupported alg %q", ErrInvalidToken, t.header["alg"])
	}
	kid, _ := t.header["kid"].(string)
	if kid == "" {
		return nil, fmt.Errorf("%w: missing kid", ErrInvalidToken)
	}

	pub, err := v.key(kid)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	digest := sha256.Sum256([]byte(t.signingInput))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], t.signature); err != nil {
		return nil, fmt.Errorf("%w: bad signature", ErrInvalidToken)
	}

	claims := &Claims{
		Sub: stringClaim(t.claims, "sub"),
		Iss: stringClaim(t.claims, "iss"),
		Aud: audClaim(t.claims),
	}
	if claims.Sub == "" {
		return nil, fmt.Errorf("%w: missing sub", ErrInvalidToken)
	}
	exp, ok := int64Claim(t.claims, "exp")
	if !ok {
		return nil, fmt.Errorf("%w: missing exp", ErrInvalidToken)
	}
	claims.Exp = time.Unix(exp, 0)
	if time.Now().Unix() >= exp {
		return nil, fmt.Errorf("%w: token expired", ErrInvalidToken)
	}
	if claims.Iss != v.issuer {
		return nil, fmt.Errorf("%w: iss mismatch", ErrInvalidToken)
	}
	if v.clientID != "" && !contains(claims.Aud, v.clientID) {
		return nil, fmt.Errorf("%w: aud mismatch", ErrInvalidToken)
	}
	return claims, nil
}

// key 取 kid 对应的公钥。缓存新鲜直接用；过期先尝试刷新，失败则留旧缓存（告警）；
// kid 未命中强制刷新一次再试，仍不命中才失败。
func (v *Verifier) key(kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	k, ok := v.keys[kid]
	fresh := !v.fetchedAt.IsZero() && time.Since(v.fetchedAt) < v.ttl
	v.mu.RUnlock()

	if ok && fresh {
		return k, nil
	}
	if err := v.refresh(); err != nil {
		// 拉取失败：留旧缓存。kid 已知则降级放行，未知只能失败。
		log.Printf("identity: JWKS refresh failed, serving stale cache: %v", err)
		if ok {
			return k, nil
		}
		return nil, err
	}
	v.mu.RLock()
	k, ok = v.keys[kid]
	v.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown kid %q", kid)
	}
	return k, nil
}

const maxJWKSBytes = 1 << 20

func (v *Verifier) refresh() error {
	req, err := http.NewRequest(http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := v.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks endpoint returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJWKSBytes))
	if err != nil {
		return err
	}
	var doc jwksDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return fmt.Errorf("decode jwks: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey)
	for _, j := range doc.Keys {
		if j.Kty != "RSA" || j.Kid == "" {
			continue
		}
		if pub, err := j.rsaPublicKey(); err == nil {
			keys[j.Kid] = pub
		}
	}
	v.mu.Lock()
	v.keys = keys
	v.fetchedAt = time.Now()
	v.mu.Unlock()
	return nil
}

// --- 以下是紧凑 JWS 的纯标准库解析（参考 WorkMembership tools/mcp-spike） ---

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksDoc struct {
	Keys []jwk `json:"keys"`
}

// rsaPublicKey 把 JWK 的 base64url n/e（无符号大端整数）还原成 RSA 公钥。
func (j jwk) rsaPublicKey() (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(j.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(j.E)
	if err != nil {
		return nil, err
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 | int(b)
	}
	if e == 0 {
		return nil, errors.New("invalid exponent")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}, nil
}

type compactJWS struct {
	header       map[string]any
	claims       map[string]any
	signingInput string
	signature    []byte
}

func parseCompactJWS(token string) (*compactJWS, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("not a compact JWS")
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	header, err := decodeJSONMap(headerJSON)
	if err != nil {
		return nil, err
	}
	claims, err := decodeJSONMap(claimsJSON)
	if err != nil {
		return nil, err
	}
	return &compactJWS{header: header, claims: claims, signingInput: parts[0] + "." + parts[1], signature: sig}, nil
}

// decodeJSONMap 用 json.Number 保精度（exp 是数值）。
func decodeJSONMap(data []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

func stringClaim(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// audClaim 兼容 aud 为字符串或字符串数组两种形态。
func audClaim(m map[string]any) []string {
	switch v := m["aud"].(type) {
	case string:
		return []string{v}
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func int64Claim(m map[string]any, key string) (int64, bool) {
	switch n := m[key].(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i, true
		}
		if f, err := n.Float64(); err == nil {
			return int64(f), true
		}
	case float64:
		return int64(n), true
	}
	return 0, false
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
