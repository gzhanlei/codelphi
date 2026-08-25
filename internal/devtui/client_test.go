package devtui

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientHappyPath(t *testing.T) {
	var gotAuth, gotOrg, gotSubmitPath string
	var gotKind, gotFilename string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","db":"ok"}`))
	})
	mux.HandleFunc("GET /v1/me", func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotOrg = r.Header.Get("X-Org-Id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"dev-local","memberships":[{"org_id":"01JDEVORG00000000000000001"}]}`))
	})
	mux.HandleFunc("POST /v1/projects", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"proj1","title":"高等数学"}`))
	})
	mux.HandleFunc("POST /v1/projects/proj1/lessons", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"les1","project_id":"proj1","title":"第 3 章"}`))
	})
	mux.HandleFunc("POST /v1/projects/proj1/lessons/les1/materials", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("multipart: %v", err)
		}
		gotKind = r.FormValue("kind")
		_, hdr, _ := r.FormFile("file")
		if hdr != nil {
			gotFilename = hdr.Filename
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"mat1","kind":"text"}`))
	})
	mux.HandleFunc("POST /v1/projects/proj1/lessons/les1/submit", func(w http.ResponseWriter, r *http.Request) {
		gotSubmitPath = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"lesson_job_id":"job1","package_id":"pkg1","status":"running"}`))
	})
	mux.HandleFunc("GET /v1/packages/pkg1", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"pkg1","status":"ready","lesson_job_id":"job1","lesson_status":"succeeded","artifacts":[{"kind":"outline","current":{"url":"http://127.0.0.1:8080/media/outline.json"}}]}`))
	})
	mux.HandleFunc("POST /v1/lessons/job1/confirm", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"lesson_job_id":"job1","package_id":"pkg1","status":"running"}`))
	})
	mux.HandleFunc("POST /v1/packages/pkg1/rebuild", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var in struct {
			Kind     string `json:"kind"`
			Critique string `json:"critique"`
		}
		_ = json.Unmarshal(b, &in)
		if in.Kind != "ppt" || in.Critique == "" {
			t.Errorf("rebuild body = %s", b)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"package_id":"pkg1","status":"building"}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	c := &Client{HTTP: srv.Client(), Cfg: Config{Base: srv.URL, Token: "dev", OrgID: SeedOrgID}}
	ctx := context.Background()

	h, err := c.Health(ctx)
	if err != nil || h["status"] != "ok" {
		t.Fatalf("health = %v %v", h, err)
	}
	if _, err := c.Me(ctx); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer dev" || gotOrg != SeedOrgID {
		t.Fatalf("auth=%q org=%q", gotAuth, gotOrg)
	}
	pid, err := c.CreateProject(ctx, "高等数学")
	if err != nil || pid != "proj1" {
		t.Fatalf("project %q %v", pid, err)
	}
	lid, err := c.CreateLesson(ctx, pid, "第 3 章")
	if err != nil || lid != "les1" {
		t.Fatalf("lesson %q %v", lid, err)
	}
	if err := c.UploadMaterial(ctx, pid, lid, "课文.md", "text", []byte("# 课文\n导数")); err != nil {
		t.Fatal(err)
	}
	if gotKind != "text" || gotFilename != "课文.md" {
		t.Fatalf("upload kind=%q file=%q", gotKind, gotFilename)
	}
	ref, err := c.Submit(ctx, pid, lid, "")
	if err != nil || ref.PackageID != "pkg1" {
		t.Fatalf("submit %+v %v", ref, err)
	}
	if gotSubmitPath != "/v1/projects/proj1/lessons/les1/submit" {
		t.Fatalf("submit path %q", gotSubmitPath)
	}
	pkg, err := c.GetPackage(ctx, "pkg1")
	if err != nil || pkg.Status != "ready" {
		t.Fatalf("pkg %+v %v", pkg, err)
	}
	if !strings.Contains(FormatPackage(pkg), "outline") {
		t.Fatalf("format %s", FormatPackage(pkg))
	}
	if _, err := c.Confirm(ctx, "job1"); err != nil {
		t.Fatal(err)
	}
	if err := c.Rebuild(ctx, "pkg1", "ppt", "封面改导数定义"); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeAPIError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/projects", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"code":"invalid_request","message":"title required"}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := &Client{HTTP: srv.Client(), Cfg: Config{Base: srv.URL, Token: "dev", OrgID: SeedOrgID}}
	_, err := c.CreateProject(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "invalid_request") {
		t.Fatalf("err = %v", err)
	}
}

func TestPollPackageReadyAndTransient(t *testing.T) {
	var n atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/packages/pkg1", func(w http.ResponseWriter, r *http.Request) {
		i := n.Add(1)
		if i == 1 {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`oops`))
			return
		}
		status := "building"
		if i >= 3 {
			status = "ready"
		}
		fmt.Fprintf(w, `{"id":"pkg1","status":%q,"lesson_status":"running","error":{"code":"x","message":"drift"},"artifacts":[{"kind":"outline","current":{"url":"http://u"}}]}`, status)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := &Client{HTTP: srv.Client(), Cfg: Config{Base: srv.URL, Token: "dev"}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	pkg, err := PollPackage(ctx, c, "pkg1", false, 20*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Status != "ready" {
		t.Fatalf("status = %s after %d calls", pkg.Status, n.Load())
	}
	if !strings.Contains(FormatPackage(pkg), "error x drift") {
		t.Fatalf("format %s", FormatPackage(pkg))
	}
}

func TestPollPackageUntilConfirm(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/packages/pkg1", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"pkg1","status":"building","lesson_status":"awaiting_confirm"}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := &Client{HTTP: srv.Client(), Cfg: Config{Base: srv.URL, Token: "dev"}}
	pkg, err := PollPackage(context.Background(), c, "pkg1", true, 20*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.LessonStatus != "awaiting_confirm" {
		t.Fatalf("%+v", pkg)
	}
}
