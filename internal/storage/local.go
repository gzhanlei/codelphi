package storage

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Local 是本地文件系统驱动：Put/Open 落盘，SignGet 签 HMAC URL，
// 由网关自身的 /media/ 端点校验签名后回源（VerifyLocalSignature）。
type Local struct {
	Dir        string
	SigningKey []byte
}

func NewLocal(dir, signingKey string) *Local {
	return &Local{Dir: dir, SigningKey: []byte(signingKey)}
}

func (l *Local) path(key string) (string, error) {
	clean := filepath.Clean(key)
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		return "", fmt.Errorf("storage: illegal key %q", key)
	}
	return filepath.Join(l.Dir, clean), nil
}

func (l *Local) Put(_ context.Context, key string, r io.Reader, _ string) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, r)
	return err
}

func (l *Local) Open(_ context.Context, key string) (io.ReadCloser, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

// SignGet 生成 "/media/<key>?exp=<unix>&sig=<hmac>"；由网关拼上对外 base URL。
func (l *Local) SignGet(_ context.Context, key string, ttl time.Duration) (string, error) {
	if _, err := l.path(key); err != nil {
		return "", err
	}
	exp := time.Now().Add(ttl).Unix()
	v := url.Values{}
	v.Set("exp", strconv.FormatInt(exp, 10))
	v.Set("sig", l.signature(key, exp))
	return "/media/" + key + "?" + v.Encode(), nil
}

func (l *Local) signature(key string, exp int64) string {
	mac := hmac.New(sha256.New, l.SigningKey)
	fmt.Fprintf(mac, "%s\n%d", key, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyLocalSignature 校验 /media 端点收到的 exp/sig。
func (l *Local) VerifyLocalSignature(key string, exp int64, sig string) bool {
	if time.Now().Unix() > exp {
		return false
	}
	expect := l.signature(key, exp)
	return hmac.Equal([]byte(expect), []byte(sig))
}
