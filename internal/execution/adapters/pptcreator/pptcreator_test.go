package pptcreator

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func writeMCPTool(w http.ResponseWriter, data any) {
	text, _ := json.Marshal(data)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"result": map[string]any{
			"content": []map[string]string{{"type": "text", "text": string(text)}},
		},
	})
}

func TestGenerateCallsCreatePptFromDocuments(t *testing.T) {
	var tool string
	var args map[string]any
	mux := http.NewServeMux()
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/n"):
			fmt.Fprint(w, `{"pages":[{"page":1,"notes":"n"}]}`)
		case strings.HasSuffix(r.URL.Path, "/o"):
			fmt.Fprint(w, `{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"}]}`)
		default:
			fmt.Fprint(w, "pptx")
		}
	}))
	t.Cleanup(files.Close)

	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Partner-Key") == "" || r.Header.Get("X-Job-Id") == "" ||
			r.Header.Get("X-Org-Id") == "" || r.Header.Get("X-Member-Id") == "" {
			t.Error("C1 headers must apply to MCP")
		}
		var rpc struct {
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&rpc); err != nil {
			t.Error(err)
		}
		switch rpc.Params.Name {
		case "create_ppt_from_text", "create_ppt_from_document":
			t.Errorf("must not call %s", rpc.Params.Name)
			writeMCPTool(w, map[string]any{"error": "wrong_tool"})
		case "create_ppt_from_documents":
			tool = rpc.Params.Name
			args = rpc.Params.Arguments
			writeMCPTool(w, map[string]any{"project_id": "pj-1", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, map[string]any{
				"status": "COMPLETED",
				"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
				"cost":   map[string]string{"vendor_cost": "0.1"},
				"result": map[string]string{
					"pptx_url":    files.URL + "/p",
					"notes_url":   files.URL + "/n",
					"outline_url": files.URL + "/o",
				},
			})
		default:
			t.Errorf("unexpected tool %s", rpc.Params.Name)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	res, err := c.Generate(t.Context(), GenerateRequest{
		JobID: "job-1", OrgID: "org-1", MemberID: "mem-1", Title: "导数",
		Documents: []Doc{
			{Role: "textbook", Name: "课文", Content: "导数的定义：差商的极限……足够长的正文"},
			{Role: "teaching_design", Name: "课程设计", Content: `{"教学目标":["理解导数"]}`},
		},
		Note: "2 学时",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res.Outline), `"source":"generated-deck"`) || !strings.Contains(string(res.Outline), "导数") {
		t.Fatalf("outline = %s", res.Outline)
	}
	if tool != "create_ppt_from_documents" {
		t.Fatalf("tool = %q", tool)
	}
	if _, ok := args["content"]; ok {
		t.Fatalf("must not send singular content (create_ppt_from_text): %#v", args["content"])
	}
	docs, _ := args["documents"].([]any)
	if len(docs) != 2 {
		t.Fatalf("documents = %#v", args["documents"])
	}
	first, _ := docs[0].(map[string]any)
	if first["role"] != "textbook" || first["content"] == nil {
		t.Fatalf("first doc = %#v", first)
	}
	if args["note"] != "2 学时" {
		t.Fatalf("note = %#v", args["note"])
	}
	if args["style"] != DefaultStyle {
		t.Fatalf("style = %#v, want %q", args["style"], DefaultStyle)
	}
}

func TestDefaultStyleIsEditorialPresetNotFamily(t *testing.T) {
	// PPTCreator MCP 缺 style 时默认 swiss-ikb；family 裸名 editorial 不是 preset，
	// 解析静默回退，和 swiss 默认叠在一起就是四不像。必须传 canonical preset。
	if DefaultStyle == "editorial" || DefaultStyle == "swiss-ikb" || !strings.HasPrefix(DefaultStyle, "editorial-") {
		t.Fatalf("DefaultStyle = %q, want editorial-* preset id", DefaultStyle)
	}
}

func TestGenerateRejectsMissingOutline(t *testing.T) {
	mux := http.NewServeMux()
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/n") {
			fmt.Fprint(w, `[{"page":1,"note":"n"}]`)
			return
		}
		fmt.Fprint(w, "pptx")
	}))
	t.Cleanup(files.Close)
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		switch rpc.Params.Name {
		case "create_ppt_from_documents":
			writeMCPTool(w, map[string]any{"project_id": "pj-1", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, map[string]any{
				"status": "COMPLETED",
				"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
				"cost":   map[string]string{"vendor_cost": "0.1"},
				"result": map[string]string{
					"pptx_url":  files.URL + "/p",
					"notes_url": files.URL + "/n",
				},
			})
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	_, err := c.Generate(t.Context(), GenerateRequest{
		JobID: "job-1", OrgID: "org-1", MemberID: "mem-1", Title: "导数",
		Documents: []Doc{{Role: "textbook", Name: "课文", Content: "导数的定义：差商的极限……足够长的正文"}},
	})
	pe, ok := err.(*Error)
	if !ok || pe.Code != "outline_missing" {
		t.Fatalf("err=%v, want outline_missing", err)
	}
}

func TestGenerateRejectsEmptyOutlineSlides(t *testing.T) {
	err := generateWithStatus(t, map[string]any{
		"status": "COMPLETED",
		"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
		"cost":   map[string]string{"vendor_cost": "0.1"},
		"result": map[string]any{
			"pptx_url":  "http://files/p",
			"notes_url": "http://files/n",
			"outline":   map[string]any{"source": "generated-deck", "slides": []any{}},
		},
	}, `[{"page":1,"note":"n"}]`)
	pe, ok := err.(*Error)
	if !ok || pe.Code != "outline_missing" {
		t.Fatalf("err=%v, want outline_missing", err)
	}
}

func TestGenerateRejectsOutlinePageMismatch(t *testing.T) {
	err := generateWithStatus(t, map[string]any{
		"status": "COMPLETED",
		"usage":  map[string]any{"pages": 2, "llm_tokens": 10},
		"cost":   map[string]string{"vendor_cost": "0.1"},
		"result": map[string]any{
			"pptx_url":  "http://files/p",
			"notes_url": "http://files/n",
			"outline": map[string]any{
				"source": "generated-deck",
				"slides": []any{map[string]any{"order": 1, "type": "COVER", "title": "导数"}},
			},
		},
	}, `[{"page":1,"note":"n"},{"page":2,"note":"n2"}]`)
	pe, ok := err.(*Error)
	if !ok || pe.Code != "outline_missing" {
		t.Fatalf("err=%v, want outline_missing", err)
	}
}

func TestGenerateAcceptsInlineOutline(t *testing.T) {
	res, err := generateOKWithStatus(t, map[string]any{
		"status": "COMPLETED",
		"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
		"cost":   map[string]string{"vendor_cost": "0.1"},
		"result": map[string]any{
			"pptx_url":  "http://files/p",
			"notes_url": "http://files/n",
			"outline": map[string]any{
				"source": "generated-deck",
				"slides": []any{map[string]any{"order": 1, "type": "COVER", "title": "导数"}},
			},
		},
	}, `[{"page":1,"note":"n"}]`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res.Outline), "导数") {
		t.Fatalf("outline = %s", res.Outline)
	}
}

func TestGeneratePassesConfirmedOutline(t *testing.T) {
	var args map[string]any
	mux := http.NewServeMux()
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/n") {
			fmt.Fprint(w, `[{"page":1,"note":"n"}]`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/o") {
			fmt.Fprint(w, `{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"}]}`)
			return
		}
		fmt.Fprint(w, "pptx")
	}))
	t.Cleanup(files.Close)
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		switch rpc.Params.Name {
		case "create_ppt_from_documents":
			args = rpc.Params.Arguments
			writeMCPTool(w, map[string]any{"project_id": "pj-1", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, map[string]any{
				"status": "COMPLETED",
				"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
				"cost":   map[string]string{"vendor_cost": "0.1"},
				"result": map[string]string{
					"pptx_url":    files.URL + "/p",
					"notes_url":   files.URL + "/n",
					"outline_url": files.URL + "/o",
				},
			})
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	outline := json.RawMessage(`{"source":"planned","slides":[{"order":1,"type":"COVER","title":"导数"}]}`)
	if _, err := c.Generate(t.Context(), GenerateRequest{
		JobID: "job-1", OrgID: "org-1", MemberID: "mem-1", Title: "导数",
		Documents:        []Doc{{Role: "textbook", Name: "课文", Content: "导数的定义：差商的极限……足够长的正文"}},
		ConfirmedOutline: outline,
	}); err != nil {
		t.Fatal(err)
	}
	raw, ok := args["confirmed_outline"]
	if !ok {
		t.Fatal("confirmed_outline missing from create_ppt_from_documents")
	}
	b, _ := json.Marshal(raw)
	if !strings.Contains(string(b), "导数") {
		t.Fatalf("confirmed_outline = %s", b)
	}
}

func generateWithStatus(t *testing.T, status map[string]any, notes string) error {
	t.Helper()
	_, err := generateOKWithStatus(t, status, notes)
	return err
}

func generateOKWithStatus(t *testing.T, status map[string]any, notes string) (*Result, error) {
	t.Helper()
	mux := http.NewServeMux()
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/n") {
			fmt.Fprint(w, notes)
			return
		}
		fmt.Fprint(w, "pptx")
	}))
	t.Cleanup(files.Close)
	if pptx, _ := status["result"].(map[string]any); pptx != nil {
		if _, ok := pptx["pptx_url"]; ok {
			pptx["pptx_url"] = files.URL + "/p"
		}
		if _, ok := pptx["notes_url"]; ok {
			pptx["notes_url"] = files.URL + "/n"
		}
	}
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		switch rpc.Params.Name {
		case "create_ppt_from_documents":
			writeMCPTool(w, map[string]any{"project_id": "pj-1", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, status)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	return c.Generate(t.Context(), GenerateRequest{
		JobID: "job-1", OrgID: "org-1", MemberID: "mem-1", Title: "导数",
		Documents: []Doc{{Role: "textbook", Name: "课文", Content: "导数的定义：差商的极限……足够长的正文"}},
	})
}

func TestParseOutlineSlides(t *testing.T) {
	slides, err := parseOutlineSlides([]byte(`{"source":"generated-deck","slides":[{"order":1,"title":"a"},{"order":2,"title":"b"}]}`))
	if err != nil || len(slides) != 2 {
		t.Fatalf("ok: %v %d", err, len(slides))
	}
	if _, err := parseOutlineSlides([]byte(`{"source":"generated-deck","slides":[]}`)); err == nil {
		t.Fatal("empty slides should fail")
	}
	if _, err := parseOutlineSlides([]byte(`{"slides":null}`)); err == nil {
		t.Fatal("null slides should fail")
	}
}

func TestGenerateRejectsMissingTextbook(t *testing.T) {
	c := New("http://127.0.0.1:1", "k")
	_, err := c.Generate(t.Context(), GenerateRequest{
		JobID: "j", Title: "x",
		Documents: []Doc{{Role: "reference", Content: "一段足够长的参考资料正文"}},
	})
	if err == nil {
		t.Fatal("want error")
	}
	pe, ok := err.(*Error)
	if !ok || pe.Code != "invalid_materials" {
		t.Fatalf("err=%v", err)
	}
}

func TestValidateDocumentsContentOrURL(t *testing.T) {
	okURL := []Doc{{Role: "textbook", Name: "课文.pdf", URL: "https://app.codelphi.com/media/a.pdf?sig=1"}}
	if err := validateDocuments(okURL); err != nil {
		t.Fatalf("url-only textbook: %v", err)
	}
	if err := validateDocuments([]Doc{
		{Role: "textbook", Content: "导数的定义：差商的极限……足够长", URL: "https://app.codelphi.com/media/a.pdf"},
	}); err == nil {
		t.Fatal("content and url together should fail")
	}
	if err := validateDocuments([]Doc{{Role: "textbook", Name: "课文.pdf"}}); err == nil {
		t.Fatal("neither content nor url should fail")
	}
	if err := validateDocuments([]Doc{{Role: "textbook", URL: "/media/a.pdf"}}); err == nil {
		t.Fatal("relative url should fail")
	}
}

func TestGenerateSendsStageAndStopsAtOutlineReady(t *testing.T) {
	var args map[string]any
	mux := http.NewServeMux()
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/n"):
			fmt.Fprint(w, `{"pages":[{"page":1,"notes":"导入差商"}]}`)
		case strings.HasSuffix(r.URL.Path, "/o"):
			fmt.Fprint(w, `{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"}]}`)
		default:
			t.Errorf("outline stage must not fetch pptx: %s", r.URL.Path)
		}
	}))
	t.Cleanup(files.Close)
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		switch rpc.Params.Name {
		case "create_ppt_from_documents":
			args = rpc.Params.Arguments
			writeMCPTool(w, map[string]any{"project_id": "pj-outline", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, map[string]any{
				"status": "OUTLINE_READY",
				"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
				"cost":   map[string]string{"vendor_cost": "0.1"},
				"result": map[string]string{
					"outline_url": files.URL + "/o",
					"notes_url":   files.URL + "/n",
				},
			})
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	res, err := c.Generate(t.Context(), GenerateRequest{
		JobID: "job-1", OrgID: "org-1", MemberID: "mem-1", Title: "导数",
		Stage:     StageOutline,
		Documents: []Doc{{Role: "textbook", Name: "课文", Content: "导数的定义：差商的极限……足够长的正文"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if args["stage"] != StageOutline {
		t.Fatalf("stage = %#v, want %q", args["stage"], StageOutline)
	}
	if res.ProjectID != "pj-outline" {
		t.Fatalf("project_id = %q", res.ProjectID)
	}
	if res.PptxURL != "" {
		t.Fatalf("outline stage must not return pptx_url: %s", res.PptxURL)
	}
	if !strings.Contains(string(res.Outline), "导数") {
		t.Fatalf("outline = %s", res.Outline)
	}
	if !strings.Contains(string(res.Notes), "差商") {
		t.Fatalf("notes = %s", res.Notes)
	}
}

func TestGenerateOutlineReadyMissingOutlineFails(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		switch rpc.Params.Name {
		case "create_ppt_from_documents":
			writeMCPTool(w, map[string]any{"project_id": "pj-1", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, map[string]any{
				"status": "OUTLINE_READY",
				"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
				"result": map[string]string{},
			})
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	_, err := c.Generate(t.Context(), GenerateRequest{
		JobID: "job-1", OrgID: "org-1", MemberID: "mem-1", Title: "导数",
		Stage:     StageOutline,
		Documents: []Doc{{Role: "textbook", Name: "课文", Content: "导数的定义：差商的极限……足够长的正文"}},
	})
	pe, ok := err.(*Error)
	if !ok || pe.Code != "outline_missing" {
		t.Fatalf("err=%v, want outline_missing", err)
	}
}

func TestGeneratePptxStageSendsProjectID(t *testing.T) {
	var args map[string]any
	mux := http.NewServeMux()
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/n") {
			fmt.Fprint(w, `[{"page":1,"note":"n"}]`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/o") {
			fmt.Fprint(w, `{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"}]}`)
			return
		}
		fmt.Fprint(w, "pptx")
	}))
	t.Cleanup(files.Close)
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		switch rpc.Params.Name {
		case "create_ppt_from_documents":
			args = rpc.Params.Arguments
			writeMCPTool(w, map[string]any{"project_id": "pj-outline", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, map[string]any{
				"status": "COMPLETED",
				"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
				"cost":   map[string]string{"vendor_cost": "0.1"},
				"result": map[string]string{
					"pptx_url":    files.URL + "/p",
					"notes_url":   files.URL + "/n",
					"outline_url": files.URL + "/o",
				},
			})
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	outline := json.RawMessage(`{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"}]}`)
	res, err := c.Generate(t.Context(), GenerateRequest{
		JobID: "job-2", OrgID: "org-1", MemberID: "mem-1", Title: "导数",
		Stage: StagePPTX, ProjectID: "pj-outline",
		Documents:        []Doc{{Role: "textbook", Name: "课文", Content: "导数的定义：差商的极限……足够长的正文"}},
		ConfirmedOutline: outline,
	})
	if err != nil {
		t.Fatal(err)
	}
	if args["stage"] != StagePPTX {
		t.Fatalf("stage = %#v", args["stage"])
	}
	if args["project_id"] != "pj-outline" {
		t.Fatalf("project_id = %#v", args["project_id"])
	}
	if res.PptxURL == "" {
		t.Fatal("pptx stage must return pptx_url")
	}
}

func TestGenerateOutlineReadyRejectsPptxURL(t *testing.T) {
	err := generateWithStatus(t, map[string]any{
		"status": "OUTLINE_READY",
		"usage":  map[string]any{"pages": 1, "llm_tokens": 10},
		"cost":   map[string]string{"vendor_cost": "0.1"},
		"result": map[string]any{
			"pptx_url": "http://files/p",
			"outline": map[string]any{
				"source": "generated-deck",
				"slides": []any{map[string]any{"order": 1, "type": "COVER", "title": "导数"}},
			},
		},
	}, `[{"page":1,"note":"n"}]`)
	pe, ok := err.(*Error)
	if !ok || pe.Code != "bad_response" {
		t.Fatalf("err=%v, want bad_response", err)
	}
}

func TestParseNotesPages(t *testing.T) {
	arr, err := parseNotesPages([]byte(`[{"page":1}]`))
	if err != nil || len(arr) != 1 {
		t.Fatalf("array: %v %d", err, len(arr))
	}
	wrapped, err := parseNotesPages([]byte(`{"pages":[{"page":1,"notes":"a"},{"page":2,"notes":"b"}]}`))
	if err != nil || len(wrapped) != 2 {
		t.Fatalf("wrapped: %v %d", err, len(wrapped))
	}
	if _, err := parseNotesPages([]byte(`{"pages":[]}`)); err == nil {
		t.Fatal("empty wrap should fail")
	}
}
