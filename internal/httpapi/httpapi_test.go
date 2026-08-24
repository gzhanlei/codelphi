package httpapi

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codelphi/internal/billing"
	"codelphi/internal/execution"
	"codelphi/internal/execution/adapters/llm"
	"codelphi/internal/execution/adapters/pptcreator"
	"codelphi/internal/identity"
	"codelphi/internal/storage"
)

const (
	fakeDesignJSON  = `{"教学目标":["理解导数定义"],"学情":"已学极限","重难点":["差商极限"],"方法":["讲授","例题"],"流程":[{"环节":"导入","时长":"5min","活动":"回顾极限"}]}`
	fakeOutlineJSON = `{"条目":[{"节":"1","标题":"导数定义","要点":["差商","极限"]}]}`
	fakePptxBytes   = "fake-pptx-bytes"
	fakeNotesJSON   = `[{"page":1,"note":"第一页讲稿"},{"page":2,"note":"第二页讲稿"}]`
)

type apiEnv struct {
	h        http.Handler
	token    string
	orgID    string
	memberID string
	key      *rsa.PrivateKey
	store    *storage.Local
}

func newAPIEnv(t *testing.T) *apiEnv {
	t.Helper()
	resetTables(t)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(jwksJSON(&key.PublicKey))
	}))
	t.Cleanup(jwks.Close)

	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		content := fakeDesignJSON
		if strings.Contains(string(body), "条目") {
			content = fakeOutlineJSON
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": content}}},
			"usage":   map[string]int64{"prompt_tokens": 100, "completion_tokens": 200},
		})
	}))
	t.Cleanup(llmSrv.Close)

	pptMux := http.NewServeMux()
	pptSrv := httptest.NewServer(pptMux)
	t.Cleanup(pptSrv.Close)
	pptMux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		switch rpc.Params.Name {
		case "create_ppt_from_documents":
			text, _ := json.Marshal(map[string]any{"project_id": "pj-1", "status": "queued"})
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": 1,
				"result": map[string]any{"content": []map[string]string{{"type": "text", "text": string(text)}}},
			})
		case "get_generation_status":
			text, _ := json.Marshal(map[string]any{
				"status": "COMPLETED",
				"usage":  map[string]any{"pages": 2, "llm_tokens": 500},
				"cost":   map[string]string{"currency": "CNY", "vendor_cost": "0.800000"},
				"result": map[string]string{
					"pptx_url":  pptSrv.URL + "/files/pptx",
					"notes_url": pptSrv.URL + "/files/notes",
				},
			})
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": 1,
				"result": map[string]any{"content": []map[string]string{{"type": "text", "text": string(text)}}},
			})
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	pptMux.HandleFunc("GET /files/pptx", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, fakePptxBytes) })
	pptMux.HandleFunc("GET /files/notes", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, fakeNotesJSON) })

	orgID, memberID := ulidStr(), ulidStr()
	execSQL(t, "INSERT INTO orgs (id, name, status) VALUES (?, ?, 'active')", orgID, "测试学院")
	execSQL(t, "INSERT INTO members (id, org_id, chandler_sub, role, status) VALUES (?, ?, 'sub-teacher', 'member', 'active')",
		memberID, orgID)
	licenseID := ulidStr()
	snapshot := `[{"capability":"design","quota":1000000,"unit":"count"},` +
		`{"capability":"outline","quota":1000000,"unit":"count"},` +
		`{"capability":"ppt","quota":100,"unit":"count"}]`
	now := time.Now()
	execSQL(t, `INSERT INTO licenses (id, org_id, contract_no, valid_from, valid_to, status, snapshot)
		VALUES (?, ?, ?, ?, ?, 'active', ?)`, licenseID, orgID, "C-"+licenseID, now.AddDate(0, 0, -1), now.AddDate(1, 0, 0), snapshot)
	for _, cap := range []struct {
		c string
		n float64
	}{{"design", 1e6}, {"outline", 1e6}, {"ppt", 100}} {
		execSQL(t, `INSERT INTO quota_pools (id, node_type, node_id, license_id, capability, unit, total, used, period_start, period_end)
			VALUES (?, 'org', ?, ?, ?, 'count', ?, 0, ?, ?)`,
			ulidStr(), orgID, licenseID, cap.c, cap.n, now.AddDate(0, 0, -1), now.AddDate(1, 0, 0))
	}

	store := storage.NewLocal(t.TempDir(), "test-key")
	execSvc := execution.New(testDB, billing.New(testDB), store,
		llm.New(llmSrv.URL, "test-model", ""),
		pptcreator.New(pptSrv.URL, "partner-key-test", pptcreator.WithPoll(time.Millisecond, 5*time.Second)),
		execution.WithMedia("http://gateway.test", 15*time.Minute),
	)
	verifier := identity.NewVerifier(jwks.URL, testIssuer, testClientID)
	resolver := identity.NewResolver(testDB)
	h := New(Deps{
		DB: testDB, Exec: execSvc, Store: store,
		Verifier: verifier, Resolver: resolver,
		MediaTTL: 15 * time.Minute, PublicBase: "http://gateway.test",
	})
	token := signToken(t, key, testKid, validClaims("sub-teacher"))
	return &apiEnv{h: h, token: token, orgID: orgID, memberID: memberID, key: key, store: store}
}

func (e *apiEnv) do(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+e.token)
	req.Header.Set("X-Org-Id", e.orgID)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func decodeErr(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code      string `json:"code"`
			AdminHint string `json:"admin_hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode err: %v body=%s", err, rec.Body.String())
	}
	return body.Error.Code
}

func TestMeUnauthorized(t *testing.T) {
	e := newAPIEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
}

func TestMeListsMemberships(t *testing.T) {
	e := newAPIEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+e.token)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	var me struct {
		Sub         string `json:"sub"`
		Memberships []struct {
			OrgID   string `json:"org_id"`
			OrgName string `json:"org_name"`
			Role    string `json:"role"`
		} `json:"memberships"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if me.Sub != "sub-teacher" || len(me.Memberships) != 1 || me.Memberships[0].OrgID != e.orgID {
		t.Fatalf("me = %+v", me)
	}
}

func (e *apiEnv) createLesson(t *testing.T, projectID, title string) string {
	t.Helper()
	rec := e.do(t, http.MethodPost, "/v1/projects/"+projectID+"/lessons", map[string]string{"title": title})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create lesson code = %d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" {
		t.Fatal("lesson id empty")
	}
	return created.ID
}

func (e *apiEnv) uploadMaterial(t *testing.T, projectID, lessonID, filename, content, kind string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if kind != "" {
		_ = w.WriteField("kind", kind)
	}
	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(fw, content)
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+projectID+"/lessons/"+lessonID+"/materials", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+e.token)
	req.Header.Set("X-Org-Id", e.orgID)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func TestCreateProjectUploadSubmitConfirm(t *testing.T) {
	e := newAPIEnv(t)

	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "高等数学"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create project code = %d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Title != "高等数学" || created.ID == "" {
		t.Fatalf("created = %+v", created)
	}

	lessonID := e.createLesson(t, created.ID, "第 3 章 导数")
	up := e.uploadMaterial(t, created.ID, lessonID, "note.txt", "导数的定义：差商的极限", "text")
	if up.Code != http.StatusCreated {
		t.Fatalf("upload code = %d body=%s", up.Code, up.Body.String())
	}

	rec = e.do(t, http.MethodPost, "/v1/projects/"+created.ID+"/lessons/"+lessonID+"/submit", map[string]string{"note": "2 学时"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("submit code = %d body=%s", rec.Code, rec.Body.String())
	}
	var lesson struct {
		LessonJobID string `json:"lesson_job_id"`
		PackageID   string `json:"package_id"`
		Status      string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &lesson); err != nil {
		t.Fatal(err)
	}

	pkg := waitPackage(t, e, lesson.PackageID, "awaiting_confirm")
	if pkg["lesson_status"] != "awaiting_confirm" {
		t.Fatalf("package = %v", pkg)
	}

	rec = e.do(t, http.MethodPost, "/v1/lessons/"+lesson.LessonJobID+"/confirm", nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("confirm code = %d body=%s", rec.Code, rec.Body.String())
	}
	pkg = waitPackage(t, e, lesson.PackageID, "succeeded")
	arts, _ := pkg["artifacts"].([]any)
	if len(arts) < 4 {
		t.Fatalf("artifacts = %v", pkg["artifacts"])
	}

	got := e.do(t, http.MethodGet, "/v1/projects/"+created.ID, nil)
	if got.Code != http.StatusOK {
		t.Fatalf("get project code = %d body=%s", got.Code, got.Body.String())
	}
	var detail struct {
		Lessons []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"lessons"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Lessons) != 1 || detail.Lessons[0].ID != lessonID || detail.Lessons[0].Title != "第 3 章 导数" {
		t.Fatalf("lessons = %+v", detail.Lessons)
	}

	list := e.do(t, http.MethodGet, "/v1/projects", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list code = %d", list.Code)
	}
}

func TestQuotaExhaustedHasAdminHint(t *testing.T) {
	e := newAPIEnv(t)
	execSQL(t, "UPDATE quota_pools SET total = 0, used = 0 WHERE capability = 'design'")

	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "帽到了"})
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	lessonID := e.createLesson(t, created.ID, "第 1 课")
	up := e.uploadMaterial(t, created.ID, lessonID, "a.txt", "材料", "text")
	if up.Code != http.StatusCreated {
		t.Fatalf("upload code = %d body=%s", up.Code, up.Body.String())
	}

	rec = e.do(t, http.MethodPost, "/v1/projects/"+created.ID+"/lessons/"+lessonID+"/submit", map[string]string{})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("submit code = %d body=%s", rec.Code, rec.Body.String())
	}
	var lesson struct {
		PackageID string `json:"package_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &lesson)
	pkg := waitPackageLessonFailed(t, e, lesson.PackageID)
	errObj, _ := pkg["error"].(map[string]any)
	if errObj == nil || errObj["code"] != "quota_exhausted" {
		t.Fatalf("want quota_exhausted on package, got %v", pkg["error"])
	}
}

func TestMCPGetPackageAndSubmitRequiresProject(t *testing.T) {
	e := newAPIEnv(t)

	rec := e.do(t, http.MethodPost, "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": "submit_lesson", "arguments": map[string]any{}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("mcp code = %d body=%s", rec.Code, rec.Body.String())
	}
	var rpc struct {
		Error *struct {
			Message string `json:"message"`
			Data    struct {
				Code string `json:"code"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rpc); err != nil {
		t.Fatal(err)
	}
	if rpc.Error == nil || rpc.Error.Data.Code != "project_unspecified" {
		t.Fatalf("want project_unspecified, got %+v body=%s", rpc.Error, rec.Body.String())
	}

	rec = e.do(t, http.MethodPost, "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("tools/list code = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "get_package") || !strings.Contains(rec.Body.String(), "submit_lesson") {
		t.Fatalf("tools/list = %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "submit_ppt") || strings.Contains(rec.Body.String(), "create_project") {
		t.Fatalf("P0 MCP 不得暴露 submit_ppt/create_project: %s", rec.Body.String())
	}
}

func TestViewerCannotSubmit(t *testing.T) {
	e := newAPIEnv(t)
	execSQL(t, "UPDATE members SET role = 'viewer' WHERE id = ?", e.memberID)
	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "x"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403 body=%s", rec.Code, rec.Body.String())
	}
	if decodeErr(t, rec) != "forbidden" {
		t.Fatalf("code = %s", decodeErr(t, rec))
	}
}

func TestCreateProjectOmitsPreset(t *testing.T) {
	e := newAPIEnv(t)
	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "高等数学 · 第 3 章"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID       string `json:"id"`
		PresetID string `json:"preset_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.PresetID != "digital_lesson" {
		t.Fatalf("preset_id = %q", created.PresetID)
	}
}

func TestCreateProjectUnknownPresetForbidden(t *testing.T) {
	e := newAPIEnv(t)
	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{
		"title": "x", "preset_id": "pr_campaign",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	if decodeErr(t, rec) != "preset_forbidden" {
		t.Fatalf("err = %s body=%s", decodeErr(t, rec), rec.Body.String())
	}
}

func TestCreateProjectMultiUnspecified(t *testing.T) {
	e := newAPIEnv(t)
	execSQL(t, `UPDATE licenses SET presets = '["digital_lesson","pr_campaign"]'`)
	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "x"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	if decodeErr(t, rec) != "preset_unspecified" {
		t.Fatalf("err = %s body=%s", decodeErr(t, rec), rec.Body.String())
	}
	rec = e.do(t, http.MethodPost, "/v1/projects", map[string]string{
		"title": "选了数字课", "preset_id": "digital_lesson",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("explicit create code = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestListPresets(t *testing.T) {
	e := newAPIEnv(t)
	rec := e.do(t, http.MethodGet, "/v1/presets", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Entitled []string `json:"entitled"`
		Presets  []struct {
			ID   string `json:"id"`
			Copy struct {
				SubmitCTA string `json:"submit_cta"`
			} `json:"copy"`
		} `json:"presets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entitled) != 1 || body.Entitled[0] != "digital_lesson" {
		t.Fatalf("entitled = %v", body.Entitled)
	}
	if len(body.Presets) != 1 || body.Presets[0].Copy.SubmitCTA == "" {
		t.Fatalf("presets = %+v", body.Presets)
	}
}

func TestSubmitRevokedPresetForbidden(t *testing.T) {
	e := newAPIEnv(t)
	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "x"})
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	lessonID := e.createLesson(t, created.ID, "第 1 课")
	execSQL(t, `UPDATE licenses SET presets = '["other_pack"]'`)

	up := e.uploadMaterial(t, created.ID, lessonID, "a.txt", "材料", "text")
	if up.Code != http.StatusCreated {
		t.Fatalf("upload code = %d body=%s", up.Code, up.Body.String())
	}

	rec = e.do(t, http.MethodPost, "/v1/projects/"+created.ID+"/lessons/"+lessonID+"/submit", map[string]string{})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	if decodeErr(t, rec) != "preset_forbidden" {
		t.Fatalf("err = %s", decodeErr(t, rec))
	}
}

func TestMCPSubmitRevokedPresetForbidden(t *testing.T) {
	e := newAPIEnv(t)
	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "x"})
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	lessonID := e.createLesson(t, created.ID, "第 1 课")
	up := e.uploadMaterial(t, created.ID, lessonID, "a.txt", "材料内容足够长", "text")
	if up.Code != http.StatusCreated {
		t.Fatalf("upload code = %d body=%s", up.Code, up.Body.String())
	}
	execSQL(t, `UPDATE licenses SET presets = '["other_pack"]'`)

	rec = e.do(t, http.MethodPost, "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 3, "method": "tools/call",
		"params": map[string]any{"name": "submit_lesson", "arguments": map[string]any{"lesson_id": lessonID}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("mcp code = %d body=%s", rec.Code, rec.Body.String())
	}
	var rpc struct {
		Error *struct {
			Data struct {
				Code string `json:"code"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rpc); err != nil {
		t.Fatal(err)
	}
	if rpc.Error == nil || rpc.Error.Data.Code != "preset_forbidden" {
		t.Fatalf("want preset_forbidden, got %+v body=%s", rpc.Error, rec.Body.String())
	}
}

func TestUploadInfersKindAndCapsAtFive(t *testing.T) {
	e := newAPIEnv(t)
	rec := e.do(t, http.MethodPost, "/v1/projects", map[string]string{"title": "高等数学"})
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	lessonID := e.createLesson(t, created.ID, "第 3 章 导数")

	up := e.uploadMaterial(t, created.ID, lessonID, "课文.md", "# 导数", "")
	if up.Code != http.StatusCreated {
		t.Fatalf("md upload code = %d body=%s", up.Code, up.Body.String())
	}
	var mat struct {
		Kind     string `json:"kind"`
		Filename string `json:"filename"`
	}
	if err := json.Unmarshal(up.Body.Bytes(), &mat); err != nil {
		t.Fatal(err)
	}
	if mat.Kind != "text" || mat.Filename != "课文.md" {
		t.Fatalf("inferred material = %+v", mat)
	}

	for i := 0; i < 4; i++ {
		up = e.uploadMaterial(t, created.ID, lessonID, fmt.Sprintf("n%d.txt", i), "材料内容足够长", "text")
		if up.Code != http.StatusCreated {
			t.Fatalf("upload %d code = %d body=%s", i, up.Code, up.Body.String())
		}
	}
	sixth := e.uploadMaterial(t, created.ID, lessonID, "extra.txt", "第六份", "text")
	if sixth.Code != http.StatusBadRequest {
		t.Fatalf("sixth upload code = %d body=%s", sixth.Code, sixth.Body.String())
	}
	if decodeErr(t, sixth) != "too_many_materials" {
		t.Fatalf("err = %s body=%s", decodeErr(t, sixth), sixth.Body.String())
	}
}

func waitPackage(t *testing.T, e *apiEnv, packageID, wantLessonStatus string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	var last map[string]any
	for time.Now().Before(deadline) {
		rec := e.do(t, http.MethodGet, "/v1/packages/"+packageID, nil)
		if rec.Code != http.StatusOK {
			time.Sleep(30 * time.Millisecond)
			continue
		}
		last = map[string]any{}
		if err := json.Unmarshal(rec.Body.Bytes(), &last); err != nil {
			t.Fatal(err)
		}
		if last["lesson_status"] == wantLessonStatus {
			return last
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("package %s lesson_status never became %s, last=%v", packageID, wantLessonStatus, last)
	return last
}

func waitPackageLessonFailed(t *testing.T, e *apiEnv, packageID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	var last map[string]any
	for time.Now().Before(deadline) {
		rec := e.do(t, http.MethodGet, "/v1/packages/"+packageID, nil)
		if rec.Code != http.StatusOK {
			time.Sleep(30 * time.Millisecond)
			continue
		}
		last = map[string]any{}
		_ = json.Unmarshal(rec.Body.Bytes(), &last)
		if last["lesson_status"] == "failed" {
			return last
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("package never failed, last=%v", last)
	return last
}
