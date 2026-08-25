package execution

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codelphi/internal/billing"
	"codelphi/internal/execution/adapters/llm"
	"codelphi/internal/execution/adapters/pptcreator"
)

// --- 假 LLM server（OpenAI 兼容 chat completions） ---

type fakeLLM struct {
	srv *httptest.Server
	// block 非空时每个请求先等它放行（并发测试用）
	block    chan struct{}
	cur      atomic.Int32
	max      atomic.Int32
	requests atomic.Int32
	// badJSON 非空时返回不合 schema 的内容（解析失败 = step failed）
	badJSON atomic.Bool
}

const (
	fakeDesignJSON  = `{"教学目标":["理解导数定义"],"学情":"已学极限","重难点":["差商极限"],"方法":["讲授","例题"],"流程":[{"环节":"导入","时长":"5min","活动":"回顾极限"}]}`
	fakeOutlineJSON = `{"条目":[{"节":"1","标题":"导数定义","要点":["差商","极限"]}]}`
)

func newFakeLLM(t *testing.T) *fakeLLM {
	t.Helper()
	f := &fakeLLM{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		cur := f.cur.Add(1)
		defer f.cur.Add(-1)
		for {
			if m := f.max.Load(); cur > m {
				if f.max.CompareAndSwap(m, cur) {
					break
				}
			} else {
				break
			}
		}
		if f.block != nil {
			<-f.block
		} else {
			time.Sleep(20 * time.Millisecond)
		}
		body, _ := io.ReadAll(r.Body)
		content := fakeDesignJSON
		if strings.Contains(string(body), "条目") {
			content = fakeOutlineJSON
		}
		if f.badJSON.Load() {
			content = `{"随便":"一段不合 schema 的 JSON"}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": content}}},
			"usage":   map[string]int64{"prompt_tokens": 100, "completion_tokens": 200},
		})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// --- 假 PPTCreator partner server（契约 C1–C4） ---

type fakePPT struct {
	srv *httptest.Server
	// 旋钮：generate 返回 500；notes 为空数组
	failGenerate atomic.Bool
	notesEmpty   atomic.Bool
	outlineEmpty atomic.Bool
	block        chan struct{}
	cur          atomic.Int32
	max          atomic.Int32

	mu         sync.Mutex
	lastHeader http.Header    // 最近一次 create_ppt_from_documents 的头（断言 C1）
	lastBody   map[string]any // 该次 tools/call 的 arguments（断言材料包）
}

const (
	fakePptxBytes       = "fake-pptx-bytes"
	fakeNotesJSON       = `[{"page":1,"note":"第一页讲稿"},{"page":2,"note":"第二页讲稿"}]`
	fakeScriptDocx      = "fake-script-docx"
	fakeDeckOutlineJSON = `{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"},{"order":2,"type":"CONTENT","title":"差商"}]}`
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

func newFakePPT(t *testing.T) *fakePPT {
	t.Helper()
	f := &fakePPT{}
	mux := http.NewServeMux()
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
			f.mu.Lock()
			f.lastHeader = r.Header.Clone()
			f.lastBody = rpc.Params.Arguments
			f.mu.Unlock()
			cur := f.cur.Add(1)
			defer f.cur.Add(-1)
			for {
				if m := f.max.Load(); cur > m {
					if f.max.CompareAndSwap(m, cur) {
						break
					}
				} else {
					break
				}
			}
			if f.block != nil {
				<-f.block
			}
			if f.failGenerate.Load() {
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, `{"error":{"code":"internal","message":"boom","retryable":true}}`)
				return
			}
			writeMCPTool(w, map[string]any{"project_id": "pj-1", "status": "queued"})
		case "get_generation_status":
			result := map[string]string{
				"pptx_url":   f.srv.URL + "/files/pptx",
				"notes_url":  f.srv.URL + "/files/notes",
				"script_url": f.srv.URL + "/files/script",
			}
			if !f.outlineEmpty.Load() {
				result["outline_url"] = f.srv.URL + "/files/outline"
			}
			writeMCPTool(w, map[string]any{
				"status": "COMPLETED",
				"usage":  map[string]any{"pages": 2, "llm_tokens": 500},
				"cost":   map[string]string{"currency": "CNY", "vendor_cost": "0.800000"},
				"result": result,
			})
		default:
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, `{"error":{"code":"unknown_tool","message":%q}}`, rpc.Params.Name)
		}
	})
	mux.HandleFunc("GET /files/pptx", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, fakePptxBytes) })
	mux.HandleFunc("GET /files/notes", func(w http.ResponseWriter, r *http.Request) {
		if f.notesEmpty.Load() {
			fmt.Fprint(w, `[]`)
			return
		}
		fmt.Fprint(w, fakeNotesJSON)
	})
	mux.HandleFunc("GET /files/script", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, fakeScriptDocx) })
	mux.HandleFunc("GET /files/outline", func(w http.ResponseWriter, r *http.Request) {
		if f.outlineEmpty.Load() {
			fmt.Fprint(w, `{"source":"generated-deck","slides":[]}`)
			return
		}
		fmt.Fprint(w, fakeDeckOutlineJSON)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

// --- 环境组装 ---

type env struct {
	fixture
	exec *Service
	llm  *fakeLLM
	ppt  *fakePPT
}

func newEnv(t *testing.T) *env {
	t.Helper()
	f := newFixture(t)
	fl := newFakeLLM(t)
	fp := newFakePPT(t)
	svc := New(testDB, billing.New(testDB), f.store,
		llm.New(fl.srv.URL, "test-model", ""),
		pptcreator.New(fp.srv.URL, "partner-key-test", pptcreator.WithPoll(time.Millisecond, 5*time.Second)),
		WithMedia("https://app.example.test", time.Hour),
	)
	return &env{fixture: f, exec: svc, llm: fl, ppt: fp}
}

func (e *env) extraLesson(t *testing.T, title string) string {
	t.Helper()
	id := ulidStr()
	execSQL(t, "INSERT INTO course_lessons (id, project_id, title) VALUES (?, ?, ?)", id, e.projectID, title)
	for i, text := range []string{"导数的定义：差商的极限……", "几何意义：切线斜率……"} {
		key := fmt.Sprintf("org/%s/material/%s/%d.txt", e.orgID, id, i)
		if err := e.store.Put(context.Background(), key, stringReader(text), "text/plain"); err != nil {
			t.Fatal(err)
		}
		execSQL(t, "INSERT INTO materials (id, project_id, lesson_id, kind, filename, storage_ref, uploaded_by) VALUES (?, ?, ?, 'text', ?, ?, ?)",
			ulidStr(), e.projectID, id, fmt.Sprintf("%d.txt", i), key, e.memberID)
	}
	return id
}

func (e *env) submit(t *testing.T) *Lesson {
	t.Helper()
	lesson, err := e.exec.SubmitLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数", Note: "2 学时",
	})
	if err != nil {
		t.Fatal(err)
	}
	return lesson
}

// --- 门禁测试 ---

// 全链路 happy path：submit 直接做片 → outline+ppt+script 齐、package ready、1 条 ppt UsageRecord settled。无确认门。
func TestHappyPath(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)

	if lesson.Status != "succeeded" {
		t.Fatalf("lesson status = %s, want succeeded", lesson.Status)
	}
	if s := packageStatus(t, lesson.PackageID); s != "ready" {
		t.Fatalf("package status = %s, want ready", s)
	}

	for _, kind := range []string{"outline", "ppt", "script"} {
		var ref string
		if err := testDB.QueryRow(
			"SELECT storage_ref FROM artifacts WHERE package_id = ? AND kind = ? AND is_current = 1",
			lesson.PackageID, kind).Scan(&ref); err != nil {
			t.Fatalf("artifact %s: %v", kind, err)
		}
		rc, err := e.store.Open(context.Background(), ref)
		if err != nil {
			t.Fatalf("open %s: %v", kind, err)
		}
		data, _ := io.ReadAll(rc)
		rc.Close()
		if kind == "ppt" && string(data) != fakePptxBytes {
			t.Fatalf("pptx 内容 = %q", data)
		}
		if kind == "outline" {
			if !strings.Contains(string(data), `"source":"generated-deck"`) || !strings.Contains(string(data), "导数") {
				t.Fatalf("outline = %q", data)
			}
		}
		if kind == "script" {
			if !strings.HasSuffix(ref, ".docx") {
				t.Fatalf("script storage_ref = %q, want .docx (script_url)", ref)
			}
			if string(data) != fakeScriptDocx {
				t.Fatalf("script 内容 = %q, want docx", data)
			}
			jsonRef := strings.TrimSuffix(ref, ".docx") + ".json"
			jrc, err := e.store.Open(context.Background(), jsonRef)
			if err != nil {
				t.Fatalf("open notes sidecar %s: %v", jsonRef, err)
			}
			jdata, _ := io.ReadAll(jrc)
			jrc.Close()
			if string(jdata) != fakeNotesJSON {
				t.Fatalf("notes sidecar = %q", jdata)
			}
		}
	}
	if n := countUsageRecords(t, "status = 'settled'"); n != 1 {
		t.Fatalf("settled records = %d, want 1 (ppt step only)", n)
	}
	var cost float64
	if err := testDB.QueryRow(
		"SELECT vendor_cost FROM usage_records WHERE capability = 'ppt'").Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 0.8 {
		t.Fatalf("ppt vendor_cost = %v, want 0.8", cost)
	}

	e.ppt.mu.Lock()
	h := e.ppt.lastHeader
	body := e.ppt.lastBody
	e.ppt.mu.Unlock()
	if h.Get("X-Partner-Key") != "partner-key-test" || h.Get("X-Org-Id") != e.orgID ||
		h.Get("X-Member-Id") != e.memberID || h.Get("X-Job-Id") == "" {
		t.Fatalf("partner 头缺失: %v", h)
	}
	if _, ok := body["document"]; ok {
		t.Fatalf("must not send singular document (方向二): %#v", body["document"])
	}
	if body["style"] != "editorial" {
		t.Fatalf("style = %#v, want editorial", body["style"])
	}
	docs, _ := body["documents"].([]any)
	if len(docs) < 1 {
		t.Fatalf("documents = %#v", body["documents"])
	}
	roles := map[string]int{}
	var textbook map[string]any
	for _, raw := range docs {
		d, _ := raw.(map[string]any)
		role, _ := d["role"].(string)
		roles[role]++
		if role == "textbook" {
			textbook = d
		}
		if _, ok := d["content"]; ok && d["content"] != nil && d["content"] != "" {
			t.Fatalf("must not send gateway design/outline content: %#v", d)
		}
	}
	if roles["textbook"] != 1 || roles["teaching_design"] != 0 {
		t.Fatalf("roles = %v", roles)
	}
	url, _ := textbook["url"].(string)
	if textbook["content"] != nil {
		t.Fatalf("textbook must forward the file URL, not extracted text: %#v", textbook)
	}
	if !strings.Contains(url, "https://app.example.test/media/") || !strings.Contains(url, "0.txt") {
		t.Fatalf("textbook url = %q", url)
	}
	if _, ok := body["confirmed_outline"]; ok {
		t.Fatalf("first generate must not send confirmed_outline: %#v", body["confirmed_outline"])
	}
}

func TestPackPPTDocuments(t *testing.T) {
	docs := packPPTDocuments(
		[]pptFile{
			{Name: "课文.pdf", URL: "https://files.example.test/a.pdf"},
			{Name: "参考.docx", URL: "https://files.example.test/b.docx"},
		},
	)
	if len(docs) != 2 {
		t.Fatalf("len=%d %#v", len(docs), docs)
	}
	if docs[0].Role != "textbook" || docs[0].URL != "https://files.example.test/a.pdf" || docs[0].Content != "" {
		t.Fatalf("textbook = %#v", docs[0])
	}
	if docs[1].Role != "reference" || docs[1].URL != "https://files.example.test/b.docx" || docs[1].Content != "" {
		t.Fatalf("extra material = %#v", docs[1])
	}

	many := make([]pptFile, 8)
	for i := range many {
		many[i] = pptFile{Name: fmt.Sprintf("%d.pdf", i+1), URL: fmt.Sprintf("https://files.example.test/%d.pdf", i+1)}
	}
	capped := packPPTDocuments(many)
	if len(capped) != 5 {
		t.Fatalf("cap len=%d", len(capped))
	}
	if capped[0].Role != "textbook" {
		t.Fatalf("priority lost: %#v", capped)
	}
	for i := 1; i < 5; i++ {
		if capped[i].Role != "reference" || capped[i].Content != "" {
			t.Fatalf("slot %d = %#v", i, capped[i])
		}
	}
}

func TestSubmitSettlesPptWithoutConfirm(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	if lesson.Status != "succeeded" {
		t.Fatalf("status = %s", lesson.Status)
	}
	if used := poolUsed(t, e.pptPool); used != 1 {
		t.Fatalf("ppt pool used = %v, want 1", used)
	}
	if n := countUsageRecords(t, "status = 'reserved'"); n != 0 {
		t.Fatalf("reserved records = %d, want 0", n)
	}
}

// notes 为空 → ppt step failed、预扣 refunded、package partial（契约 C4 硬约束）。
func TestPPTNotesMissing(t *testing.T) {
	e := newEnv(t)
	e.ppt.notesEmpty.Store(true)
	lesson := e.submit(t)

	if s := jobStatus(t, lesson.LessonJobID); s != "failed" {
		t.Fatalf("lesson status = %s, want failed", s)
	}
	if s := packageStatus(t, lesson.PackageID); s != "partial" {
		t.Fatalf("package status = %s, want partial", s)
	}
	// 预扣全额退回。
	if used := poolUsed(t, e.pptPool); used != 0 {
		t.Fatalf("ppt pool used = %v, want 0", used)
	}
	if n := countUsageRecords(t, "capability = 'ppt' AND status = 'refunded'"); n != 1 {
		t.Fatalf("refunded ppt records = %d, want 1", n)
	}
	// step 诊断含 notes_missing。
	var report string
	if err := testDB.QueryRow(
		"SELECT cost_report FROM jobs WHERE parent_id = ? AND capability = 'ppt'",
		lesson.LessonJobID).Scan(&report); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(report, "notes_missing") {
		t.Fatalf("cost_report = %s, want notes_missing", report)
	}
}

// 大纲缺失 → ppt step failed、预扣 refunded（契约 C8 硬约束）。
func TestPPTOutlineMissing(t *testing.T) {
	e := newEnv(t)
	e.ppt.outlineEmpty.Store(true)
	lesson := e.submit(t)
	if s := jobStatus(t, lesson.LessonJobID); s != "failed" {
		t.Fatalf("lesson status = %s, want failed", s)
	}
	if s := packageStatus(t, lesson.PackageID); s != "partial" {
		t.Fatalf("package status = %s, want partial", s)
	}
	if used := poolUsed(t, e.pptPool); used != 0 {
		t.Fatalf("ppt pool used = %v, want 0", used)
	}
	if n := countUsageRecords(t, "capability = 'ppt' AND status = 'refunded'"); n != 1 {
		t.Fatalf("refunded ppt records = %d, want 1", n)
	}
	var report string
	if err := testDB.QueryRow(
		"SELECT cost_report FROM jobs WHERE parent_id = ? AND capability = 'ppt'",
		lesson.LessonJobID).Scan(&report); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(report, "outline_missing") {
		t.Fatalf("cost_report = %s, want outline_missing", report)
	}
}

// partner 5xx → step failed、退款；billing 不受影响（后续 submit 正常）。
func TestPartner5xx(t *testing.T) {
	e := newEnv(t)
	e.ppt.failGenerate.Store(true)
	lesson := e.submit(t)
	if s := jobStatus(t, lesson.LessonJobID); s != "failed" {
		t.Fatalf("lesson status = %s, want failed", s)
	}
	if used := poolUsed(t, e.pptPool); used != 0 {
		t.Fatalf("ppt pool used = %v, want 0", used)
	}

	// billing 未被拖挂：恢复 partner 后重跑全链路成功。
	e.ppt.failGenerate.Store(false)
	lesson2 := e.submit(t)
	if s := jobStatus(t, lesson2.LessonJobID); s != "succeeded" {
		t.Fatalf("第二次 lesson status = %s, want succeeded", s)
	}
}

// Rebuild(ppt) 两次 → 三个版本行、is_current 指最新、每版可 Open（设计 §3 留版本）。
func TestRebuildPptVersions(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	for i := 0; i < 2; i++ {
		if err := e.exec.Rebuild(context.Background(), lesson.PackageID, "ppt", "第 2 页案例换掉"); err != nil {
			t.Fatal(err)
		}
	}

	rows, err := testDB.Query(
		"SELECT version, is_current, storage_ref FROM artifacts WHERE package_id = ? AND kind = 'ppt' ORDER BY version",
		lesson.PackageID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type ver struct {
		version int
		current bool
		ref     string
	}
	var vers []ver
	for rows.Next() {
		var v ver
		if err := rows.Scan(&v.version, &v.current, &v.ref); err != nil {
			t.Fatal(err)
		}
		vers = append(vers, v)
	}
	if len(vers) != 3 {
		t.Fatalf("ppt versions = %d, want 3", len(vers))
	}
	for i, v := range vers {
		wantCurrent := i == len(vers)-1
		if v.current != wantCurrent {
			t.Fatalf("version %d is_current = %v, want %v", v.version, v.current, wantCurrent)
		}
		rc, err := e.store.Open(context.Background(), v.ref)
		if err != nil {
			t.Fatalf("version %d 不可 Open: %v", v.version, err)
		}
		rc.Close()
	}
	// 1（首轮 ppt）+ 2×1（ppt rebuild）= 3 条 settled；重试是新 job 新预扣。
	if n := countUsageRecords(t, "status = 'settled'"); n != 3 {
		t.Fatalf("settled records = %d, want 3", n)
	}
	if s := packageStatus(t, lesson.PackageID); s != "ready" {
		t.Fatalf("package status = %s, want ready", s)
	}
}

// Rebuild 须把当前课件大纲作为 confirmed_outline 写回（契约 C8.2）。
func TestRebuildSendsConfirmedOutline(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	if err := e.exec.Rebuild(context.Background(), lesson.PackageID, "ppt", "换案例"); err != nil {
		t.Fatal(err)
	}
	e.ppt.mu.Lock()
	body := e.ppt.lastBody
	e.ppt.mu.Unlock()
	raw, ok := body["confirmed_outline"]
	if !ok {
		t.Fatal("rebuild must send confirmed_outline")
	}
	b, _ := json.Marshal(raw)
	if !strings.Contains(string(b), "导数") || !strings.Contains(string(b), "slides") {
		t.Fatalf("confirmed_outline = %s", b)
	}
	var n int
	if err := testDB.QueryRow(
		"SELECT COUNT(*) FROM artifacts WHERE package_id = ? AND kind = 'outline'", lesson.PackageID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("outline versions = %d, want 2", n)
	}
}

// outline 随 ppt 整份重出，不能单独 Rebuild。
func TestRebuildOutlineAloneRejected(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	err := e.exec.Rebuild(context.Background(), lesson.PackageID, "outline", "")
	if !errors.Is(err, ErrRebuildKind) {
		t.Fatalf("err=%v, want ErrRebuildKind", err)
	}
	if s := packageStatus(t, lesson.PackageID); s != "ready" {
		t.Fatalf("package status = %s, want ready", s)
	}
}

// (org, platform) 信号量：同键并发 in-flight 不超 2（默认），全部最终完成。
func TestSemaphoreFairness(t *testing.T) {
	e := newEnv(t)
	e.ppt.block = make(chan struct{})
	release := e.ppt.block

	const n = 5
	lessons := make([]string, n)
	lessons[0] = e.courseLessonID
	for i := 1; i < n; i++ {
		lessons[i] = e.extraLesson(t, fmt.Sprintf("第 %d 课", i+1))
	}
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = e.exec.SubmitLesson(context.Background(), SubmitInput{
				OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: lessons[i], Title: "导数",
			})
		}(i)
	}

	// 等所有 goroutine 进入竞争后，断言并发峰值。
	time.Sleep(200 * time.Millisecond)
	if m := e.ppt.max.Load(); m > 2 {
		t.Fatalf("PPT 并发峰值 = %d, want <= 2", m)
	}
	close(release) // 放行全部
	// block 关闭后后续请求读已关 channel 立即返回
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}

// 状态机非法迁移被拒（如 queued → succeeded 直跳）。
func TestIllegalTransition(t *testing.T) {
	resetTables(t)
	f := newFixture(t)
	svc := New(testDB, billing.New(testDB), f.store, nil, nil)

	jobID := ulidStr()
	execSQL(t, `INSERT INTO jobs (id, org_id, project_id, kind, status) VALUES (?, ?, ?, 'step', 'queued')`,
		jobID, f.orgID, f.projectID)

	err := svc.transition(context.Background(), jobID, "queued", "succeeded")
	if err == nil || !strings.Contains(err.Error(), "illegal") {
		t.Fatalf("want ErrIllegalTransition, got %v", err)
	}
	if s := jobStatus(t, jobID); s != "queued" {
		t.Fatalf("status = %s, want queued（未被改动）", s)
	}
	// 合法路径不受影响。
	if err := svc.transition(context.Background(), jobID, "queued", "running"); err != nil {
		t.Fatal(err)
	}
	if err := svc.transition(context.Background(), jobID, "running", "succeeded"); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyMaterialStillForwardsFile(t *testing.T) {
	e := newEnv(t)
	execSQL(t, "DELETE FROM materials WHERE lesson_id = ?", e.courseLessonID)
	key := fmt.Sprintf("org/%s/material/empty.txt", e.orgID)
	if err := e.store.Put(context.Background(), key, stringReader("   \n  "), "text/plain"); err != nil {
		t.Fatal(err)
	}
	execSQL(t, "INSERT INTO materials (id, project_id, lesson_id, kind, filename, storage_ref, uploaded_by) VALUES (?, ?, ?, 'text', 'empty.txt', ?, ?)",
		ulidStr(), e.projectID, e.courseLessonID, key, e.memberID)

	lesson, err := e.exec.SubmitLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
	})
	if err != nil {
		t.Fatal(err)
	}
	if lesson.Status != "succeeded" {
		t.Fatalf("status = %s, want succeeded (empty extract must not block submit)", lesson.Status)
	}
	e.ppt.mu.Lock()
	body := e.ppt.lastBody
	e.ppt.mu.Unlock()
	docs, _ := body["documents"].([]any)
	var textbook map[string]any
	for _, raw := range docs {
		d, _ := raw.(map[string]any)
		if d["role"] == "textbook" {
			textbook = d
		}
	}
	url, _ := textbook["url"].(string)
	if textbook["content"] != nil || !strings.Contains(url, "empty.txt") {
		t.Fatalf("empty file must still be forwarded by url: %#v", textbook)
	}
}

func TestSignMaterialURLRequiresPublicBase(t *testing.T) {
	e := newEnv(t)
	e.exec.publicBase = ""
	_, err := e.exec.signMaterialURL(context.Background(), "org/x/material/a.txt")
	if err == nil {
		t.Fatal("want error when publicBase empty")
	}
}

func TestCorruptFileStillForwards(t *testing.T) {
	e := newEnv(t)
	execSQL(t, "DELETE FROM materials WHERE lesson_id = ?", e.courseLessonID)
	key := fmt.Sprintf("org/%s/material/bad.docx", e.orgID)
	if err := e.store.Put(context.Background(), key, stringReader("not-a-docx"), "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	execSQL(t, "INSERT INTO materials (id, project_id, lesson_id, kind, filename, storage_ref, uploaded_by) VALUES (?, ?, ?, 'docx', 'bad.docx', ?, ?)",
		ulidStr(), e.projectID, e.courseLessonID, key, e.memberID)

	lesson, err := e.exec.SubmitLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
	})
	if err != nil {
		t.Fatal(err)
	}
	if lesson.Status != "succeeded" {
		t.Fatalf("status = %s, want succeeded (local extract failure must not block file handoff)", lesson.Status)
	}
	e.ppt.mu.Lock()
	body := e.ppt.lastBody
	e.ppt.mu.Unlock()
	docs, _ := body["documents"].([]any)
	var textbook map[string]any
	for _, raw := range docs {
		d, _ := raw.(map[string]any)
		if d["role"] == "textbook" {
			textbook = d
		}
	}
	url, _ := textbook["url"].(string)
	if textbook["content"] != nil || !strings.Contains(url, "bad.docx") {
		t.Fatalf("corrupt file must still be forwarded by url: %#v", textbook)
	}
}

func TestStartLessonConcurrentIdempotent(t *testing.T) {
	e := newEnv(t)
	e.ppt.block = make(chan struct{})

	type result struct {
		lesson *Lesson
		err    error
	}
	ch := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			lesson, err := e.exec.StartLesson(context.Background(), SubmitInput{
				OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
			})
			ch <- result{lesson, err}
		}()
	}
	a, b := <-ch, <-ch
	close(e.ppt.block)

	var created, skipped result
	switch {
	case a.err == nil && errors.As(b.err, new(*InFlightError)):
		created, skipped = a, b
	case b.err == nil && errors.As(a.err, new(*InFlightError)):
		created, skipped = b, a
	default:
		t.Fatalf("want one created and one in-flight, got %v / %v", a.err, b.err)
	}
	var inflight *InFlightError
	if !errors.As(skipped.err, &inflight) {
		t.Fatal("skipped is not InFlightError")
	}
	if created.lesson.LessonJobID != inflight.JobID || created.lesson.PackageID != inflight.PackageID {
		t.Fatalf("created=%+v inflight=%+v", created.lesson, inflight)
	}
	var n int
	if err := testDB.QueryRow("SELECT COUNT(*) FROM jobs WHERE project_id = ? AND kind = 'lesson'", e.projectID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("lesson jobs = %d, want 1", n)
	}
	waitJobStatus(t, created.lesson.LessonJobID, "succeeded")
}

// image 材料无法作为文件转交：明确报错。pdf/docx/md/txt 原文件转交 PPTCreator。
func TestMaterialKindUnsupported(t *testing.T) {
	e := newEnv(t)
	execSQL(t, "INSERT INTO materials (id, project_id, lesson_id, kind, storage_ref, uploaded_by) VALUES (?, ?, ?, 'image', 'x.png', ?)",
		ulidStr(), e.projectID, e.courseLessonID, e.memberID)

	_, err := e.exec.SubmitLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
	})
	if err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("want ErrMaterialKindUnsupported, got %v", err)
	}
}

// StartLesson 立即返回 running，不阻塞在 partner；后台跑完后 succeeded。
func TestStartLessonReturnsImmediately(t *testing.T) {
	e := newEnv(t)
	e.ppt.block = make(chan struct{})

	start := time.Now()
	lesson, err := e.exec.StartLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
	})
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 150*time.Millisecond {
		t.Fatalf("StartLesson blocked %s, want immediate return", time.Since(start))
	}
	if lesson.Status != "running" {
		t.Fatalf("status = %s, want running", lesson.Status)
	}

	close(e.ppt.block)
	waitJobStatus(t, lesson.LessonJobID, "succeeded")
}

// 进程重启：残留 running（lesson + step）一律 failed，package partial。
func TestRecoverInFlightAbortsRunning(t *testing.T) {
	e := newEnv(t)
	lessonID, packageID, stepID := ulidStr(), ulidStr(), ulidStr()
	execSQL(t, `INSERT INTO jobs (id, org_id, project_id, package_id, kind, status) VALUES (?, ?, ?, ?, 'lesson', 'running')`,
		lessonID, e.orgID, e.projectID, packageID)
	execSQL(t, `INSERT INTO course_packages (id, project_id, lesson_id, status, lesson_job_id) VALUES (?, ?, ?, 'building', ?)`,
		packageID, e.projectID, e.courseLessonID, lessonID)
	execSQL(t, `INSERT INTO jobs (id, org_id, project_id, package_id, parent_id, kind, capability, status) VALUES (?, ?, ?, ?, ?, 'step', 'design', 'running')`,
		stepID, e.orgID, e.projectID, packageID, lessonID)

	n, err := e.exec.RecoverInFlight(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("aborted = %d, want 2", n)
	}
	if s := jobStatus(t, lessonID); s != "failed" {
		t.Fatalf("lesson status = %s, want failed", s)
	}
	if s := jobStatus(t, stepID); s != "failed" {
		t.Fatalf("step status = %s, want failed", s)
	}
	if s := packageStatus(t, packageID); s != "partial" {
		t.Fatalf("package status = %s, want partial", s)
	}
}

// 超时收敛：running 且 updated_at 过旧 → failed；刚更新的 running 留下。
func TestSweepTimedOut(t *testing.T) {
	e := newEnv(t)
	staleID, freshID := ulidStr(), ulidStr()
	execSQL(t, `INSERT INTO jobs (id, org_id, project_id, kind, status) VALUES (?, ?, ?, 'step', 'running')`,
		staleID, e.orgID, e.projectID)
	execSQL(t, `INSERT INTO jobs (id, org_id, project_id, kind, status) VALUES (?, ?, ?, 'step', 'running')`,
		freshID, e.orgID, e.projectID)
	execSQL(t, `UPDATE jobs SET updated_at = DATE_SUB(NOW(3), INTERVAL 2 HOUR) WHERE id = ?`, staleID)

	n, err := e.exec.SweepTimedOut(context.Background(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("timed out = %d, want 1", n)
	}
	if s := jobStatus(t, staleID); s != "failed" {
		t.Fatalf("stale status = %s, want failed", s)
	}
	if s := jobStatus(t, freshID); s != "running" {
		t.Fatalf("fresh status = %s, want running", s)
	}
}

// get_package：尚无构件时 artifacts 必须是 JSON 空数组，不能是 null（工作台 .map 会崩）。
func TestGetPackageEmptyArtifactsJSON(t *testing.T) {
	e := newEnv(t)
	packageID := ulidStr()
	execSQL(t, `INSERT INTO course_packages (id, project_id, lesson_id, status) VALUES (?, ?, ?, 'building')`,
		packageID, e.projectID, e.courseLessonID)
	pkg, err := e.exec.GetPackage(context.Background(), packageID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["artifacts"].([]any); !ok {
		t.Fatalf("artifacts = %#v, want []", m["artifacts"])
	}
}

// get_package：当前指针 + 版本列表 + 签名 URL；返回值不含文件字节。
func TestGetPackageSignedURLs(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)

	pkg, err := e.exec.GetPackage(context.Background(), lesson.PackageID, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Status != "ready" || pkg.LessonStatus != "succeeded" {
		t.Fatalf("package=%s lesson=%s", pkg.Status, pkg.LessonStatus)
	}
	kinds := map[string]bool{}
	for _, a := range pkg.Artifacts {
		kinds[a.Kind] = true
		if a.Current == nil || a.Current.URL == "" {
			t.Fatalf("kind %s missing current URL", a.Kind)
		}
		if !strings.HasPrefix(a.Current.URL, "/media/") {
			t.Fatalf("url = %q, want /media/ prefix (no file bytes)", a.Current.URL)
		}
		if strings.Contains(a.Current.URL, fakePptxBytes) || strings.Contains(a.Current.URL, fakeNotesJSON) {
			t.Fatalf("url leaked file contents: %s", a.Current.URL)
		}
		if len(a.Versions) < 1 {
			t.Fatalf("kind %s versions empty", a.Kind)
		}
	}
	for _, k := range []string{"outline", "ppt", "script"} {
		if !kinds[k] {
			t.Fatalf("missing artifact kind %s", k)
		}
	}
	if kinds["design"] {
		t.Fatalf("gateway design must not appear: %v", kinds)
	}
}

func TestUnknownPresetSubmitFails(t *testing.T) {
	e := newEnv(t)
	execSQL(t, "UPDATE projects SET preset_id = 'no_such_pack' WHERE id = ?", e.projectID)
	_, err := e.exec.SubmitLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
	})
	if !errors.Is(err, ErrUnknownPreset) {
		t.Fatalf("err=%v, want ErrUnknownPreset", err)
	}
}

const importedPptx = "teacher-edited-pptx-bytes"

func TestImportPPTAsNewVersion(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	if lesson.Status != "succeeded" {
		t.Fatalf("status = %s", lesson.Status)
	}
	var materialsBefore, usageBefore int
	if err := testDB.QueryRow("SELECT COUNT(*) FROM materials WHERE lesson_id = ?", e.courseLessonID).Scan(&materialsBefore); err != nil {
		t.Fatal(err)
	}
	usageBefore = countUsageRecords(t, "1=1")

	got, err := e.exec.ImportPPT(context.Background(), e.orgID, lesson.PackageID, "导数-改过.pptx", []byte(importedPptx))
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 2 || got.Kind != "ppt" {
		t.Fatalf("import = %+v, want version 2 ppt", got)
	}

	rows, err := testDB.Query(
		"SELECT version, is_current, storage_ref, step_job_id FROM artifacts WHERE package_id = ? AND kind = 'ppt' ORDER BY version",
		lesson.PackageID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type ver struct {
		version int
		current bool
		ref     string
		step    sql.NullString
	}
	var vers []ver
	for rows.Next() {
		var v ver
		if err := rows.Scan(&v.version, &v.current, &v.ref, &v.step); err != nil {
			t.Fatal(err)
		}
		vers = append(vers, v)
	}
	if len(vers) != 2 {
		t.Fatalf("ppt versions = %d, want 2", len(vers))
	}
	if vers[0].current || !vers[1].current {
		t.Fatalf("current pointer: v1=%v v2=%v", vers[0].current, vers[1].current)
	}
	if vers[1].step.Valid {
		t.Fatalf("import must not attach step_job_id: %v", vers[1].step)
	}
	rc, err := e.store.Open(context.Background(), vers[1].ref)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(rc)
	rc.Close()
	if string(data) != importedPptx {
		t.Fatalf("current pptx = %q", data)
	}
	old, err := e.store.Open(context.Background(), vers[0].ref)
	if err != nil {
		t.Fatalf("old version must remain: %v", err)
	}
	old.Close()

	var materialsAfter int
	if err := testDB.QueryRow("SELECT COUNT(*) FROM materials WHERE lesson_id = ?", e.courseLessonID).Scan(&materialsAfter); err != nil {
		t.Fatal(err)
	}
	if materialsAfter != materialsBefore {
		t.Fatalf("materials %d → %d, 导回不得写成 Material", materialsBefore, materialsAfter)
	}
	if n := countUsageRecords(t, "1=1"); n != usageBefore {
		t.Fatalf("usage records %d → %d, 导回不得产生 UsageRecord", usageBefore, n)
	}
	if s := packageStatus(t, lesson.PackageID); s != "ready" {
		t.Fatalf("package status = %s, want ready", s)
	}
}

func TestImportPPTRequiresCurrent(t *testing.T) {
	e := newEnv(t)
	packageID := ulidStr()
	execSQL(t, `INSERT INTO course_packages (id, project_id, lesson_id, status) VALUES (?, ?, ?, 'building')`,
		packageID, e.projectID, e.courseLessonID)
	_, err := e.exec.ImportPPT(context.Background(), e.orgID, packageID, "a.pptx", []byte(importedPptx))
	if !errors.Is(err, ErrNoCurrentPPT) {
		t.Fatalf("err=%v, want ErrNoCurrentPPT", err)
	}
}

func TestImportPPTRejectsNonPptx(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	_, err := e.exec.ImportPPT(context.Background(), e.orgID, lesson.PackageID, "讲稿.docx", []byte(importedPptx))
	if !errors.Is(err, ErrNotPPTX) {
		t.Fatalf("err=%v, want ErrNotPPTX", err)
	}
}

func TestImportPPTRejectsSuspendedOrg(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	execSQL(t, "UPDATE orgs SET status = 'suspended' WHERE id = ?", e.orgID)
	_, err := e.exec.ImportPPT(context.Background(), e.orgID, lesson.PackageID, "改过.pptx", []byte(importedPptx))
	if !errors.Is(err, ErrOrgSuspended) {
		t.Fatalf("err=%v, want ErrOrgSuspended", err)
	}
	var n int
	if err := testDB.QueryRow(
		"SELECT COUNT(*) FROM artifacts WHERE package_id = ? AND kind = 'ppt'", lesson.PackageID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("ppt versions = %d, want 1 (suspended import must not write)", n)
	}
	if countUsageRecords(t, "1=1") != 1 {
		t.Fatalf("usage records changed after denied import")
	}
}

func TestImportPPTConcurrentKeepsEachVersion(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	bodies := []string{"import-A-pptx-bytes", "import-B-pptx-bytes"}

	type outcome struct {
		body string
		res  *ImportResult
		err  error
	}
	ch := make(chan outcome, 2)
	for i, body := range bodies {
		go func(i int, body string) {
			res, err := e.exec.ImportPPT(context.Background(), e.orgID, lesson.PackageID, fmt.Sprintf("改-%d.pptx", i), []byte(body))
			ch <- outcome{body, res, err}
		}(i, body)
	}
	got := []outcome{<-ch, <-ch}
	for _, o := range got {
		if o.err != nil {
			t.Fatalf("concurrent import: %v", o.err)
		}
	}

	rows, err := testDB.Query(
		"SELECT version, is_current, storage_ref FROM artifacts WHERE package_id = ? AND kind = 'ppt' ORDER BY version",
		lesson.PackageID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type ver struct {
		version int
		current bool
		ref     string
	}
	var vers []ver
	seenRef := map[string]bool{}
	for rows.Next() {
		var v ver
		if err := rows.Scan(&v.version, &v.current, &v.ref); err != nil {
			t.Fatal(err)
		}
		if seenRef[v.ref] {
			t.Fatalf("storage_ref reused: %s (concurrent import clobbered an object key)", v.ref)
		}
		seenRef[v.ref] = true
		vers = append(vers, v)
	}
	if len(vers) != 3 {
		t.Fatalf("ppt versions = %d, want 3", len(vers))
	}
	if !vers[len(vers)-1].current {
		t.Fatalf("current not latest: %+v", vers)
	}

	open := func(ref string) string {
		t.Helper()
		rc, err := e.store.Open(context.Background(), ref)
		if err != nil {
			t.Fatal(err)
		}
		defer rc.Close()
		data, _ := io.ReadAll(rc)
		return string(data)
	}
	if open(vers[0].ref) != fakePptxBytes {
		t.Fatalf("v1 clobbered: %q", open(vers[0].ref))
	}
	for _, o := range got {
		var ref string
		if err := testDB.QueryRow(
			"SELECT storage_ref FROM artifacts WHERE package_id = ? AND kind = 'ppt' AND version = ?",
			lesson.PackageID, o.res.Version).Scan(&ref); err != nil {
			t.Fatal(err)
		}
		if gotBytes := open(ref); gotBytes != o.body {
			t.Fatalf("version %d = %q, want %q (committed object overwritten)", o.res.Version, gotBytes, o.body)
		}
	}
}

func TestImportPPTRejectsWhileRebuilding(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	e.ppt.block = make(chan struct{})

	errc := make(chan error, 1)
	go func() {
		errc <- e.exec.Rebuild(context.Background(), lesson.PackageID, "ppt", "换案例")
	}()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if packageStatus(t, lesson.PackageID) == "building" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if packageStatus(t, lesson.PackageID) != "building" {
		t.Fatal("rebuild never set package building")
	}

	_, err := e.exec.ImportPPT(context.Background(), e.orgID, lesson.PackageID, "改过.pptx", []byte(importedPptx))
	close(e.ppt.block)
	rebuildErr := <-errc
	if !errors.Is(err, ErrPPTBusy) {
		t.Fatalf("err=%v, want ErrPPTBusy", err)
	}
	if rebuildErr != nil {
		t.Fatal(rebuildErr)
	}
}

func TestReshapeLessonPlan(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	got, err := e.exec.ReshapeLessonPlan(context.Background(), e.orgID, lesson.PackageID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "plan" || got.Version != 1 {
		t.Fatalf("%+v", got)
	}
	var ref string
	if err := testDB.QueryRow(
		"SELECT storage_ref FROM artifacts WHERE package_id = ? AND kind = 'plan' AND is_current = 1",
		lesson.PackageID).Scan(&ref); err != nil {
		t.Fatal(err)
	}
	rc, err := e.store.Open(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(rc)
	rc.Close()
	if !strings.Contains(string(data), `"课题"`) || !strings.Contains(string(data), "第一页讲稿") {
		t.Fatalf("plan = %s", data)
	}
	if s := packageStatus(t, lesson.PackageID); s != "ready" {
		t.Fatalf("package status = %s, want ready", s)
	}
	if n := countUsageRecords(t, "1=1"); n != 1 {
		t.Fatalf("usage records = %d, want 1 (reshape must not bill)", n)
	}
}

func TestReshapeLessonPlanRequiresScript(t *testing.T) {
	e := newEnv(t)
	pkgID := ulidStr()
	execSQL(t, "INSERT INTO course_packages (id, project_id, lesson_id, status) VALUES (?, ?, ?, 'draft')",
		pkgID, e.projectID, e.courseLessonID)
	_, err := e.exec.ReshapeLessonPlan(context.Background(), e.orgID, pkgID)
	if !errors.Is(err, ErrNoScript) {
		t.Fatalf("err=%v, want ErrNoScript", err)
	}
}

func waitJobStatus(t *testing.T, jobID, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if jobStatus(t, jobID) == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s status = %s, want %s", jobID, jobStatus(t, jobID), want)
}
