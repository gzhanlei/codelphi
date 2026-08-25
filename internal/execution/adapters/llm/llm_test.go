package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateRejectsSchemaViolation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "教学目标") {
			t.Errorf("prompt missing design schema: %s", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": `{"随便":"一段不合 schema 的 JSON"}`}}},
			"usage":   map[string]int64{"prompt_tokens": 10, "completion_tokens": 20},
		})
	}))
	t.Cleanup(srv.Close)

	_, err := New(srv.URL, "test-model", "").Generate(context.Background(), GenerateRequest{
		Kind: KindDesign, Title: "导数", Materials: []string{"差商的极限"},
	})
	if !errors.Is(err, ErrSchema) {
		t.Fatalf("err = %v, want ErrSchema", err)
	}
}
