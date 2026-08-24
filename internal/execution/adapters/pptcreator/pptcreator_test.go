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
		if strings.HasSuffix(r.URL.Path, "/n") {
			fmt.Fprint(w, `{"pages":[{"page":1,"notes":"n"}]}`)
			return
		}
		fmt.Fprint(w, "pptx")
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
					"pptx_url":  files.URL + "/p",
					"notes_url": files.URL + "/n",
				},
			})
		default:
			t.Errorf("unexpected tool %s", rpc.Params.Name)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	c := New(srv.URL, "k", WithPoll(time.Millisecond, time.Second), WithHTTPClient(srv.Client()))
	_, err := c.Generate(t.Context(), GenerateRequest{
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
