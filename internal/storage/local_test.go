package storage

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSignGetPathEscapesKey(t *testing.T) {
	l := NewLocal(t.TempDir(), "test-key")
	key := "org/x/material/成绩100%.pdf"
	got, err := l.SignGet(context.Background(), key, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse("https://app.example.test" + got)
	if err != nil {
		t.Fatalf("signed url unparseable: %v %q", err, got)
	}
	if u.Fragment != "" {
		t.Fatalf("filename leaked as fragment: %q", got)
	}
	if !strings.Contains(got, "%25") {
		t.Fatalf("expected %% in key to be escaped: %q", got)
	}
	if !strings.Contains(u.Path, "成绩100%.pdf") {
		t.Fatalf("decoded path missing filename: %q path=%q", got, u.Path)
	}
}
