// Package httpapi 是套件工作台 / MCP 的 HTTP 面（设计 §2、§5、§7）。
// 只走 identity 中间件解析出的 org/member，绝不接受模型填写租户头。
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"codelphi/internal/dbgen"
	"codelphi/internal/execution"
	"codelphi/internal/identity"
	"codelphi/internal/preset"
	"codelphi/internal/storage"
)

// Deps 是网关装配 httpapi 时注入的依赖。
type Deps struct {
	DB          *sql.DB
	Exec        *execution.Service
	Store       storage.Store
	Verifier    *identity.Verifier
	Resolver    *identity.Resolver
	MediaTTL    time.Duration
	PublicBase  string
	CORSOrigins []string
}

type server struct {
	db          *sql.DB
	exec        *execution.Service
	store       storage.Store
	verifier    *identity.Verifier
	resolver    *identity.Resolver
	mediaTTL    time.Duration
	publicBase  string
	corsOrigins []string
}

// New 返回已挂 identity 中间件的工作台 REST + MCP。
func New(d Deps) http.Handler {
	if d.MediaTTL == 0 {
		d.MediaTTL = 15 * time.Minute
	}
	s := &server{
		db: d.DB, exec: d.Exec, store: d.Store,
		verifier: d.Verifier, resolver: d.Resolver,
		mediaTTL: d.MediaTTL, publicBase: d.PublicBase,
		corsOrigins: d.CORSOrigins,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/me", s.handleMe)

	auth := identity.Middleware(d.Verifier, d.Resolver)
	mux.Handle("GET /v1/presets", auth(http.HandlerFunc(s.listPresets)))
	mux.Handle("GET /v1/projects", auth(http.HandlerFunc(s.listProjects)))
	mux.Handle("POST /v1/projects", auth(http.HandlerFunc(s.createProject)))
	mux.Handle("GET /v1/projects/{id}", auth(http.HandlerFunc(s.getProject)))
	mux.Handle("POST /v1/projects/{id}/materials", auth(http.HandlerFunc(s.uploadMaterial)))
	mux.Handle("POST /v1/projects/{id}/submit", auth(http.HandlerFunc(s.submit)))
	mux.Handle("GET /v1/lessons/{id}", auth(http.HandlerFunc(s.getLesson)))
	mux.Handle("POST /v1/lessons/{id}/confirm", auth(http.HandlerFunc(s.confirm)))
	mux.Handle("GET /v1/packages/{id}", auth(http.HandlerFunc(s.getPackage)))
	mux.Handle("POST /v1/packages/{id}/rebuild", auth(http.HandlerFunc(s.rebuild)))
	mux.Handle("POST /mcp", auth(http.HandlerFunc(s.handleMCP)))
	return s.withCORS(mux)
}

func (s *server) ictx(r *http.Request) *identity.Context {
	c, _ := identity.ContextFrom(r.Context())
	return c
}

func (s *server) requireWriter(w http.ResponseWriter, c *identity.Context) bool {
	if c.Role == string(dbgen.MembersRoleViewer) {
		writeErr(w, http.StatusForbidden, "forbidden", "viewer 只能查看，不能做课")
		return false
	}
	return true
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		writeErr(w, http.StatusUnauthorized, "missing_token", "missing or malformed Authorization header")
		return
	}
	claims, err := s.verifier.Parse(token)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid_token", "token verification failed")
		return
	}
	rows, err := dbgen.New(s.db).ListMembershipsWithOrgBySub(r.Context(), claims.Sub)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "identity_unavailable", "list memberships failed")
		return
	}
	type unit struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	type membership struct {
		MemberID string   `json:"member_id"`
		OrgID    string   `json:"org_id"`
		OrgName  string   `json:"org_name"`
		Role     string   `json:"role"`
		Status   string   `json:"status"`
		Units    []unit   `json:"units"`
		Presets  []string `json:"presets"`
	}
	out := struct {
		Sub         string       `json:"sub"`
		Memberships []membership `json:"memberships"`
	}{Sub: claims.Sub}
	q := dbgen.New(s.db)
	for _, row := range rows {
		if row.Status != dbgen.MembersStatusActive {
			continue
		}
		m := membership{
			MemberID: row.ID, OrgID: row.OrgID, OrgName: row.OrgName,
			Role: string(row.Role), Status: string(row.Status),
		}
		units, err := q.ListMemberUnits(r.Context(), row.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "identity_unavailable", "list units failed")
			return
		}
		for _, u := range units {
			m.Units = append(m.Units, unit{ID: u.ID, Name: u.Name})
		}
		if m.Units == nil {
			m.Units = []unit{}
		}
		ids, err := s.entitledPresetIDs(r.Context(), row.OrgID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "identity_unavailable", "list presets failed")
			return
		}
		m.Presets = ids
		out.Memberships = append(out.Memberships, m)
	}
	if out.Memberships == nil {
		out.Memberships = []membership{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) listPresets(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	ids, err := s.entitledPresetIDs(r.Context(), c.OrgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entitled": ids,
		"presets":  preset.List(ids),
	})
}

func (s *server) entitledPresetIDs(ctx context.Context, orgID string) ([]string, error) {
	now := time.Now()
	licenses, err := dbgen.New(s.db).ListUsableLicenses(ctx, dbgen.ListUsableLicensesParams{
		OrgID: orgID, ValidFrom: now, ValidTo: now,
	})
	if err != nil {
		return nil, err
	}
	var raws []json.RawMessage
	for _, lic := range licenses {
		if lic.Presets == nil {
			raws = append(raws, nil)
			continue
		}
		raws = append(raws, *lic.Presets)
	}
	return preset.UnionEntitled(raws), nil
}

func (s *server) listProjects(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	q := dbgen.New(s.db)
	var (
		rows []dbgen.Project
		err  error
	)
	if c.Role == string(dbgen.MembersRoleOwner) || c.Role == string(dbgen.MembersRoleAdmin) {
		rows, err = q.ListProjectsByOrg(r.Context(), c.OrgID)
	} else {
		rows, err = q.ListProjectsByOwner(r.Context(), dbgen.ListProjectsByOwnerParams{OrgID: c.OrgID, OwnerMemberID: c.MemberID})
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	list := make([]projectJSON, 0, len(rows))
	for _, p := range rows {
		list = append(list, projectToJSON(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": list})
}

func (s *server) createProject(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	if !s.requireWriter(w, c) {
		return
	}
	var in struct {
		Title    string `json:"title"`
		PresetID string `json:"preset_id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil || strings.TrimSpace(in.Title) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "title required")
		return
	}
	entitled, err := s.entitledPresetIDs(r.Context(), c.OrgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	pid, err := preset.ResolveCreate(strings.TrimSpace(in.PresetID), entitled)
	if err != nil {
		s.writePresetErr(w, err)
		return
	}
	id := ulid.Make().String()
	unit := sql.NullString{String: c.UnitID, Valid: c.UnitID != ""}
	if err := dbgen.New(s.db).InsertProject(r.Context(), dbgen.InsertProjectParams{
		ID: id, OrgID: c.OrgID, UnitID: unit, OwnerMemberID: c.MemberID,
		Title: strings.TrimSpace(in.Title), PresetID: pid,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, projectJSON{
		ID: id, OrgID: c.OrgID, OwnerMemberID: c.MemberID,
		Title: strings.TrimSpace(in.Title), UnitID: c.UnitID, PresetID: pid,
	})
}

func (s *server) getProject(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	p, ok := s.loadProject(w, r, r.PathValue("id"), c)
	if !ok {
		return
	}
	out := map[string]any{"project": projectToJSON(p)}
	pid := p.PresetID
	if pid == "" {
		pid = preset.DigitalLesson
	}
	if spec, err := preset.Lookup(pid); err == nil {
		out["preset"] = spec
	}
	pkg, err := dbgen.New(s.db).GetLatestPackageByProject(r.Context(), p.ID)
	if err == nil {
		out["package_id"] = pkg.ID
		out["package_status"] = string(pkg.Status)
		if pkg.LessonJobID.Valid {
			out["lesson_job_id"] = pkg.LessonJobID.String
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) uploadMaterial(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	if !s.requireWriter(w, c) {
		return
	}
	p, ok := s.loadProject(w, r, r.PathValue("id"), c)
	if !ok {
		return
	}
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "multipart form required")
		return
	}
	kind := r.FormValue("kind")
	if kind == "" {
		kind = "text"
	}
	if kind != "text" && kind != "pdf" && kind != "docx" && kind != "image" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "kind must be text/pdf/docx/image")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "file required")
		return
	}
	defer file.Close()
	matID := ulid.Make().String()
	key := "org/" + c.OrgID + "/material/" + matID
	if header.Filename != "" {
		key += "-" + sanitizeName(header.Filename)
	}
	ct := header.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	if err := s.store.Put(r.Context(), key, file, ct); err != nil {
		writeErr(w, http.StatusInternalServerError, "storage_error", err.Error())
		return
	}
	if err := dbgen.New(s.db).InsertMaterial(r.Context(), dbgen.InsertMaterialParams{
		ID: matID, ProjectID: p.ID, Kind: dbgen.MaterialsKind(kind), StorageRef: key, UploadedBy: c.MemberID,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": matID, "kind": kind, "storage_ref": key})
}

func (s *server) submit(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	if !s.requireWriter(w, c) {
		return
	}
	p, ok := s.loadProject(w, r, r.PathValue("id"), c)
	if !ok {
		return
	}
	entitled, err := s.entitledPresetIDs(r.Context(), c.OrgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	pid := p.PresetID
	if pid == "" {
		pid = preset.DigitalLesson
	}
	if !preset.Contains(entitled, pid) {
		writeErr(w, http.StatusForbidden, "preset_forbidden", "本授权不含此套件")
		return
	}
	var in struct {
		Note string `json:"note"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in)
	}
	if existing, err := dbgen.New(s.db).GetInFlightLessonByProject(r.Context(), p.ID); err == nil {
		writeJSON(w, http.StatusOK, lessonJSON(existing.ID, existing.PackageID.String, string(existing.Status)))
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	lesson, err := s.exec.StartLesson(r.Context(), execution.SubmitInput{
		OrgID: c.OrgID, MemberID: c.MemberID, UnitID: c.UnitID,
		ProjectID: p.ID, Title: p.Title, Note: in.Note,
	})
	if err != nil {
		s.writeExecErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, lessonJSON(lesson.LessonJobID, lesson.PackageID, lesson.Status))
}

func (s *server) confirm(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	if !s.requireWriter(w, c) {
		return
	}
	job, ok := s.loadLesson(w, r, r.PathValue("id"), c)
	if !ok {
		return
	}
	lesson, err := s.exec.StartConfirm(r.Context(), job.ID)
	if err != nil {
		s.writeExecErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, lessonJSON(lesson.LessonJobID, lesson.PackageID, lesson.Status))
}

func (s *server) getLesson(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	job, ok := s.loadLesson(w, r, r.PathValue("id"), c)
	if !ok {
		return
	}
	if !job.PackageID.Valid {
		writeJSON(w, http.StatusOK, lessonJSON(job.ID, "", string(job.Status)))
		return
	}
	s.writePackage(w, r, job.PackageID.String, c)
}

func (s *server) getPackage(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	s.writePackage(w, r, r.PathValue("id"), c)
}

func (s *server) rebuild(w http.ResponseWriter, r *http.Request) {
	c := s.ictx(r)
	if !s.requireWriter(w, c) {
		return
	}
	pkg, ok := s.loadPackage(w, r, r.PathValue("id"), c)
	if !ok {
		return
	}
	var in struct {
		Kind     string `json:"kind"`
		Critique string `json:"critique"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil || in.Kind == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "kind required")
		return
	}
	bg := context.WithoutCancel(r.Context())
	go func() {
		_ = s.exec.Rebuild(bg, pkg.ID, in.Kind, in.Critique)
	}()
	writeJSON(w, http.StatusAccepted, map[string]string{"package_id": pkg.ID, "status": "building"})
}

func (s *server) writePackage(w http.ResponseWriter, r *http.Request, packageID string, c *identity.Context) {
	pkg, ok := s.loadPackage(w, r, packageID, c)
	if !ok {
		return
	}
	snap, err := s.exec.GetPackage(r.Context(), pkg.ID, s.mediaTTL)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.absolutize(snap)
	if snap.Error != nil {
		writeJSON(w, http.StatusOK, packageWithHint(snap))
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *server) loadProject(w http.ResponseWriter, r *http.Request, id string, c *identity.Context) (dbgen.Project, bool) {
	p, err := dbgen.New(s.db).GetProject(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && p.OrgID != c.OrgID) {
		writeErr(w, http.StatusNotFound, "not_found", "project not found")
		return dbgen.Project{}, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return dbgen.Project{}, false
	}
	return p, true
}

func (s *server) loadLesson(w http.ResponseWriter, r *http.Request, id string, c *identity.Context) (dbgen.Job, bool) {
	job, err := dbgen.New(s.db).GetJob(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && job.OrgID != c.OrgID) {
		writeErr(w, http.StatusNotFound, "not_found", "lesson not found")
		return dbgen.Job{}, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return dbgen.Job{}, false
	}
	if job.Kind != dbgen.JobsKindLesson {
		writeErr(w, http.StatusBadRequest, "invalid_request", "not a lesson job")
		return dbgen.Job{}, false
	}
	return job, true
}

func (s *server) loadPackage(w http.ResponseWriter, r *http.Request, id string, c *identity.Context) (dbgen.CoursePackage, bool) {
	pkg, err := dbgen.New(s.db).GetCoursePackage(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "package not found")
		return dbgen.CoursePackage{}, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return dbgen.CoursePackage{}, false
	}
	p, err := dbgen.New(s.db).GetProject(r.Context(), pkg.ProjectID)
	if err != nil || p.OrgID != c.OrgID {
		writeErr(w, http.StatusNotFound, "not_found", "package not found")
		return dbgen.CoursePackage{}, false
	}
	return pkg, true
}

func (s *server) writeExecErr(w http.ResponseWriter, err error) {
	msg := err.Error()
	switch {
	case errors.Is(err, execution.ErrMaterialKindUnsupported):
		writeErr(w, http.StatusBadRequest, "material_kind_unsupported", "P0 仅支持文本材料")
	case errors.Is(err, execution.ErrRebuildKind):
		writeErr(w, http.StatusBadRequest, "invalid_request", msg)
	case errors.Is(err, execution.ErrUnknownPreset):
		writeErr(w, http.StatusBadRequest, "invalid_request", "未知的预设包")
	case strings.Contains(msg, "project has no materials"):
		writeErr(w, http.StatusBadRequest, "invalid_request", "请先上传章材料")
	case strings.Contains(msg, "project not in org"):
		writeErr(w, http.StatusNotFound, "not_found", "project not found")
	default:
		writeErr(w, http.StatusInternalServerError, "internal", msg)
	}
}

func (s *server) absolutize(snap *execution.PackageSnapshot) {
	for i := range snap.Artifacts {
		if snap.Artifacts[i].Current != nil {
			snap.Artifacts[i].Current.URL = s.absURL(snap.Artifacts[i].Current.URL)
		}
		for j := range snap.Artifacts[i].Versions {
			snap.Artifacts[i].Versions[j].URL = s.absURL(snap.Artifacts[i].Versions[j].URL)
		}
	}
}

func (s *server) absURL(u string) string {
	if u == "" || s.publicBase == "" {
		return u
	}
	if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	return strings.TrimRight(s.publicBase, "/") + u
}

type projectJSON struct {
	ID            string `json:"id"`
	OrgID         string `json:"org_id"`
	UnitID        string `json:"unit_id,omitempty"`
	OwnerMemberID string `json:"owner_member_id"`
	Title         string `json:"title"`
	PresetID      string `json:"preset_id"`
}

func projectToJSON(p dbgen.Project) projectJSON {
	return projectJSON{ID: p.ID, OrgID: p.OrgID, UnitID: p.UnitID.String, OwnerMemberID: p.OwnerMemberID, Title: p.Title, PresetID: p.PresetID}
}

func (s *server) writePresetErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, preset.ErrUnspecified):
		writeErr(w, http.StatusBadRequest, "preset_unspecified", "请选择要新建的套件")
	case errors.Is(err, preset.ErrForbidden):
		writeErr(w, http.StatusForbidden, "preset_forbidden", "本授权不含此套件")
	case errors.Is(err, preset.ErrUnknown):
		writeErr(w, http.StatusBadRequest, "invalid_request", "未知的预设包")
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func lessonJSON(id, packageID, status string) map[string]string {
	return map[string]string{"lesson_job_id": id, "package_id": packageID, "status": status}
}

func sanitizeName(name string) string {
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	if len(name) > 80 {
		name = name[len(name)-80:]
	}
	return name
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message, "admin_hint": adminHint(code)},
	})
}

func packageWithHint(snap *execution.PackageSnapshot) map[string]any {
	return map[string]any{
		"id":            snap.ID,
		"project_id":    snap.ProjectID,
		"status":        snap.Status,
		"lesson_job_id": snap.LessonJobID,
		"lesson_status": snap.LessonStatus,
		"steps":         snap.Steps,
		"artifacts":     snap.Artifacts,
		"error": map[string]string{
			"code":       snap.Error.Code,
			"message":    snap.Error.Message,
			"admin_hint": adminHint(snap.Error.Code),
		},
	}
}

func adminHint(code string) string {
	switch code {
	case "quota_exhausted", "license_expired", "org_suspended", "identity_unbound", "member_disabled":
		return "联系本机构管理员"
	case "member_cap_exhausted":
		return "找本机构管理员调个人帽"
	case "capability_not_entitled":
		return "本套餐不含此能力，联系销售"
	case "preset_forbidden":
		return "本套餐不含此套件，联系销售"
	default:
		return "联系本机构管理员"
	}
}

func (s *server) withCORS(next http.Handler) http.Handler {
	allow := map[string]bool{}
	for _, o := range s.corsOrigins {
		allow[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (len(allow) == 0 || allow[origin]) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Org-Id, X-Unit-Id")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
