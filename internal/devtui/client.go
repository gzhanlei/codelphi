package devtui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// SeedOrgID 对应 scripts/dev-seed.sql 的本地联调机构。
const SeedOrgID = "01JDEVORG00000000000000001"

type Config struct {
	Base  string
	Token string
	OrgID string
}

type Client struct {
	HTTP *http.Client
	Cfg  Config
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (c *Client) setAuth(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.Cfg.Token)
	if c.Cfg.OrgID != "" {
		req.Header.Set("X-Org-Id", c.Cfg.OrgID)
	}
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.Cfg.Base, "/")+path, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.setAuth(req)
	return c.http().Do(req)
}

func decodeBody(res *http.Response, dest any) error {
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= 400 {
		var ae apiError
		if json.Unmarshal(b, &ae) == nil && ae.Error.Code != "" {
			return fmt.Errorf("%s: %s", ae.Error.Code, ae.Error.Message)
		}
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	if dest == nil {
		return nil
	}
	if err := json.Unmarshal(b, dest); err != nil {
		return fmt.Errorf("decode: %w (%s)", err, strings.TrimSpace(string(b)))
	}
	return nil
}

func (c *Client) Health(ctx context.Context) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.Cfg.Base, "/")+"/healthz", nil)
	if err != nil {
		return nil, err
	}
	res, err := c.http().Do(req)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if err := decodeBody(res, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) Me(ctx context.Context) (json.RawMessage, error) {
	res, err := c.do(ctx, http.MethodGet, "/v1/me", nil)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err := decodeBody(res, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func (c *Client) CreateProject(ctx context.Context, title string) (string, error) {
	res, err := c.do(ctx, http.MethodPost, "/v1/projects", map[string]string{"title": title})
	if err != nil {
		return "", err
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := decodeBody(res, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("empty project id")
	}
	return out.ID, nil
}

func (c *Client) CreateLesson(ctx context.Context, projectID, title string) (string, error) {
	res, err := c.do(ctx, http.MethodPost, "/v1/projects/"+projectID+"/lessons", map[string]string{"title": title})
	if err != nil {
		return "", err
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := decodeBody(res, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("empty lesson id")
	}
	return out.ID, nil
}

func (c *Client) UploadMaterial(ctx context.Context, projectID, lessonID, filename, kind string, data []byte) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if kind != "" {
		if err := w.WriteField("kind", kind); err != nil {
			return err
		}
	}
	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		return err
	}
	if _, err := fw.Write(data); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	path := "/v1/projects/" + projectID + "/lessons/" + lessonID + "/materials"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.Cfg.Base, "/")+path, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	c.setAuth(req)
	res, err := c.http().Do(req)
	if err != nil {
		return err
	}
	return decodeBody(res, nil)
}

type LessonRef struct {
	LessonJobID string `json:"lesson_job_id"`
	PackageID   string `json:"package_id"`
	Status      string `json:"status"`
}

func (c *Client) Submit(ctx context.Context, projectID, lessonID, note string) (LessonRef, error) {
	body := map[string]string{}
	if note != "" {
		body["note"] = note
	}
	res, err := c.do(ctx, http.MethodPost, "/v1/projects/"+projectID+"/lessons/"+lessonID+"/submit", body)
	if err != nil {
		return LessonRef{}, err
	}
	var out LessonRef
	if err := decodeBody(res, &out); err != nil {
		return LessonRef{}, err
	}
	return out, nil
}

type ArtifactSnap struct {
	ID      string `json:"id"`
	Version int32  `json:"version"`
	Status  string `json:"status"`
	URL     string `json:"url,omitempty"`
}

type ArtifactKind struct {
	Kind    string        `json:"kind"`
	Current *ArtifactSnap `json:"current"`
}

type StepError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type PackageView struct {
	ID           string         `json:"id"`
	Status       string         `json:"status"`
	LessonJobID  string         `json:"lesson_job_id"`
	LessonStatus string         `json:"lesson_status"`
	Error        *StepError     `json:"error,omitempty"`
	Artifacts    []ArtifactKind `json:"artifacts"`
}

func (c *Client) GetPackage(ctx context.Context, packageID string) (*PackageView, error) {
	res, err := c.do(ctx, http.MethodGet, "/v1/packages/"+packageID, nil)
	if err != nil {
		return nil, err
	}
	var out PackageView
	if err := decodeBody(res, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetLesson(ctx context.Context, lessonJobID string) (*PackageView, error) {
	res, err := c.do(ctx, http.MethodGet, "/v1/lessons/"+lessonJobID, nil)
	if err != nil {
		return nil, err
	}
	var out PackageView
	if err := decodeBody(res, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Confirm(ctx context.Context, lessonJobID string) (LessonRef, error) {
	res, err := c.do(ctx, http.MethodPost, "/v1/lessons/"+lessonJobID+"/confirm", map[string]string{})
	if err != nil {
		return LessonRef{}, err
	}
	var out LessonRef
	if err := decodeBody(res, &out); err != nil {
		return LessonRef{}, err
	}
	return out, nil
}

func (c *Client) Rebuild(ctx context.Context, packageID, kind, critique string) error {
	res, err := c.do(ctx, http.MethodPost, "/v1/packages/"+packageID+"/rebuild", map[string]string{
		"kind": kind, "critique": critique,
	})
	if err != nil {
		return err
	}
	return decodeBody(res, nil)
}

func IsTerminal(status, lessonStatus string) bool {
	switch strings.ToLower(status) {
	case "ready", "partial", "failed":
		return true
	}
	return strings.EqualFold(lessonStatus, "failed")
}

func NeedsConfirm(lessonStatus string) bool {
	return lessonStatus == "awaiting_confirm"
}

func FormatPackage(p *PackageView) string {
	if p == nil {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "package %s status=%s lesson=%s/%s\n", p.ID, p.Status, p.LessonJobID, p.LessonStatus)
	if p.Error != nil && (p.Error.Code != "" || p.Error.Message != "") {
		fmt.Fprintf(&b, "  error %s %s\n", p.Error.Code, p.Error.Message)
	}
	for _, a := range p.Artifacts {
		url := ""
		if a.Current != nil {
			url = a.Current.URL
		}
		fmt.Fprintf(&b, "  %s  %s\n", a.Kind, url)
	}
	return b.String()
}

func PollPackage(ctx context.Context, c *Client, packageID string, untilConfirm bool, every time.Duration) (*PackageView, error) {
	if every <= 0 {
		every = 4 * time.Second
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	var last *PackageView
	for {
		pkg, err := c.GetPackage(ctx, packageID)
		if err != nil {
			if ctx.Err() != nil {
				return last, ctx.Err()
			}
			select {
			case <-ctx.Done():
				return last, ctx.Err()
			case <-ticker.C:
			}
			continue
		}
		last = pkg
		if untilConfirm && NeedsConfirm(pkg.LessonStatus) {
			return pkg, nil
		}
		if IsTerminal(pkg.Status, pkg.LessonStatus) {
			return pkg, nil
		}
		select {
		case <-ctx.Done():
			return pkg, ctx.Err()
		case <-ticker.C:
		}
	}
}
