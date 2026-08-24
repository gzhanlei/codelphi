package execution

import (
	"context"
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

	mu         sync.Mutex
	lastHeader http.Header    // 最近一次 create_ppt_from_documents 的头（断言 C1）
	lastBody   map[string]any // 该次 tools/call 的 arguments（断言材料包）
}

const (
	fakePptxBytes  = "fake-pptx-bytes"
	fakeNotesJSON  = `[{"page":1,"note":"第一页讲稿"},{"page":2,"note":"第二页讲稿"}]`
	fakeScriptDocx = "fake-script-docx"
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
			if f.failGenerate.Load() {
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, `{"error":{"code":"internal","message":"boom","retryable":true}}`)
				return
			}
			writeMCPTool(w, map[string]any{"project_id": "pj-1", "status": "queued"})
		case "get_generation_status":
			writeMCPTool(w, map[string]any{
				"status": "COMPLETED",
				"usage":  map[string]any{"pages": 2, "llm_tokens": 500},
				"cost":   map[string]string{"currency": "CNY", "vendor_cost": "0.800000"},
				"result": map[string]string{
					"pptx_url":   f.srv.URL + "/files/pptx",
					"notes_url":  f.srv.URL + "/files/notes",
					"script_url": f.srv.URL + "/files/script",
				},
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

// 全链路 happy path：submit → design/outline → awaiting_confirm（此时无 ppt 预扣）
// → confirm → ppt+script artifact 齐、package ready、4 条 UsageRecord 全部 settled。
func TestHappyPath(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)

	if lesson.Status != "awaiting_confirm" {
		t.Fatalf("lesson status = %s, want awaiting_confirm", lesson.Status)
	}
	// 确认门等待期：ppt 根池无任何预扣（设计 §4：确认门等待期间不持有预扣）。
	if used := poolUsed(t, e.pptPool); used != 0 {
		t.Fatalf("awaiting_confirm 时 ppt pool used = %v, want 0", used)
	}
	// design/outline 已按实际 token settled（假 LLM 回报 300 tokens）。
	if used := poolUsed(t, e.designPool); used != 300 {
		t.Fatalf("design pool used = %v, want 300", used)
	}
	if n := countUsageRecords(t, "status = 'settled'"); n != 2 {
		t.Fatalf("settled records = %d, want 2", n)
	}

	if _, err := e.exec.ConfirmLesson(context.Background(), lesson.LessonJobID); err != nil {
		t.Fatal(err)
	}
	if s := jobStatus(t, lesson.LessonJobID); s != "succeeded" {
		t.Fatalf("lesson status = %s, want succeeded", s)
	}
	if s := packageStatus(t, lesson.PackageID); s != "ready" {
		t.Fatalf("package status = %s, want ready", s)
	}

	// 四个构件齐，pptx 内容经回拷可 Open。
	for _, kind := range []string{"design", "outline", "ppt", "script"} {
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
		if kind == "script" && string(data) != fakeNotesJSON {
			t.Fatalf("notes 内容 = %q", data)
		}
	}
	// 台账 3 条 settled：design / outline / ppt 三个 step 各一条。
	// 注：门禁清单写「4 条」，但 script 不是独立 step——讲稿随 ppt 同一次 partner 生成回报（§2.1），
	// 按 step 扣费（§4）即 3 条。出入已在报告里标注。
	if n := countUsageRecords(t, "status = 'settled'"); n != 3 {
		t.Fatalf("settled records = %d, want 3", n)
	}
	// ppt 的 vendor_cost 透传 C3 回报。
	var cost float64
	if err := testDB.QueryRow(
		"SELECT vendor_cost FROM usage_records WHERE capability = 'ppt'").Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 0.8 {
		t.Fatalf("ppt vendor_cost = %v, want 0.8", cost)
	}

	// C1 头断言。
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
	docs, _ := body["documents"].([]any)
	if len(docs) < 3 {
		t.Fatalf("documents = %#v", body["documents"])
	}
	roles := map[string]int{}
	var textbook string
	for _, raw := range docs {
		d, _ := raw.(map[string]any)
		role, _ := d["role"].(string)
		roles[role]++
		if role == "textbook" {
			textbook, _ = d["content"].(string)
		}
	}
	if roles["textbook"] != 1 || roles["teaching_design"] != 1 {
		t.Fatalf("roles = %v", roles)
	}
	if !strings.Contains(textbook, "导数的定义") {
		t.Fatalf("textbook = %q", textbook)
	}
}

func TestPackPPTDocuments(t *testing.T) {
	docs := packPPTDocuments(
		[]string{"导数的定义：差商的极限……", "几何意义：切线斜率……", "短"},
		`{"教学目标":["理解导数"]}`,
		`{"条目":[{"节":"1"}]}`,
	)
	if len(docs) != 4 {
		t.Fatalf("len=%d %#v", len(docs), docs)
	}
	if docs[0].Role != "textbook" || !strings.Contains(docs[0].Content, "导数的定义") {
		t.Fatalf("textbook = %#v", docs[0])
	}
	if docs[1].Role != "teaching_design" {
		t.Fatalf("design = %#v", docs[1])
	}
	if docs[2].Role != "reference" || !strings.Contains(docs[2].Content, "条目") {
		t.Fatalf("outline = %#v", docs[2])
	}
	if docs[3].Role != "reference" || !strings.Contains(docs[3].Content, "几何意义") {
		t.Fatalf("extra material = %#v", docs[3])
	}

	many := make([]string, 8)
	for i := range many {
		many[i] = fmt.Sprintf("这是第 %d 份足够长的课文或参考材料正文", i+1)
	}
	capped := packPPTDocuments(many, `{"教学目标":["x"]}`, `{"条目":[]}`)
	if len(capped) != 5 {
		t.Fatalf("cap len=%d", len(capped))
	}
	if capped[0].Role != "textbook" || capped[1].Role != "teaching_design" {
		t.Fatalf("priority lost: %#v", capped)
	}
	if capped[2].Role != "reference" || !strings.Contains(capped[2].Content, "条目") {
		t.Fatalf("outline dropped when extras fill the cap: %#v", capped)
	}
}

// awaiting_confirm 期间不 confirm：根池无 ppt 残留预扣。
func TestAwaitingConfirmHoldsNoReservation(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	if lesson.Status != "awaiting_confirm" {
		t.Fatalf("status = %s", lesson.Status)
	}
	if used := poolUsed(t, e.pptPool); used != 0 {
		t.Fatalf("ppt pool used = %v, want 0", used)
	}
	if n := countUsageRecords(t, "status = 'reserved'"); n != 0 {
		t.Fatalf("reserved records = %d, want 0（无任何在途预扣）", n)
	}
}

// notes 为空 → ppt step failed、预扣 refunded、package partial（契约 C4 硬约束）。
func TestPPTNotesMissing(t *testing.T) {
	e := newEnv(t)
	e.ppt.notesEmpty.Store(true)
	lesson := e.submit(t)

	if _, err := e.exec.ConfirmLesson(context.Background(), lesson.LessonJobID); err != nil {
		t.Fatal(err)
	}
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

// partner 5xx → step failed、退款；billing 不受影响（后续 submit 正常）。
func TestPartner5xx(t *testing.T) {
	e := newEnv(t)
	e.ppt.failGenerate.Store(true)
	lesson := e.submit(t)
	if _, err := e.exec.ConfirmLesson(context.Background(), lesson.LessonJobID); err != nil {
		t.Fatal(err)
	}
	if s := jobStatus(t, lesson.LessonJobID); s != "failed" {
		t.Fatalf("lesson status = %s, want failed", s)
	}
	if used := poolUsed(t, e.pptPool); used != 0 {
		t.Fatalf("ppt pool used = %v, want 0", used)
	}

	// billing 未被拖挂：恢复 partner 后重跑全链路成功。
	e.ppt.failGenerate.Store(false)
	lesson2 := e.submit(t)
	if _, err := e.exec.ConfirmLesson(context.Background(), lesson2.LessonJobID); err != nil {
		t.Fatal(err)
	}
	if s := jobStatus(t, lesson2.LessonJobID); s != "succeeded" {
		t.Fatalf("第二次 lesson status = %s, want succeeded", s)
	}
}

// Rebuild(ppt) 两次 → 三个版本行、is_current 指最新、每版可 Open（设计 §3 留版本）。
func TestRebuildPptVersions(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	if _, err := e.exec.ConfirmLesson(context.Background(), lesson.LessonJobID); err != nil {
		t.Fatal(err)
	}
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
	// 3（首轮 design/outline/ppt）+ 2×1（ppt rebuild）= 5 条 settled；重试是新 job 新预扣。
	if n := countUsageRecords(t, "status = 'settled'"); n != 5 {
		t.Fatalf("settled records = %d, want 5", n)
	}
	if s := packageStatus(t, lesson.PackageID); s != "ready" {
		t.Fatalf("package status = %s, want ready", s)
	}
}

// 确认门重复 ConfirmLesson 幂等安全：并发两次，只产生一个 ppt step。
func TestConfirmIdempotent(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = e.exec.ConfirmLesson(context.Background(), lesson.LessonJobID)
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := testDB.QueryRow(
		"SELECT COUNT(*) FROM jobs WHERE parent_id = ? AND capability = 'ppt'",
		lesson.LessonJobID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("ppt steps = %d, want 1（重复确认不得重复提交）", n)
	}
	if s := jobStatus(t, lesson.LessonJobID); s != "succeeded" {
		t.Fatalf("lesson status = %s, want succeeded", s)
	}
}

// (org, platform) 信号量：同键并发 in-flight 不超 2（默认），全部最终完成。
func TestSemaphoreFairness(t *testing.T) {
	e := newEnv(t)
	e.llm.block = make(chan struct{})
	release := e.llm.block

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
	if m := e.llm.max.Load(); m > 2 {
		t.Fatalf("LLM 并发峰值 = %d, want <= 2", m)
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

// LLM 产出不合 schema → design step failed、预扣退回，不做自由 Markdown 兜底。
func TestLLMSchemaViolation(t *testing.T) {
	e := newEnv(t)
	e.llm.badJSON.Store(true)

	lesson, err := e.exec.SubmitLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
	})
	if err != nil {
		t.Fatal(err)
	}
	if lesson.Status != "failed" {
		t.Fatalf("lesson status = %s, want failed", lesson.Status)
	}
	if used := poolUsed(t, e.designPool); used != 0 {
		t.Fatalf("design pool used = %v, want 0（预扣已退）", used)
	}
	if n := countUsageRecords(t, "capability = 'design' AND status = 'refunded'"); n != 1 {
		t.Fatalf("refunded design records = %d, want 1", n)
	}
}

func TestNoExtractableText(t *testing.T) {
	e := newEnv(t)
	execSQL(t, "DELETE FROM materials WHERE lesson_id = ?", e.courseLessonID)
	key := fmt.Sprintf("org/%s/material/empty.txt", e.orgID)
	if err := e.store.Put(context.Background(), key, stringReader("   \n  "), "text/plain"); err != nil {
		t.Fatal(err)
	}
	execSQL(t, "INSERT INTO materials (id, project_id, lesson_id, kind, filename, storage_ref, uploaded_by) VALUES (?, ?, ?, 'text', 'empty.txt', ?, ?)",
		ulidStr(), e.projectID, e.courseLessonID, key, e.memberID)

	_, err := e.exec.SubmitLesson(context.Background(), SubmitInput{
		OrgID: e.orgID, MemberID: e.memberID, ProjectID: e.projectID, CourseLessonID: e.courseLessonID, Title: "导数",
	})
	if !errors.Is(err, ErrNoExtractableText) {
		t.Fatalf("want ErrNoExtractableText, got %v", err)
	}
}

func TestStartLessonConcurrentIdempotent(t *testing.T) {
	e := newEnv(t)
	e.llm.block = make(chan struct{})

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
	close(e.llm.block)

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
	waitJobStatus(t, created.lesson.LessonJobID, "awaiting_confirm")
}

// image 材料无法抽文本：明确报错。pdf/docx/md 走 extract。
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

// StartLesson 立即返回 running，不阻塞在 LLM；后台跑完后停在 awaiting_confirm。
func TestStartLessonReturnsImmediately(t *testing.T) {
	e := newEnv(t)
	e.llm.block = make(chan struct{})

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

	close(e.llm.block)
	waitJobStatus(t, lesson.LessonJobID, "awaiting_confirm")
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

// get_package：当前指针 + 版本列表 + 签名 URL；返回值不含文件字节。
func TestGetPackageSignedURLs(t *testing.T) {
	e := newEnv(t)
	lesson := e.submit(t)
	if _, err := e.exec.ConfirmLesson(context.Background(), lesson.LessonJobID); err != nil {
		t.Fatal(err)
	}

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
		if strings.Contains(a.Current.URL, fakePptxBytes) || strings.Contains(a.Current.URL, fakeDesignJSON) {
			t.Fatalf("url leaked file contents: %s", a.Current.URL)
		}
		if len(a.Versions) < 1 {
			t.Fatalf("kind %s versions empty", a.Kind)
		}
	}
	for _, k := range []string{"design", "outline", "ppt", "script"} {
		if !kinds[k] {
			t.Fatalf("missing artifact kind %s", k)
		}
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
