// Package llm 是 design/outline 构件的 LLM adapter（设计 §2.1：无姐妹平台可接，
// 网关直连 LLM vendor，capability 记 design/outline）。
// OpenAI 兼容 chat completions；vendor 在配置里显式、可换（默认 DeepSeek，招标合规最低线）。
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Kind 是构件类型，决定提示词与输出 schema。
type Kind string

const (
	KindDesign  Kind = "design"
	KindOutline Kind = "outline"
)

// Client 是 OpenAI 兼容 chat completions 客户端。
type Client struct {
	baseURL string
	model   string
	apiKey  string
	http    *http.Client
}

// Option 覆盖默认（测试指向 httptest server）。
type Option func(*Client)

func WithHTTPClient(c *http.Client) Option { return func(cl *Client) { cl.http = c } }

// New baseURL 例：https://api.deepseek.com；apiKey 为空时仍可构造（本地 stub 用），
// 真实 vendor 必须配 key，否则 401 走 step failed。
func New(baseURL, model, apiKey string, opts ...Option) *Client {
	c := &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		model:   model,
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 120 * time.Second},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// GenerateRequest 是一次构件生成的输入。Materials 是材料纯文本
// （pdf/docx/image 的文本提取不在本工单，由 execution 层先行拒绝）。
type GenerateRequest struct {
	Kind      Kind
	Title     string   // 章标题
	Materials []string // 材料文本
	Note      string   // 教师补充说明（表单字段，不是聊天）
	Critique  string   // 返工意见（Rebuild 时非空）
}

// GenerateResult 是解析并校验过 schema 的产出。
type GenerateResult struct {
	JSON             json.RawMessage // 有 schema 的结构化产出
	Markdown         string          // 渲染给人看的版本
	PromptTokens     int64
	CompletionTokens int64
}

// design 必须含的键（提示词约束 + 解析后校验，缺键 = step failed）。
var designKeys = []string{"教学目标", "学情", "重难点", "方法", "流程"}

// ErrSchema 是产出不符合 schema 的错误（step failed，不重试）。
var ErrSchema = errors.New("llm: output schema violation")

func (c *Client) Generate(ctx context.Context, in GenerateRequest) (*GenerateResult, error) {
	body := map[string]any{
		"model":           c.model,
		"messages":        buildMessages(in),
		"response_format": map[string]string{"type": "json_object"},
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("llm: request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("llm: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("llm: decode response: %w", err)
	}
	if len(out.Choices) == 0 {
		return nil, errors.New("llm: empty choices")
	}
	content := out.Choices[0].Message.Content

	// 解析 + schema 校验；失败即 step failed（ErrSchema），不做自由 Markdown 兜底。
	var doc map[string]any
	if err := json.Unmarshal([]byte(content), &doc); err != nil {
		return nil, fmt.Errorf("%w: not JSON: %v", ErrSchema, err)
	}
	if err := validateSchema(in.Kind, doc); err != nil {
		return nil, err
	}
	return &GenerateResult{
		JSON:             json.RawMessage(content),
		Markdown:         renderMarkdown(in.Kind, in.Title, doc),
		PromptTokens:     out.Usage.PromptTokens,
		CompletionTokens: out.Usage.CompletionTokens,
	}, nil
}

func validateSchema(kind Kind, doc map[string]any) error {
	switch kind {
	case KindDesign:
		for _, k := range designKeys {
			if _, ok := doc[k]; !ok {
				return fmt.Errorf("%w: design 缺键 %q", ErrSchema, k)
			}
		}
	case KindOutline:
		items, ok := doc["条目"].([]any)
		if !ok || len(items) == 0 {
			return fmt.Errorf("%w: outline 缺非空「条目」数组", ErrSchema)
		}
	default:
		return fmt.Errorf("llm: unknown kind %q", kind)
	}
	return nil
}

func buildMessages(in GenerateRequest) []map[string]string {
	var schemaHint string
	switch in.Kind {
	case KindDesign:
		schemaHint = `输出 JSON 对象，必须含键：教学目标（字符串数组）、学情（字符串）、重难点（字符串数组）、方法（字符串数组）、流程（数组，元素含 环节/时长/活动 三键）。`
	case KindOutline:
		schemaHint = `输出 JSON 对象，必须含键：条目（数组，元素含 节/标题/要点 三键），按节列出整章课纲。`
	}
	var sb strings.Builder
	sb.WriteString("章标题：" + in.Title + "\n\n")
	for i, m := range in.Materials {
		fmt.Fprintf(&sb, "## 材料 %d\n%s\n\n", i+1, m)
	}
	if in.Note != "" {
		sb.WriteString("## 教师补充说明\n" + in.Note + "\n\n")
	}
	if in.Critique != "" {
		sb.WriteString("## 返工修改意见（本次重做的依据）\n" + in.Critique + "\n\n")
	}
	sb.WriteString(schemaHint)
	return []map[string]string{
		{"role": "system", "content": "你是课程设计专家。只输出 JSON，不要输出任何其它文字。"},
		{"role": "user", "content": sb.String()},
	}
}

// renderMarkdown 把结构化产出渲染成给人看的 Markdown（与 JSON 一并落存储）。
func renderMarkdown(kind Kind, title string, doc map[string]any) string {
	var sb strings.Builder
	sb.WriteString("# " + title + "\n\n")
	switch kind {
	case KindDesign:
		for _, k := range designKeys {
			fmt.Fprintf(&sb, "## %s\n\n%s\n\n", k, mdValue(doc[k]))
		}
	case KindOutline:
		sb.WriteString("## 条目\n\n" + mdValue(doc["条目"]) + "\n")
	}
	return sb.String()
}

func mdValue(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, item := range t {
			if m, ok := item.(map[string]any); ok {
				parts := make([]string, 0, len(m))
				for k, val := range m {
					parts = append(parts, fmt.Sprintf("%s：%v", k, val))
				}
				sb.WriteString("- " + strings.Join(parts, "；") + "\n")
			} else {
				fmt.Fprintf(&sb, "- %v\n", item)
			}
		}
		return sb.String()
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
