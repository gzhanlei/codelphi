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

func TestGeneratePlanRequiresOutcomesNotTitles(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		prompt := string(body)
		if !strings.Contains(prompt, "达到什么水平") || !strings.Contains(prompt, "禁止把课件页标题") {
			t.Errorf("plan prompt missing outcome rules: %s", prompt)
		}
		if !strings.Contains(prompt, "## 课文") || !strings.Contains(prompt, "课本正文") {
			t.Errorf("plan prompt must take 课文 as source: %s", prompt)
		}
		if strings.Contains(prompt, "根据下面的课件大纲和讲稿整理") {
			t.Errorf("plan prompt still treats 大纲/讲稿 as source: %s", prompt)
		}
		if !strings.Contains(prompt, "仅供对齐教学环节") {
			t.Errorf("outline must be labeled as alignment only: %s", prompt)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": `{"教学目标":["能陈述差商定义，达到会计算简单差商的水平"],"教学重点":["差商作为平均变化率"],"教学难点":["趋近过程易与瞬时变化率混淆"],"教学过程":[{"环节":"导入","教师活动":"从课文实例引入"}],"讲授稿":"从课文里的平均变化率讲起"}`}}},
			"usage":   map[string]int64{"prompt_tokens": 10, "completion_tokens": 20},
		})
	}))
	t.Cleanup(srv.Close)

	got, err := New(srv.URL, "test-model", "").Generate(context.Background(), GenerateRequest{
		Kind: KindPlan, Title: "第 3 章 导数", Materials: []string{"课本正文"}, Outline: `{"slides":[]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got.JSON), "能陈述差商定义") {
		t.Fatalf("json = %s", got.JSON)
	}
}

func TestGeneratePlanRejectsMissingFocus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": `{"教学目标":["能做题"],"教学重点":[],"教学难点":[]}`}}},
			"usage":   map[string]int64{"prompt_tokens": 1, "completion_tokens": 1},
		})
	}))
	t.Cleanup(srv.Close)
	_, err := New(srv.URL, "test-model", "").Generate(context.Background(), GenerateRequest{
		Kind: KindPlan, Title: "导数", Materials: []string{"大纲"},
	})
	if !errors.Is(err, ErrSchema) {
		t.Fatalf("err = %v, want ErrSchema", err)
	}
}

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
