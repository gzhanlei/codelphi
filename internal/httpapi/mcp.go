package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"codelphi/internal/dbgen"
	"codelphi/internal/execution"
	"codelphi/internal/identity"
	"codelphi/internal/preset"
)

// handleMCP 是 JSON-RPC 2.0 入口。P0 挂 get_package / submit_lesson / reshape_lesson_plan。
func (s *server) handleMCP(w http.ResponseWriter, r *http.Request) {
	var req rpcRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeRPC(w, nil, rpcErr(-32700, "parse error", "", err.Error()))
		return
	}
	c := s.ictx(r)
	switch req.Method {
	case "initialize":
		writeRPC(w, req.ID, rpcResult(map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]string{"name": "codelphi-gateway", "version": "p0"},
		}))
	case "tools/list":
		writeRPC(w, req.ID, rpcResult(map[string]any{"tools": mcpTools()}))
	case "tools/call":
		s.mcpCall(w, r, c, req)
	default:
		writeRPC(w, req.ID, rpcErr(-32601, "method not found", "", req.Method))
	}
}

func (s *server) mcpCall(w http.ResponseWriter, r *http.Request, c *identity.Context, req rpcRequest) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
		writeRPC(w, req.ID, rpcErr(-32602, "invalid params", "", "name required"))
		return
	}
	args := map[string]any{}
	if len(params.Arguments) > 0 {
		_ = json.Unmarshal(params.Arguments, &args)
	}
	switch params.Name {
	case "get_package":
		packageID, _ := args["package_id"].(string)
		if packageID == "" {
			writeRPC(w, req.ID, rpcErr(-32000, "invalid_request", "invalid_request", "package_id required"))
			return
		}
		if _, err := orgPackage(s, r.Context(), packageID, c.OrgID); err != nil {
			writeRPC(w, req.ID, rpcErr(-32000, "not_found", "not_found", "package not found"))
			return
		}
		pkg, err := s.exec.GetPackage(r.Context(), packageID, s.mediaTTL)
		if err != nil {
			writeRPC(w, req.ID, rpcErr(-32000, "not_found", "not_found", err.Error()))
			return
		}
		s.absolutize(pkg)
		writeRPC(w, req.ID, rpcResult(pkg))
	case "reshape_lesson_plan":
		if c.Role == string(dbgen.MembersRoleViewer) {
			writeRPC(w, req.ID, rpcErr(-32000, "forbidden", "forbidden", "viewer 只能查看"))
			return
		}
		packageID, _ := args["package_id"].(string)
		if packageID == "" {
			writeRPC(w, req.ID, rpcErr(-32000, "invalid_request", "invalid_request", "package_id required"))
			return
		}
		if _, err := orgPackage(s, r.Context(), packageID, c.OrgID); err != nil {
			writeRPC(w, req.ID, rpcErr(-32000, "not_found", "not_found", "package not found"))
			return
		}
		got, err := s.exec.ReshapeLessonPlan(r.Context(), c.OrgID, packageID)
		if err != nil {
			code, msg := mcpExecCode(err)
			writeRPC(w, req.ID, rpcErr(-32000, msg, code, err.Error()))
			return
		}
		writeRPC(w, req.ID, rpcResult(got))
	case "submit_lesson":
		if c.Role == string(dbgen.MembersRoleViewer) {
			writeRPC(w, req.ID, rpcErr(-32000, "forbidden", "forbidden", "viewer 只能查看"))
			return
		}
		rebuild, _ := args["rebuild"].(string)
		critique, _ := args["critique"].(string)
		packageID, _ := args["package_id"].(string)
		if rebuild != "" {
			if packageID == "" {
				writeRPC(w, req.ID, rpcErr(-32000, "invalid_request", "invalid_request", "rebuild requires package_id"))
				return
			}
			if _, err := orgPackage(s, r.Context(), packageID, c.OrgID); err != nil {
				writeRPC(w, req.ID, rpcErr(-32000, "not_found", "not_found", "package not found"))
				return
			}
			bg := context.WithoutCancel(r.Context())
			go func() { _ = s.exec.Rebuild(bg, packageID, rebuild, critique) }()
			writeRPC(w, req.ID, rpcResult(map[string]string{"package_id": packageID, "status": "building"}))
			return
		}
		lessonID, _ := args["lesson_id"].(string)
		if lessonID == "" {
			writeRPC(w, req.ID, rpcErr(-32000, "project_unspecified", "project_unspecified", "工作台先建课；agent 返工时必须绑定一课"))
			return
		}
		cl, err := dbgen.New(s.db).GetCourseLesson(r.Context(), lessonID)
		if err != nil {
			writeRPC(w, req.ID, rpcErr(-32000, "not_found", "not_found", "lesson not found"))
			return
		}
		p, err := orgProject(s, r.Context(), cl.ProjectID, c.OrgID)
		if err != nil {
			writeRPC(w, req.ID, rpcErr(-32000, "not_found", "not_found", "project not found"))
			return
		}
		entitled, err := s.entitledPresetIDs(r.Context(), c.OrgID)
		if err != nil {
			writeRPC(w, req.ID, rpcErr(-32000, err.Error(), "internal", err.Error()))
			return
		}
		pid := p.PresetID
		if pid == "" {
			pid = preset.DigitalLesson
		}
		if !preset.Contains(entitled, pid) {
			writeRPC(w, req.ID, rpcErr(-32000, "preset_forbidden", "preset_forbidden", "本授权不含此套件"))
			return
		}
		note, _ := args["note"].(string)
		lesson, err := s.exec.StartLesson(r.Context(), execution.SubmitInput{
			OrgID: c.OrgID, MemberID: c.MemberID, UnitID: c.UnitID,
			ProjectID: p.ID, CourseLessonID: cl.ID, Title: cl.Title, Note: note,
		})
		var inflight *execution.InFlightError
		if errors.As(err, &inflight) {
			writeRPC(w, req.ID, rpcResult(map[string]string{
				"lesson_job_id": inflight.JobID, "package_id": inflight.PackageID, "status": inflight.Status,
			}))
			return
		}
		if err != nil {
			code, msg := mcpExecCode(err)
			writeRPC(w, req.ID, rpcErr(-32000, msg, code, err.Error()))
			return
		}
		writeRPC(w, req.ID, rpcResult(map[string]string{
			"lesson_job_id": lesson.LessonJobID, "package_id": lesson.PackageID, "status": lesson.Status,
		}))
	default:
		writeRPC(w, req.ID, rpcErr(-32601, "unknown tool", "", params.Name))
	}
}

func mcpExecCode(err error) (code, msg string) {
	switch {
	case errors.Is(err, execution.ErrNoMaterials):
		return "invalid_request", "请先上传本课材料"
	case errors.Is(err, execution.ErrNoLessonText):
		return "invalid_request", "课文抽不出文本，无法写教案"
	case errors.Is(err, execution.ErrMaterialKindUnsupported):
		return "material_kind_unsupported", "不支持该文件类型"
	case errors.Is(err, execution.ErrTooManyMaterials):
		return "too_many_materials", "每课最多 5 份材料"
	default:
		return "internal", err.Error()
	}
}

func orgProject(s *server, ctx context.Context, id, orgID string) (dbgen.Project, error) {
	p, err := dbgen.New(s.db).GetProject(ctx, id)
	if err != nil {
		return dbgen.Project{}, err
	}
	if p.OrgID != orgID {
		return dbgen.Project{}, errors.New("not found")
	}
	return p, nil
}

func orgPackage(s *server, ctx context.Context, id, orgID string) (dbgen.CoursePackage, error) {
	pkg, err := dbgen.New(s.db).GetCoursePackage(ctx, id)
	if err != nil {
		return dbgen.CoursePackage{}, err
	}
	if _, err := orgProject(s, ctx, pkg.ProjectID, orgID); err != nil {
		return dbgen.CoursePackage{}, err
	}
	return pkg, nil
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func mcpTools() []map[string]any {
	return []map[string]any{
		{
			"name":        "get_package",
			"description": "构件列表 + 当前指针 + 最近版本 + 签名 URL。文件永不进返回值。",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"package_id": map[string]string{"type": "string"}},
				"required":   []string{"package_id"},
			},
		},
		{
			"name":        "reshape_lesson_plan",
			"description": "依据课文重写教案（不是从 PPT 讲稿倒推）。课件大纲只用来对照是否跑偏。",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"package_id": map[string]string{"type": "string"}},
				"required":   []string{"package_id"},
			},
		},
		{
			"name":        "submit_lesson",
			"description": "提交做课或 rebuild。必须绑定 lesson_id（课程内的一课）；rebuild 时带 package_id + rebuild + critique。不建课、不建课程。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"lesson_id":  map[string]string{"type": "string"},
					"note":       map[string]string{"type": "string"},
					"package_id": map[string]string{"type": "string"},
					"rebuild":    map[string]string{"type": "string", "description": "ppt"},
					"critique":   map[string]string{"type": "string"},
				},
			},
		},
	}
}

type rpcError struct {
	Code    int            `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

func rpcErr(code int, message, reason, detail string) map[string]any {
	data := map[string]any{"message": detail}
	if reason != "" {
		data["code"] = reason
		data["admin_hint"] = adminHint(reason)
	}
	return map[string]any{"error": rpcError{Code: code, Message: message, Data: data}}
}

func rpcResult(v any) map[string]any { return map[string]any{"result": v} }

func writeRPC(w http.ResponseWriter, id any, payload map[string]any) {
	out := map[string]any{"jsonrpc": "2.0", "id": id}
	for k, v := range payload {
		out[k] = v
	}
	writeJSON(w, http.StatusOK, out)
}
