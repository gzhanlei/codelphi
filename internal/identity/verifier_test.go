package identity

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testKid      = "test-key-1"
	testIssuer   = "workmembership"
	testClientID = "cm_aca9bb839faa4a4a96839b389f312636"
)

// signToken 用测试私钥签一张 RS256 紧凑 JWS。
func signToken(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": kid, "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// jwksServer 起一个假 JWKS endpoint，返回公钥；fetchCount 记录被拉取次数。
func jwksServer(t *testing.T, pub *rsa.PublicKey) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	doc := map[string]any{"keys": []map[string]any{{
		"kty": "RSA", "kid": testKid, "use": "sig", "alg": "RS256",
		"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}}}
	var fetches atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	}))
	t.Cleanup(srv.Close)
	return srv, &fetches
}

func validClaims(sub string) map[string]any {
	return map[string]any{
		"sub": sub,
		"iss": testIssuer,
		"aud": testClientID,
		"exp": time.Now().Add(time.Hour).Unix(),
	}
}

func TestVerifierValidToken(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, _ := jwksServer(t, &key.PublicKey)
	v := NewVerifier(srv.URL, testIssuer, testClientID)

	claims, err := v.Parse(signToken(t, key, testKid, validClaims("sub-1")))
	if err != nil {
		t.Fatal(err)
	}
	if claims.Sub != "sub-1" || claims.Iss != testIssuer {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestVerifierBadSignature(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, _ := jwksServer(t, &key.PublicKey)
	v := NewVerifier(srv.URL, testIssuer, testClientID)

	// 用另一把私钥签、kid 指向已发布的公钥。
	_, err := v.Parse(signToken(t, other, testKid, validClaims("sub-1")))
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
}

func TestVerifierIssMismatch(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, _ := jwksServer(t, &key.PublicKey)
	v := NewVerifier(srv.URL, testIssuer, testClientID)

	claims := validClaims("sub-1")
	claims["iss"] = "https://evil.example.com" // iss 按字符串比对，不是 URL
	if _, err := v.Parse(signToken(t, key, testKid, claims)); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
}

func TestVerifierAudMismatch(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, _ := jwksServer(t, &key.PublicKey)
	v := NewVerifier(srv.URL, testIssuer, testClientID)

	claims := validClaims("sub-1")
	claims["aud"] = "cm_someone_else" // 其他合作方的 token 不得打进来
	if _, err := v.Parse(signToken(t, key, testKid, claims)); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
}

func TestVerifierExpired(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, _ := jwksServer(t, &key.PublicKey)
	v := NewVerifier(srv.URL, testIssuer, testClientID)

	claims := validClaims("sub-1")
	claims["exp"] = time.Now().Add(-time.Minute).Unix()
	if _, err := v.Parse(signToken(t, key, testKid, claims)); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
}

// kid 未知：强制刷新一次 JWKS 再试（密钥轮换场景），仍不命中才失败。
func TestVerifierUnknownKidRefreshesOnce(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, fetches := jwksServer(t, &key.PublicKey)
	v := NewVerifier(srv.URL, testIssuer, testClientID)

	// 先让缓存热起来。
	if _, err := v.Parse(signToken(t, key, testKid, validClaims("sub-1"))); err != nil {
		t.Fatal(err)
	}
	before := fetches.Load()

	// 未知 kid：应触发一次强制刷新，然后仍失败。
	if _, err := v.Parse(signToken(t, key, "rotated-key", validClaims("sub-1"))); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
	if got := fetches.Load() - before; got != 1 {
		t.Fatalf("kid 未命中应刷新恰好一次，实际 %d", got)
	}
}

// JWKS 拉取失败：保留旧缓存继续验签（设计 §5 拉失败留旧缓存）。
func TestVerifierStaleCacheOnFetchFailure(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv, _ := jwksServer(t, &key.PublicKey)
	v := NewVerifier(srv.URL, testIssuer, testClientID, WithJWKSCacheTTL(50*time.Millisecond))

	token := signToken(t, key, testKid, validClaims("sub-1"))
	if _, err := v.Parse(token); err != nil {
		t.Fatal(err)
	}

	srv.Close() // JWKS 挂了
	time.Sleep(80 * time.Millisecond)

	if _, err := v.Parse(token); err != nil {
		t.Fatalf("拉取失败应降级到旧缓存放行，got %v", err)
	}
}
