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
	KindPlan    Kind = "plan"
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
	Materials []string // 材料文本；KindPlan 时是课文
	Outline   string   // KindPlan 可选：课件大纲，仅对齐环节，不是教案源
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
	case KindPlan:
		if !nonEmptyStrings(doc["教学目标"]) {
			return fmt.Errorf("%w: plan 缺非空「教学目标」", ErrSchema)
		}
		if !nonEmptyStrings(doc["教学重点"]) {
			return fmt.Errorf("%w: plan 缺非空「教学重点」", ErrSchema)
		}
		if _, ok := doc["教学难点"]; !ok {
			return fmt.Errorf("%w: plan 缺键「教学难点」", ErrSchema)
		}
		proc, ok := doc["教学过程"].([]any)
		if !ok || len(proc) == 0 {
			return fmt.Errorf("%w: plan 缺非空「教学过程」", ErrSchema)
		}
		if s, _ := doc["讲授稿"].(string); strings.TrimSpace(s) == "" {
			return fmt.Errorf("%w: plan 缺「讲授稿」", ErrSchema)
		}
	default:
		return fmt.Errorf("llm: unknown kind %q", kind)
	}
	return nil
}

func nonEmptyStrings(v any) bool {
	arr, ok := v.([]any)
	if !ok || len(arr) == 0 {
		return false
	}
	for _, item := range arr {
		s, ok := item.(string)
		if ok && strings.TrimSpace(s) != "" {
			return true
		}
	}
	return false
}

func buildMessages(in GenerateRequest) []map[string]string {
	var schemaHint string
	switch in.Kind {
	case KindDesign:
		schemaHint = `输出 JSON 对象，必须含键：教学目标（字符串数组）、学情（字符串）、重难点（字符串数组）、方法（字符串数组）、流程（数组，元素含 环节/时长/活动 三键）。`
	case KindOutline:
		schemaHint = `输出 JSON 对象，必须含键：条目（数组，元素含 节/标题/要点 三键），按节列出整章课纲。`
	case KindPlan:
		schemaHint = `依据下面的课文写教案。课件大纲若出现，只用来让教学过程环节与课件页大致对齐，绝不是教案内容来源；不要依据 PPT 讲稿。
输出 JSON 对象，必须含键：
- 教学目标：字符串数组。每条写学生上完课后能做什么、达到什么水平（能/会 + 识记或理解或应用）。禁止把课件页标题或章节名原样列为教学目标。
- 教学重点：字符串数组，1–3 条，本课必须抓住的核心，不要罗列全部知识点。
- 教学难点：字符串数组，可空；写清学生难在何处，不要编造。
- 教学过程：数组，元素含 环节、教师活动，可选 学生活动、设计意图。教师活动从教学角度写怎么教这篇课文，不要写成幻灯片备注。
- 讲授稿：字符串。从教学角度写教师怎么讲这篇课文，不是 PPT 逐页备注。
只输出 JSON。`
	}
	var sb strings.Builder
	sb.WriteString("章标题：" + in.Title + "\n\n")
	if in.Kind == KindPlan {
		for i, m := range in.Materials {
			fmt.Fprintf(&sb, "## 课文 %d\n%s\n\n", i+1, m)
		}
		if s := strings.TrimSpace(in.Outline); s != "" {
			sb.WriteString("## 课件大纲（仅供对齐教学环节，不是教案内容来源）\n" + s + "\n\n")
		}
	} else {
		for i, m := range in.Materials {
			fmt.Fprintf(&sb, "## 材料 %d\n%s\n\n", i+1, m)
		}
	}
	if in.Note != "" {
		sb.WriteString("## 教师补充说明\n" + in.Note + "\n\n")
	}
	if in.Critique != "" {
		sb.WriteString("## 返工修改意见（本次重做的依据）\n" + in.Critique + "\n\n")
	}
	sb.WriteString(schemaHint)
	return []map[string]string{
		{"role": "system", "content": systemPrompt(in.Kind)},
		{"role": "user", "content": sb.String()},
	}
}

func systemPrompt(kind Kind) string {
	if kind == KindPlan {
		return "你是教案撰写人。依据课文写教案。课件大纲只用来对齐教学环节，不是内容来源。只输出 JSON，不要输出任何其它文字。"
	}
	return "你是课程设计专家。只输出 JSON，不要输出任何其它文字。"
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
	case KindPlan:
		for _, k := range []string{"教学目标", "教学重点", "教学难点", "教学过程", "讲授稿"} {
			fmt.Fprintf(&sb, "## %s\n\n%s\n\n", k, mdValue(doc[k]))
		}
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
