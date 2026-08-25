// Package pptcreator 是 PPTCreator partner adapter（契约 CONTRACT-pptcreator-partner.md v1）。
// partner 流量 = 纯机构流量；本 client 实现 C1 认证头、C2 提交、C3 轮询、C4 讲稿校验、C8 课件大纲。
package pptcreator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client 按契约 C1–C4 调 partner 接口。
type Client struct {
	baseURL     string
	partnerKey  string
	http        *http.Client
	pollEvery   time.Duration
	pollTimeout time.Duration
}

type Option func(*Client)

func WithHTTPClient(c *http.Client) Option { return func(cl *Client) { cl.http = c } }
func WithPoll(every, timeout time.Duration) Option {
	return func(cl *Client) { cl.pollEvery, cl.pollTimeout = every, timeout }
}

func New(baseURL, partnerKey string, opts ...Option) *Client {
	c := &Client{
		baseURL:     strings.TrimRight(baseURL, "/"),
		partnerKey:  partnerKey,
		http:        &http.Client{Timeout: 30 * time.Second},
		pollEvery:   2 * time.Second,
		pollTimeout: 10 * time.Minute,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Doc 对应 create_ppt_from_documents 的一份材料（契约 C2 方向一）。
// role 仅 textbook / teaching_design / reference；content / url / document_id 三选一。
// 教师原文件走 url（短 TTL 签名 GET）；design/outline 构件走 content。
type Doc struct {
	Role    string `json:"role"`
	Name    string `json:"name,omitempty"`
	Content string `json:"content,omitempty"`
	URL     string `json:"url,omitempty"`
}

// GenerateRequest 对应 C2。Documents 是材料包（恰好一份 textbook），不再预合成单文本。
type GenerateRequest struct {
	JobID     string // C1 X-Job-Id，幂等键
	OrgID     string
	MemberID  string
	Title     string
	Documents []Doc
	Note             string          // 教师补充说明，并入 spec.note
	Critique         string          // 返工意见（Rebuild 时非空）
	ConfirmedOutline json.RawMessage // C8.2 当前课件大纲，缺省则 partner 自行编排
}

// DefaultStyle 是 digital_lesson 课件默认皮肤。partner 路径跳过 C 端 clarify，
// 不传 style 时 PPTCreator MCP 曾默认 swiss-ikb；课件应对齐 editorial。
const DefaultStyle = "editorial"

// Result 是 C3 succeeded 的回报 + C4 校验后的逐页 notes。
type Result struct {
	Pages      int
	LLMTokens  int64
	VendorCost float64
	PptxURL    string
	NotesURL   string
	ScriptURL  string
	OutlineURL string
	Notes      json.RawMessage // 逐页 notes JSON，已校验非空且与页数对齐
	Outline    json.RawMessage // C8 课件大纲 JSON，已校验非空且与页数对齐
}

// Error 是 partner 结构化错误（C7）。Retryable 由网关按新 job 重试。
type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return fmt.Sprintf("pptcreator: %s: %s", e.Code, e.Message) }

// Generate 经 MCP tools/call create_ppt_from_documents 提交材料包并轮询到终态。
// 不调用 create_ppt_from_text（单文本/方向二）。notes 为空/页数不齐 → notes_missing；大纲缺失/不齐 → outline_missing。
func (c *Client) Generate(ctx context.Context, in GenerateRequest) (*Result, error) {
	if err := validateDocuments(in.Documents); err != nil {
		return nil, err
	}
	args := map[string]any{
		"title":     in.Title,
		"documents": in.Documents,
		"style":     DefaultStyle,
	}
	if s := strings.TrimSpace(in.Note); s != "" {
		args["note"] = s
	}
	if s := strings.TrimSpace(in.Critique); s != "" {
		args["critique"] = s
	}
	if len(in.ConfirmedOutline) > 0 {
		var v any
		if err := json.Unmarshal(in.ConfirmedOutline, &v); err != nil {
			return nil, &Error{Code: "invalid_outline", Message: "confirmed_outline is not JSON"}
		}
		args["confirmed_outline"] = v
	}
	raw, err := c.toolCall(ctx, in, "create_ppt_from_documents", args)
	if err != nil {
		return nil, err
	}
	var accepted struct {
		ProjectID string `json:"project_id"`
	}
	if err := json.Unmarshal(raw, &accepted); err != nil || accepted.ProjectID == "" {
		return nil, &Error{Code: "bad_response", Message: "missing project_id: " + string(raw)}
	}
	return c.poll(ctx, in, accepted.ProjectID)
}

func validateDocuments(docs []Doc) error {
	if len(docs) == 0 || len(docs) > 5 {
		return &Error{Code: "invalid_materials", Message: "documents must be 1–5 items"}
	}
	n := 0
	for _, d := range docs {
		switch d.Role {
		case "textbook", "teaching_design", "reference":
		default:
			return &Error{Code: "invalid_materials", Message: "invalid document role: " + d.Role}
		}
		if err := validateDocSource(d); err != nil {
			return err
		}
		if d.Role == "textbook" {
			n++
		}
	}
	if n != 1 {
		return &Error{Code: "invalid_materials", Message: "exactly one textbook document required"}
	}
	return nil
}

func validateDocSource(d Doc) error {
	contentOK := len(strings.TrimSpace(d.Content)) >= 10
	urlOK := isHTTPURL(strings.TrimSpace(d.URL))
	if contentOK == urlOK {
		return &Error{Code: "invalid_materials", Message: "each document needs content or url, not both"}
	}
	return nil
}

func isHTTPURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

func (c *Client) setPartnerHeaders(req *http.Request, in GenerateRequest) {
	req.Header.Set("X-Partner-Key", c.partnerKey)
	req.Header.Set("X-Org-Id", in.OrgID)
	req.Header.Set("X-Member-Id", in.MemberID)
	req.Header.Set("X-Job-Id", in.JobID)
}

func (c *Client) mcpURL() string {
	u := strings.TrimRight(c.baseURL, "/")
	u = strings.TrimSuffix(u, "/mcp")
	return u + "/mcp"
}

func (c *Client) toolCall(ctx context.Context, in GenerateRequest, name string, args any) (json.RawMessage, error) {
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": name, "arguments": args},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.mcpURL(), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	c.setPartnerHeaders(req, in)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Code: "transport", Message: err.Error(), Retryable: true}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, parsePartnerError(resp.StatusCode, raw)
	}
	var rpc struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Result *struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &rpc); err != nil {
		return nil, &Error{Code: "bad_response", Message: err.Error()}
	}
	if rpc.Error != nil {
		return nil, &Error{Code: "rpc_error", Message: rpc.Error.Message, Retryable: true}
	}
	if rpc.Result == nil || len(rpc.Result.Content) == 0 {
		return nil, &Error{Code: "bad_response", Message: "empty MCP result: " + string(raw)}
	}
	text := json.RawMessage(rpc.Result.Content[0].Text)
	var toolErr struct {
		Code    string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(text, &toolErr); err == nil && toolErr.Code != "" {
		return nil, &Error{Code: toolErr.Code, Message: toolErr.Message}
	}
	return text, nil
}

// poll 按 C3 轮询到 succeeded/failed 或超时。
func (c *Client) poll(ctx context.Context, in GenerateRequest, platformJobID string) (*Result, error) {
	deadline := time.Now().Add(c.pollTimeout)
	for {
		st, err := c.query(ctx, in, platformJobID)
		if err != nil {
			return nil, err
		}
		switch strings.ToUpper(st.Status) {
		case "COMPLETED", "SUCCEEDED":
			return c.harvest(st)
		case "FAILED":
			pe := &Error{Code: "platform_failed", Message: "job failed"}
			if st.Err != nil {
				pe.Code = st.Err.Code
				pe.Message = st.Err.Message
			}
			return nil, pe
		}
		if time.Now().After(deadline) {
			return nil, &Error{Code: "poll_timeout", Message: "poll deadline exceeded", Retryable: true}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(c.pollEvery):
		}
	}
}

type jobStatus struct {
	Status string `json:"status"`
	Err    *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Usage struct {
		Pages     int   `json:"pages"`
		LLMTokens int64 `json:"llm_tokens"`
	} `json:"usage"`
	Cost struct {
		VendorCost string `json:"vendor_cost"`
	} `json:"cost"`
	Result struct {
		PptxURL    string          `json:"pptx_url"`
		NotesURL   string          `json:"notes_url"`
		ScriptURL  string          `json:"script_url"`
		OutlineURL string          `json:"outline_url"`
		Outline    json.RawMessage `json:"outline"`
	} `json:"result"`
}

func (c *Client) query(ctx context.Context, in GenerateRequest, platformJobID string) (*jobStatus, error) {
	raw, err := c.toolCall(ctx, in, "get_generation_status", map[string]any{"project_id": platformJobID})
	if err != nil {
		return nil, err
	}
	var st jobStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, &Error{Code: "bad_response", Message: err.Error()}
	}
	return &st, nil
}

// harvest 校验 C3 回报的完整性 + C4 讲稿硬约束 + C8 课件大纲硬约束。
func (c *Client) harvest(st *jobStatus) (*Result, error) {
	if st.Result.PptxURL == "" || st.Result.NotesURL == "" {
		return nil, &Error{Code: "bad_response", Message: "succeeded but missing result urls"}
	}
	// notes 非空且与页数严格对齐，否则按 C4 视为 notes_missing（step failed）。
	notes, err := c.fetchBytes(st.Result.NotesURL)
	if err != nil {
		return nil, &Error{Code: "notes_missing", Message: "fetch notes: " + err.Error()}
	}
	pages, err := parseNotesPages(notes)
	if err != nil || len(pages) == 0 {
		return nil, &Error{Code: "notes_missing", Message: "notes empty or not a JSON array"}
	}
	if st.Usage.Pages > 0 && len(pages) != st.Usage.Pages {
		return nil, &Error{Code: "notes_missing",
			Message: fmt.Sprintf("notes pages %d != pptx pages %d", len(pages), st.Usage.Pages)}
	}
	outline, err := c.harvestOutline(st)
	if err != nil {
		return nil, err
	}
	cost, _ := strconv.ParseFloat(st.Cost.VendorCost, 64)
	return &Result{
		Pages:      st.Usage.Pages,
		LLMTokens:  st.Usage.LLMTokens,
		VendorCost: cost,
		PptxURL:    st.Result.PptxURL,
		NotesURL:   st.Result.NotesURL,
		ScriptURL:  st.Result.ScriptURL,
		OutlineURL: st.Result.OutlineURL,
		Notes:      notes,
		Outline:    outline,
	}, nil
}

func (c *Client) harvestOutline(st *jobStatus) (json.RawMessage, error) {
	var raw json.RawMessage
	switch {
	case strings.TrimSpace(st.Result.OutlineURL) != "":
		b, err := c.fetchBytes(st.Result.OutlineURL)
		if err != nil {
			return nil, &Error{Code: "outline_missing", Message: "fetch outline: " + err.Error()}
		}
		raw = b
	case len(bytes.TrimSpace(st.Result.Outline)) > 0 && string(st.Result.Outline) != "null":
		raw = st.Result.Outline
	default:
		return nil, &Error{Code: "outline_missing", Message: "succeeded but missing outline"}
	}
	slides, err := parseOutlineSlides(raw)
	if err != nil || len(slides) == 0 {
		return nil, &Error{Code: "outline_missing", Message: "outline empty or missing slides"}
	}
	if st.Usage.Pages > 0 && len(slides) != st.Usage.Pages {
		return nil, &Error{Code: "outline_missing",
			Message: fmt.Sprintf("outline slides %d != pptx pages %d", len(slides), st.Usage.Pages)}
	}
	return raw, nil
}

// Fetch 拉平台预签名 URL 的字节（回拷本侧对象存储用，不转手临时链，C3）。
func (c *Client) Fetch(ctx context.Context, url string) ([]byte, error) {
	return c.fetchBytesCtx(ctx, url)
}

func (c *Client) fetchBytes(url string) ([]byte, error) {
	return c.fetchBytesCtx(context.Background(), url)
}

func (c *Client) fetchBytesCtx(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

// parsePartnerError 解析 C7 结构化错误；非 JSON 响应按 HTTP 状态归类。
func parsePartnerError(status int, raw []byte) error {
	var body struct {
		Err *struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err == nil && body.Err != nil {
		return &Error{Code: body.Err.Code, Message: body.Err.Message, Retryable: body.Err.Retryable}
	}
	return &Error{Code: fmt.Sprintf("http_%d", status), Message: truncate(string(raw), 200),
		Retryable: status >= 500}
}

func parseNotesPages(raw []byte) ([]json.RawMessage, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil && len(arr) > 0 {
		return arr, nil
	}
	var wrap struct {
		Pages []json.RawMessage `json:"pages"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return nil, err
	}
	if len(wrap.Pages) == 0 {
		return nil, fmt.Errorf("empty pages")
	}
	return wrap.Pages, nil
}

func parseOutlineSlides(raw []byte) ([]json.RawMessage, error) {
	var wrap struct {
		Slides []json.RawMessage `json:"slides"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return nil, err
	}
	if len(wrap.Slides) == 0 {
		return nil, fmt.Errorf("empty slides")
	}
	return wrap.Slides, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
