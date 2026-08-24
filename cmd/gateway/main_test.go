package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codelphi/internal/storage"
)

func TestMediaHandlerPPTXNotSniffedAsZip(t *testing.T) {
	store := storage.NewLocal(t.TempDir(), "test-key")
	key := "org/x/package/p/ppt-v1.pptx"
	body := []byte("PK\x03\x04fake-pptx")
	if err := store.Put(context.Background(), key, bytes.NewReader(body), ""); err != nil {
		t.Fatal(err)
	}
	signed, err := store.SignGet(context.Background(), key, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	mediaHandler(store).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, signed, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	ct := rec.Header().Get("Content-Type")
	if !strings.Contains(ct, "presentationml.presentation") {
		t.Errorf("Content-Type = %q, want pptx MIME", ct)
	}
	if strings.Contains(strings.ToLower(ct), "zip") {
		t.Errorf("Content-Type sniffed as zip: %q", ct)
	}
	cd := rec.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd, "attachment;") || !strings.Contains(cd, "ppt-v1.pptx") {
		t.Errorf("Content-Disposition = %q", cd)
	}
	if rec.Body.String() != string(body) {
		t.Errorf("body mismatch")
	}
}
