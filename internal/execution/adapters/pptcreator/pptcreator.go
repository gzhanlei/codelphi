// Package pptcreator 是 PPTCreator partner adapter（契约 CONTRACT-pptcreator-partner.md v1）。
// partner 流量 = 纯机构流量；本 client 只实现 C1 认证头、C2 提交、C3 轮询、C4 讲稿校验。
package pptcreator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// GenerateRequest 对应 C2。Document 是方向二预合成的单文档（多份 text 材料拼接）。
type GenerateRequest struct {
	JobID    string // C1 X-Job-Id，幂等键
	OrgID    string
	MemberID string
	Title    string
	Document string
	Note     string // 教师补充说明，并入 spec（契约 v1 未定义字段，见出入说明）
	Critique string // 返工意见（Rebuild 时非空）
}

// Result 是 C3 succeeded 的回报 + C4 校验后的逐页 notes。
type Result struct {
	Pages      int
	LLMTokens  int64
	VendorCost float64
	PptxURL    string
	NotesURL   string
	ScriptURL  string
	Notes      json.RawMessage // 逐页 notes JSON，已校验非空且与页数对齐
}

// Error 是 partner 结构化错误（C7）。Retryable 由网关按新 job 重试。
type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return fmt.Sprintf("pptcreator: %s: %s", e.Code, e.Message) }

// Generate 提交生成并轮询到终态。notes 为空/页数不齐 → Error{Code: notes_missing}（C4 硬约束）。
func (c *Client) Generate(ctx context.Context, in GenerateRequest) (*Result, error) {
	body := map[string]any{
		"job_id":   in.JobID,
		"title":    in.Title,
		"document": map[string]string{"kind": "text", "text": in.Document},
		"spec": map[string]any{
			"notes_required": true,
			"note":           in.Note,
			"critique":       in.Critique,
		},
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/generate", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Partner-Key", c.partnerKey)
	req.Header.Set("X-Org-Id", in.OrgID)
	req.Header.Set("X-Member-Id", in.MemberID)
	req.Header.Set("X-Job-Id", in.JobID)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Code: "transport", Message: err.Error(), Retryable: true}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusAccepted {
		return nil, parsePartnerError(resp.StatusCode, raw)
	}
	var accepted struct {
		PlatformJobID string `json:"platform_job_id"`
	}
	if err := json.Unmarshal(raw, &accepted); err != nil || accepted.PlatformJobID == "" {
		return nil, &Error{Code: "bad_response", Message: "missing platform_job_id: " + string(raw)}
	}
	return c.poll(ctx, accepted.PlatformJobID)
}

// poll 按 C3 轮询到 succeeded/failed 或超时。
func (c *Client) poll(ctx context.Context, platformJobID string) (*Result, error) {
	deadline := time.Now().Add(c.pollTimeout)
	for {
		st, err := c.query(ctx, platformJobID)
		if err != nil {
			return nil, err
		}
		switch st.Status {
		case "succeeded":
			return c.harvest(st)
		case "failed":
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
		PptxURL   string `json:"pptx_url"`
		NotesURL  string `json:"notes_url"`
		ScriptURL string `json:"script_url"`
	} `json:"result"`
}

func (c *Client) query(ctx context.Context, platformJobID string) (*jobStatus, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/jobs/"+platformJobID, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Partner-Key", c.partnerKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Code: "transport", Message: err.Error(), Retryable: true}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, parsePartnerError(resp.StatusCode, raw)
	}
	var st jobStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, &Error{Code: "bad_response", Message: err.Error()}
	}
	return &st, nil
}

// harvest 校验 C3 回报的完整性 + C4 讲稿硬约束。
func (c *Client) harvest(st *jobStatus) (*Result, error) {
	if st.Result.PptxURL == "" || st.Result.NotesURL == "" {
		return nil, &Error{Code: "bad_response", Message: "succeeded but missing result urls"}
	}
	// notes 非空且与页数严格对齐，否则按 C4 视为 notes_missing（step failed）。
	notes, err := c.fetchBytes(st.Result.NotesURL)
	if err != nil {
		return nil, &Error{Code: "notes_missing", Message: "fetch notes: " + err.Error()}
	}
	var pages []json.RawMessage
	if err := json.Unmarshal(notes, &pages); err != nil || len(pages) == 0 {
		return nil, &Error{Code: "notes_missing", Message: "notes empty or not a JSON array"}
	}
	if st.Usage.Pages > 0 && len(pages) != st.Usage.Pages {
		return nil, &Error{Code: "notes_missing",
			Message: fmt.Sprintf("notes pages %d != pptx pages %d", len(pages), st.Usage.Pages)}
	}
	cost, _ := strconv.ParseFloat(st.Cost.VendorCost, 64)
	return &Result{
		Pages:      st.Usage.Pages,
		LLMTokens:  st.Usage.LLMTokens,
		VendorCost: cost,
		PptxURL:    st.Result.PptxURL,
		NotesURL:   st.Result.NotesURL,
		ScriptURL:  st.Result.ScriptURL,
		Notes:      notes,
	}, nil
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

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
