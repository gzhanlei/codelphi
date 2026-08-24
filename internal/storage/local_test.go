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

func TestContentTypeByExt(t *testing.T) {
	tests := []struct {
		key, wantType, wantName string
		attachment              bool
	}{
		{"org/x/package/p/ppt-v1.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "ppt-v1.pptx", true},
		{"org/x/package/p/script-v1.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "script-v1.docx", true},
		{"org/x/package/p/design-v1.json", "application/json", "design-v1.json", false},
		{"org/x/material/a.pdf", "application/pdf", "a.pdf", false},
	}
	for _, tt := range tests {
		if got := ContentType(tt.key); got != tt.wantType {
			t.Errorf("ContentType(%q) = %q, want %q", tt.key, got, tt.wantType)
		}
		if got := Filename(tt.key); got != tt.wantName {
			t.Errorf("Filename(%q) = %q, want %q", tt.key, got, tt.wantName)
		}
		d := ContentDisposition(tt.key)
		if !strings.Contains(d, tt.wantName) {
			t.Errorf("ContentDisposition(%q) = %q, missing %q", tt.key, d, tt.wantName)
		}
		if tt.attachment && !strings.HasPrefix(d, "attachment") {
			t.Errorf("ContentDisposition(%q) = %q, want attachment", tt.key, d)
		}
		if !tt.attachment && strings.HasPrefix(d, "attachment") {
			t.Errorf("ContentDisposition(%q) = %q, want inline (preview)", tt.key, d)
		}
	}
}

func TestContentDispositionUnicodeFilename(t *testing.T) {
	d := ContentDisposition("org/x/material/成绩100%.pdf")
	if strings.HasPrefix(d, "attachment") {
		t.Fatalf("pdf should not force download: %q", d)
	}
	if !strings.Contains(d, "filename") {
		t.Fatalf("missing filename param: %q", d)
	}
}
