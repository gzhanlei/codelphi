package execution

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"

	"codelphi/internal/billing"
	"codelphi/internal/dbgen"
	"codelphi/internal/execution/adapters/llm"
	"codelphi/internal/execution/adapters/pptcreator"
	"codelphi/internal/extract"
	"codelphi/internal/lessonplan"
	"codelphi/internal/preset"
	"codelphi/internal/storage"
)

// lesson 权威状态机（P0'：课文 → 教案 → 做片交出课件大纲+ppt+讲稿，无确认门）。每个 step 独立 authorize/settle；教案插件内 LLM 不预扣。
var (
	// ErrIllegalTransition：状态机非法迁移（条件 UPDATE rows=0）。
	ErrIllegalTransition = errors.New("execution: illegal job status transition")
	// ErrMaterialKindUnsupported：image 等无法抽文本的种类。
	ErrMaterialKindUnsupported = errors.New("execution: material kind not supported")
	// ErrCourseLessonRequired：做课必须绑到一课，不能绑在课程项目上。
	ErrCourseLessonRequired = errors.New("execution: course lesson required")
	// ErrRebuildKind：script / outline 只能随 ppt 整份重出（§8 第 9 条 / C8）。
	ErrRebuildKind = errors.New("execution: script rebuilds with ppt, not alone")
	// ErrUnknownPreset：Project.preset_id 不在目录里，submit 失败。
	ErrUnknownPreset = errors.New("execution: unknown preset")
	// ErrNoMaterials：这一课还没有材料。
	ErrNoMaterials = errors.New("execution: lesson has no materials")
	// ErrMaterialTooLarge：单份材料超过 extract.MaxBytes。
	ErrMaterialTooLarge = errors.New("execution: material too large")
	// ErrTooManyMaterials：超过每课上限。
	ErrTooManyMaterials = errors.New("execution: too many materials")
	// ErrLessonInFlight：该课已有 queued/running/awaiting_confirm 的 lesson job。
	ErrLessonInFlight = errors.New("execution: lesson already in flight")
	// ErrNoCurrentPPT：导回要求套件里已有当前 ppt（不是第一次当材料上传）。
	ErrNoCurrentPPT = errors.New("execution: no current ppt to import over")
	// ErrNoLessonText：材料抽不出课文，无法写教案。
	ErrNoLessonText = errors.New("execution: lesson materials have no extractable text")
	// ErrNotPPTX：导回只收 .pptx。
	ErrNotPPTX = errors.New("execution: import requires a .pptx file")
	// ErrPPTBusy：套件正在做片/重建，不能同时导回。
	ErrPPTBusy = errors.New("execution: ppt generate already in flight")
	// ErrOrgSuspended：机构已停用，导回等无 vendor 写入也要拦（与 Authorize 同闸，但不预扣）。
	ErrOrgSuspended = errors.New("execution: org_suspended")
)

// InFlightError 带上已有 job，供 HTTP/MCP 幂等返回 200。
type InFlightError struct {
	JobID     string
	PackageID string
	Status    string
}

func (e *InFlightError) Error() string { return ErrLessonInFlight.Error() }
func (e *InFlightError) Unwrap() error { return ErrLessonInFlight }

// MaxMaterialsPerLesson 是教师上传上限。PPT 材料包另有 5 槽（课文优先，其余 reference）。
const MaxMaterialsPerLesson = 5

// Config 可调项；默认值即可用于生产。
type Config struct {
	LLMMaxTokens float64 // design/outline 的估计值（token 上限），默认 8000
	// DeepSeek 公开价（deepseek-chat，CNY/百万 token），env 可覆盖；vendor 可换是设计要求。
	LLMPriceIn  float64
	LLMPriceOut float64
	// InFlightPerKey：并发公平按 (org, platform) 的信号量容量，默认 2。
	InFlightPerKey int
}

func defaultConfig() Config {
	return Config{LLMMaxTokens: 8000, LLMPriceIn: 2, LLMPriceOut: 8, InFlightPerKey: 2}
}

// Service 是 lesson 权威状态机。对 billing 只走 Authorize/Settle，不直接碰配额表（设计 §2 边界）。
type Service struct {
	db      *sql.DB
	billing *billing.Service
	store   storage.Store
	llm     *llm.Client
	ppt     *pptcreator.Client
	cfg     Config

	publicBase string
	mediaTTL   time.Duration

	mu   sync.Mutex
	sems map[string]chan struct{}
	wg   sync.WaitGroup
}

type Option func(*Service)

func WithConfig(cfg Config) Option { return func(s *Service) { s.cfg = cfg } }

func WithMedia(publicBase string, ttl time.Duration) Option {
	return func(s *Service) {
		s.publicBase = publicBase
		s.mediaTTL = ttl
	}
}

func New(db *sql.DB, billingSvc *billing.Service, store storage.Store, llmClient *llm.Client, pptClient *pptcreator.Client, opts ...Option) *Service {
	s := &Service{db: db, billing: billingSvc, store: store, llm: llmClient, ppt: pptClient, cfg: defaultConfig(), sems: make(map[string]chan struct{})}
	for _, o := range opts {
		o(s)
	}
	return s
}

// SubmitInput 的 org/member/unit 由调用方从 identity.Context 来，绝不由模型填写（设计 §5）。
type SubmitInput struct {
	OrgID          string
	MemberID       string
	UnitID         string // 可空
	ProjectID      string
	CourseLessonID string // 课（course_lessons），材料与套件都挂在这上面
	Title          string // 课名
	Note           string // 教师补充说明（表单字段）
}

// Lesson 是 SubmitLesson/ConfirmLesson 的返回快照。
type Lesson struct {
	LessonJobID string
	PackageID   string
	Status      string // jobs.status
}

// SubmitLesson 建 lesson job + CoursePackage，按预设跑全部 step（P0' 无确认门，直接做片）。
//
// 返回的 error 只在系统性失败（DB / billing 不可用，fail-closed）时非 nil；
// 业务性 step 失败（deny、adapter 故障）体现在 Lesson.Status = failed。
func (s *Service) SubmitLesson(ctx context.Context, in SubmitInput) (*Lesson, error) {
	prepared, err := s.prepareLesson(ctx, in)
	if err != nil {
		return nil, err
	}
	return s.runDesignOutline(ctx, prepared)
}

// StartLesson 是 HTTP 用的非阻塞入口：建 job 后立即返回 running，step 在后台跑。
// 进程退出时残留 running 由 RecoverInFlight 收敛；预扣由 billing TTL 扫尾兜底。
func (s *Service) StartLesson(ctx context.Context, in SubmitInput) (*Lesson, error) {
	prepared, err := s.prepareLesson(ctx, in)
	if err != nil {
		return nil, err
	}
	lesson := &Lesson{LessonJobID: prepared.lessonID, PackageID: prepared.packageID, Status: string(dbgen.JobsStatusRunning)}
	bg := context.WithoutCancel(ctx)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if _, err := s.runDesignOutline(bg, prepared); err != nil {
			log.Printf("execution: lesson %s background: %v", prepared.lessonID, err)
		}
	}()
	return lesson, nil
}

// ConfirmLesson 是教师点「通过，继续」后的状态迁移：awaiting_confirm → 提交 ppt step。
// 幂等安全：重复调用（条件 UPDATE 抢不到行）直接返回当前状态，不产生第二个 ppt step。
func (s *Service) ConfirmLesson(ctx context.Context, lessonID string) (*Lesson, error) {
	prepared, skip, err := s.prepareConfirm(ctx, lessonID)
	if err != nil {
		return nil, err
	}
	if skip != nil {
		return skip, nil
	}
	return s.runPPTAndFinish(ctx, prepared)
}

// StartConfirm 是 HTTP 用的非阻塞确认门。
func (s *Service) StartConfirm(ctx context.Context, lessonID string) (*Lesson, error) {
	prepared, skip, err := s.prepareConfirm(ctx, lessonID)
	if err != nil {
		return nil, err
	}
	if skip != nil {
		return skip, nil
	}
	lesson := &Lesson{LessonJobID: prepared.lessonID, PackageID: prepared.packageID, Status: string(dbgen.JobsStatusRunning)}
	bg := context.WithoutCancel(ctx)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if _, err := s.runPPTAndFinish(bg, prepared); err != nil {
			log.Printf("execution: confirm %s background: %v", prepared.lessonID, err)
		}
	}()
	return lesson, nil
}

// ImportResult 是教师导回 pptx 后的新版本快照。
type ImportResult struct {
	Kind    string `json:"kind"`
	Version int32  `json:"version"`
}

// ImportPPT 把本地改过的 pptx 收成新的 ppt artifact 版本。当前指针前移，历史保留。
// 不写 Material、不调 PPTCreator、不产生 UsageRecord。
// 对象键用 ULID，避免与并发导回/重建抢同一 ppt-vN 路径；版本号在锁住套件行后分配。
func (s *Service) ImportPPT(ctx context.Context, orgID, packageID, filename string, data []byte) (*ImportResult, error) {
	if !strings.HasSuffix(strings.ToLower(filename), ".pptx") {
		return nil, ErrNotPPTX
	}
	if int64(len(data)) > extract.MaxBytes {
		return nil, ErrMaterialTooLarge
	}
	if err := s.billing.AssertOrgActive(ctx, orgID); err != nil {
		if errors.Is(err, billing.ErrOrgSuspended) {
			return nil, ErrOrgSuspended
		}
		return nil, err
	}
	key := fmt.Sprintf("org/%s/package/%s/ppt-%s.pptx", orgID, packageID, ulid.Make().String())
	if err := s.store.Put(ctx, key, bytes.NewReader(data), "application/vnd.openxmlformats-officedocument.presentationml.presentation"); err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	qt := dbgen.New(s.db).WithTx(tx)

	pkg, err := qt.LockCoursePackage(ctx, packageID)
	if err != nil {
		return nil, fmt.Errorf("execution: package: %w", err)
	}
	project, err := qt.GetProject(ctx, pkg.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("execution: project: %w", err)
	}
	if project.OrgID != orgID {
		return nil, errors.New("execution: project not in org")
	}
	arts, err := qt.ListCurrentArtifacts(ctx, packageID)
	if err != nil {
		return nil, err
	}
	hasPPT := false
	for _, a := range arts {
		if a.Kind == "ppt" && a.Status == dbgen.ArtifactsStatusReady {
			hasPPT = true
			break
		}
	}
	if !hasPPT {
		return nil, ErrNoCurrentPPT
	}
	if pkg.Status == dbgen.CoursePackagesStatusBuilding {
		return nil, ErrPPTBusy
	}
	if pkg.LessonJobID.Valid {
		steps, err := qt.ListStepJobs(ctx, sql.NullString{String: pkg.LessonJobID.String, Valid: true})
		if err != nil {
			return nil, err
		}
		for _, st := range steps {
			if st.Capability.String != "ppt" {
				continue
			}
			if st.Status == dbgen.JobsStatusQueued || st.Status == dbgen.JobsStatusRunning {
				return nil, ErrPPTBusy
			}
		}
	}
	version, err := qt.NextArtifactVersion(ctx, dbgen.NextArtifactVersionParams{PackageID: packageID, Kind: "ppt"})
	if err != nil {
		return nil, err
	}
	if err := qt.ClearCurrentArtifact(ctx, dbgen.ClearCurrentArtifactParams{PackageID: packageID, Kind: "ppt"}); err != nil {
		return nil, err
	}
	if err := qt.InsertArtifact(ctx, dbgen.InsertArtifactParams{
		ID: ulid.Make().String(), PackageID: packageID, Kind: "ppt", Version: version,
		Status:     dbgen.ArtifactsStatusReady,
		StorageRef: sql.NullString{String: key, Valid: true},
		IsCurrent:  true,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if err := s.refreshPackageStatus(ctx, packageID); err != nil {
		return nil, err
	}
	return &ImportResult{Kind: "ppt", Version: version}, nil
}

// ReshapeLessonPlan 依据课文重写教案。课件大纲只用来对照，不是内容来源。
// 不调 PPTCreator、不产生 UsageRecord；plan 若已在目录里则进 ready 门禁。
func (s *Service) ReshapeLessonPlan(ctx context.Context, orgID, packageID string) (*ImportResult, error) {
	if err := s.billing.AssertOrgActive(ctx, orgID); err != nil {
		if errors.Is(err, billing.ErrOrgSuspended) {
			return nil, ErrOrgSuspended
		}
		return nil, err
	}
	q := dbgen.New(s.db)
	pkg, err := q.GetCoursePackage(ctx, packageID)
	if err != nil {
		return nil, fmt.Errorf("execution: package: %w", err)
	}
	project, err := q.GetProject(ctx, pkg.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("execution: project: %w", err)
	}
	if project.OrgID != orgID {
		return nil, errors.New("execution: project not in org")
	}
	_, texts, err := s.loadLessonMaterials(ctx, pkg.LessonID)
	if err != nil {
		return nil, err
	}
	if len(texts) == 0 {
		return nil, ErrNoLessonText
	}
	title := project.Title
	if cl, err := q.GetCourseLesson(ctx, pkg.LessonID); err == nil && cl.Title != "" {
		title = cl.Title
	}
	outline, err := s.loadCurrentOutline(ctx, packageID)
	if err != nil {
		return nil, err
	}
	plan, err := s.generatePlan(ctx, title, texts, outline, "", "")
	if err != nil {
		return nil, err
	}
	s.annotatePlanDrift(plan, outline, nil)
	version, err := s.storePlan(ctx, orgID, packageID, "", plan)
	if err != nil {
		return nil, err
	}
	if err := s.refreshPackageStatus(ctx, packageID); err != nil {
		return nil, err
	}
	return &ImportResult{Kind: "plan", Version: version}, nil
}

func (s *Service) generatePlan(ctx context.Context, title string, texts []string, outline json.RawMessage, note, critique string) (*lessonplan.Plan, error) {
	got, err := s.llm.Generate(ctx, llm.GenerateRequest{
		Kind:      llm.KindPlan,
		Title:     title,
		Materials: texts,
		Outline:   string(outline),
		Note:      note,
		Critique:  critique,
	})
	if err != nil {
		return nil, fmt.Errorf("execution: lesson plan llm: %w", err)
	}
	plan, err := lessonplan.FromTeaching(title, got.JSON)
	if err != nil {
		return nil, err
	}
	return plan, nil
}

func (s *Service) storePlan(ctx context.Context, orgID, packageID, stepID string, plan *lessonplan.Plan) (int32, error) {
	md := lessonplan.Markdown(plan)
	raw, err := json.Marshal(plan)
	if err != nil {
		return 0, err
	}
	docx, err := lessonplan.WriteDocx(plan)
	if err != nil {
		return 0, err
	}
	version, err := s.nextVersion(ctx, packageID, "plan")
	if err != nil {
		return 0, err
	}
	base := fmt.Sprintf("org/%s/package/%s/plan-v%d", orgID, packageID, version)
	if err := s.store.Put(ctx, base+".json", strings.NewReader(string(raw)), "application/json"); err != nil {
		return 0, err
	}
	if err := s.store.Put(ctx, base+".md", strings.NewReader(md), "text/markdown"); err != nil {
		return 0, err
	}
	docxKey := base + ".docx"
	if err := s.store.Put(ctx, docxKey, bytes.NewReader(docx), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"); err != nil {
		return 0, err
	}
	if err := s.insertArtifact(ctx, packageID, "plan", version, stepID, docxKey); err != nil {
		return 0, err
	}
	return version, nil
}

func (s *Service) annotatePlanDrift(plan *lessonplan.Plan, outline, notes json.RawMessage) {
	if plan == nil {
		return
	}
	issues := lessonplan.CheckDeck(plan, outline, notes)
	plan.Drift = nil
	for _, it := range issues {
		plan.Drift = append(plan.Drift, it.String())
	}
}

func (s *Service) loadCurrentPlan(ctx context.Context, packageID string) (*lessonplan.Plan, error) {
	data, err := s.readCurrentKind(ctx, packageID, "plan")
	if err != nil || len(data) == 0 {
		return nil, err
	}
	var p lessonplan.Plan
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("execution: plan json: %w", err)
	}
	return &p, nil
}

func (s *Service) loadPlanMarkdown(ctx context.Context, packageID string) (string, error) {
	p, err := s.loadCurrentPlan(ctx, packageID)
	if err != nil || p == nil {
		return "", err
	}
	return lessonplan.Markdown(p), nil
}

func (s *Service) rewriteCurrentPlan(ctx context.Context, orgID, packageID string, plan *lessonplan.Plan) error {
	arts, err := dbgen.New(s.db).ListCurrentArtifacts(ctx, packageID)
	if err != nil {
		return err
	}
	var ref string
	for _, a := range arts {
		if a.Kind == "plan" && a.StorageRef.Valid {
			ref = a.StorageRef.String
			break
		}
	}
	if ref == "" {
		_, err := s.storePlan(ctx, orgID, packageID, "", plan)
		return err
	}
	base := strings.TrimSuffix(ref, ".docx")
	base = strings.TrimSuffix(base, ".json")
	base = strings.TrimSuffix(base, ".md")
	raw, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	md := lessonplan.Markdown(plan)
	docx, err := lessonplan.WriteDocx(plan)
	if err != nil {
		return err
	}
	if err := s.store.Put(ctx, base+".json", strings.NewReader(string(raw)), "application/json"); err != nil {
		return err
	}
	if err := s.store.Put(ctx, base+".md", strings.NewReader(md), "text/markdown"); err != nil {
		return err
	}
	return s.store.Put(ctx, base+".docx", bytes.NewReader(docx), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
}

func (s *Service) readCurrentKind(ctx context.Context, packageID, kind string) ([]byte, error) {
	arts, err := dbgen.New(s.db).ListCurrentArtifacts(ctx, packageID)
	if err != nil {
		return nil, err
	}
	var ref string
	for _, a := range arts {
		if a.Kind == kind && a.StorageRef.Valid && a.StorageRef.String != "" {
			ref = a.StorageRef.String
			break
		}
	}
	if ref == "" {
		return nil, nil
	}
	key := ref
	if strings.HasSuffix(strings.ToLower(key), ".docx") {
		key = key[:len(key)-5] + ".json"
	}
	rc, err := s.store.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, extract.MaxBytes+1))
}

// Wait 等后台 StartLesson/StartConfirm 结束（进程退出前由 gateway 调用）。
func (s *Service) Wait() { s.wg.Wait() }

type storedMaterial struct {
	Name string
	Key  string
}

type pptFile struct {
	Name string
	URL  string
}

type preparedLesson struct {
	in        SubmitInput
	project   dbgen.Project
	spec      preset.Preset
	texts     []string
	files     []storedMaterial
	lessonID  string
	packageID string
}

func (s *Service) prepareLesson(ctx context.Context, in SubmitInput) (*preparedLesson, error) {
	if in.CourseLessonID == "" {
		return nil, ErrCourseLessonRequired
	}
	q := dbgen.New(s.db)
	project, err := q.GetProject(ctx, in.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("execution: project: %w", err)
	}
	if project.OrgID != in.OrgID {
		return nil, errors.New("execution: project not in org")
	}
	cl, err := q.GetCourseLesson(ctx, in.CourseLessonID)
	if err != nil {
		return nil, fmt.Errorf("execution: course lesson: %w", err)
	}
	if cl.ProjectID != in.ProjectID {
		return nil, errors.New("execution: course lesson not in project")
	}
	if in.Title == "" {
		in.Title = cl.Title
	}
	spec, err := lookupProjectPreset(project)
	if err != nil {
		return nil, err
	}
	files, texts, err := s.loadLessonMaterials(ctx, in.CourseLessonID)
	if err != nil {
		return nil, err
	}
	if len(texts) == 0 {
		return nil, ErrNoLessonText
	}

	lessonID, packageID := ulid.Make().String(), ulid.Make().String()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	qt := q.WithTx(tx)
	if _, err := qt.LockCourseLesson(ctx, in.CourseLessonID); err != nil {
		tx.Rollback()
		return nil, fmt.Errorf("execution: lock course lesson: %w", err)
	}
	if existing, err := qt.GetInFlightLessonByCourseLesson(ctx, in.CourseLessonID); err == nil {
		tx.Rollback()
		return nil, &InFlightError{
			JobID: existing.ID, PackageID: existing.PackageID.String, Status: string(existing.Status),
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		tx.Rollback()
		return nil, err
	}
	if err := qt.InsertJob(ctx, dbgen.InsertJobParams{
		ID: lessonID, OrgID: in.OrgID, ProjectID: in.ProjectID,
		PackageID: sql.NullString{String: packageID, Valid: true},
		Kind:      dbgen.JobsKindLesson, Status: dbgen.JobsStatusQueued,
	}); err != nil {
		tx.Rollback()
		return nil, err
	}
	if err := qt.InsertCoursePackage(ctx, dbgen.InsertCoursePackageParams{
		ID: packageID, ProjectID: in.ProjectID, LessonID: in.CourseLessonID, PresetID: spec.ID,
		Status:      dbgen.CoursePackagesStatusBuilding,
		LessonJobID: sql.NullString{String: lessonID, Valid: true},
	}); err != nil {
		tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if err := s.transition(ctx, lessonID, dbgen.JobsStatusQueued, dbgen.JobsStatusRunning); err != nil {
		return nil, err
	}
	return &preparedLesson{in: in, project: project, spec: spec, texts: texts, files: files, lessonID: lessonID, packageID: packageID}, nil
}

func (s *Service) runDesignOutline(ctx context.Context, p *preparedLesson) (*Lesson, error) {
	lesson := &Lesson{LessonJobID: p.lessonID, PackageID: p.packageID}
	pre, post := splitGate(p.spec.Steps)
	for _, step := range pre {
		if err := s.runCatalogStep(ctx, p, step, p.in.Note, ""); err != nil {
			return s.failLesson(ctx, lesson, err)
		}
	}
	if len(post) == 0 {
		return s.finishLesson(ctx, p, lesson)
	}
	if err := s.transition(ctx, p.lessonID, dbgen.JobsStatusRunning, dbgen.JobsStatusAwaitingConfirm); err != nil {
		return lesson, err
	}
	lesson.Status = string(dbgen.JobsStatusAwaitingConfirm)
	return lesson, nil
}

func (s *Service) prepareConfirm(ctx context.Context, lessonID string) (p *preparedLesson, skip *Lesson, err error) {
	q := dbgen.New(s.db)
	job, err := q.GetJob(ctx, lessonID)
	if err != nil {
		return nil, nil, fmt.Errorf("execution: lesson: %w", err)
	}
	if job.Kind != dbgen.JobsKindLesson {
		return nil, nil, errors.New("execution: not a lesson job")
	}
	lesson := &Lesson{LessonJobID: lessonID, PackageID: job.PackageID.String, Status: string(job.Status)}
	if job.Status != dbgen.JobsStatusAwaitingConfirm {
		return nil, lesson, nil // 幂等：已确认/已终态，不再动作
	}
	if err := s.transition(ctx, lessonID, dbgen.JobsStatusAwaitingConfirm, dbgen.JobsStatusRunning); err != nil {
		if errors.Is(err, ErrIllegalTransition) {
			return nil, lesson, nil // 并发重复确认：对方已迁移
		}
		return nil, lesson, err
	}
	project, err := q.GetProject(ctx, job.ProjectID)
	if err != nil {
		return nil, lesson, err
	}
	pkg, err := q.GetCoursePackage(ctx, job.PackageID.String)
	if err != nil {
		return nil, lesson, err
	}
	cl, err := q.GetCourseLesson(ctx, pkg.LessonID)
	if err != nil {
		return nil, lesson, err
	}
	files, texts, err := s.loadLessonMaterials(ctx, pkg.LessonID)
	if err != nil {
		return nil, lesson, err
	}
	spec, err := lookupProjectPreset(project)
	if err != nil {
		return nil, lesson, err
	}
	in := SubmitInput{
		OrgID: job.OrgID, MemberID: project.OwnerMemberID,
		UnitID: project.UnitID.String, ProjectID: project.ID,
		CourseLessonID: pkg.LessonID, Title: cl.Title,
	}
	return &preparedLesson{in: in, project: project, spec: spec, texts: texts, files: files, lessonID: lessonID, packageID: job.PackageID.String}, nil, nil
}

func (s *Service) runPPTAndFinish(ctx context.Context, p *preparedLesson) (*Lesson, error) {
	lesson := &Lesson{LessonJobID: p.lessonID, PackageID: p.packageID}
	_, post := splitGate(p.spec.Steps)
	for _, step := range post {
		if err := s.runCatalogStep(ctx, p, step, "", ""); err != nil {
			return s.failLesson(ctx, lesson, err)
		}
	}
	return s.finishLesson(ctx, p, lesson)
}

func (s *Service) finishLesson(ctx context.Context, p *preparedLesson, lesson *Lesson) (*Lesson, error) {
	if err := s.transition(ctx, p.lessonID, dbgen.JobsStatusRunning, dbgen.JobsStatusSucceeded); err != nil {
		return lesson, err
	}
	if err := s.refreshPackageStatus(ctx, p.packageID); err != nil {
		return lesson, err
	}
	lesson.Status = string(dbgen.JobsStatusSucceeded)
	return lesson, nil
}

// Rebuild 单件重试/缺件后补（设计 §2.2：P0 整份重出，无单页重生）。
// 新 step job、新预扣；成功后产生新版本 artifact，is_current 迁移，旧版本保留。
// kind 只接受目录里能独立重出的构件（P0' 为 ppt）；script / outline 随 ppt 整份重出。
func (s *Service) Rebuild(ctx context.Context, packageID, kind, critique string) error {
	q := dbgen.New(s.db)
	pkg, err := q.GetCoursePackage(ctx, packageID)
	if err != nil {
		return fmt.Errorf("execution: package: %w", err)
	}
	if !pkg.LessonJobID.Valid {
		return errors.New("execution: package has no lesson")
	}
	lesson, err := q.GetJob(ctx, pkg.LessonJobID.String)
	if err != nil {
		return err
	}
	project, err := q.GetProject(ctx, pkg.ProjectID)
	if err != nil {
		return err
	}
	files, texts, err := s.loadLessonMaterials(ctx, pkg.LessonID)
	if err != nil {
		return err
	}
	var title string
	if cl, err := q.GetCourseLesson(ctx, pkg.LessonID); err == nil {
		title = cl.Title
	} else {
		title = project.Title
	}
	in := SubmitInput{
		OrgID: lesson.OrgID, MemberID: project.OwnerMemberID,
		UnitID: project.UnitID.String, ProjectID: project.ID,
		CourseLessonID: pkg.LessonID, Title: title,
	}
	spec, err := lookupProjectPreset(project)
	if err != nil {
		return err
	}
	step, err := stepEmitting(spec, kind)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	qt := q.WithTx(tx)
	if _, err := qt.LockCoursePackage(ctx, packageID); err != nil {
		tx.Rollback()
		return err
	}
	if err := qt.UpdatePackageStatus(ctx, dbgen.UpdatePackageStatusParams{
		Status: dbgen.CoursePackagesStatusBuilding, ID: packageID,
	}); err != nil {
		tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	p := &preparedLesson{in: in, project: project, spec: spec, texts: texts, files: files, lessonID: lesson.ID, packageID: packageID}
	err = s.runCatalogStep(ctx, p, step, "", critique)
	if err != nil {
		// 业务性失败：package 停在 partial，错误已落 step job cost_report。
		_ = q.UpdatePackageStatus(ctx, dbgen.UpdatePackageStatusParams{
			Status: dbgen.CoursePackagesStatusPartial, ID: packageID,
		})
		return err
	}
	return s.refreshPackageStatus(ctx, packageID)
}

// --- step 执行 ---

// runLLMStep 跑 design/outline step：authorize（estimated = token 上限）→ LLM →
// 落 storage + artifact 版本 → settle（actual = 实际 token 数，vendor_cost 按可配单价）。
func (s *Service) runLLMStep(ctx context.Context, in SubmitInput, project dbgen.Project, lessonID, packageID string, kind llm.Kind, texts []string, note, critique string) error {
	stepID := ulid.Make().String()
	if err := s.insertStep(ctx, stepID, in, lessonID, packageID, string(kind), "llm"); err != nil {
		return err
	}
	release := s.acquire(ctx, in.OrgID, "llm")
	defer release()
	if err := s.transition(ctx, stepID, dbgen.JobsStatusQueued, dbgen.JobsStatusRunning); err != nil {
		return err
	}

	d, err := s.billing.Authorize(ctx, billing.AuthorizeInput{
		OrgID: in.OrgID, UnitID: in.UnitID, MemberID: in.MemberID, ProjectID: in.ProjectID,
		Capability: string(kind), EstimatedAmount: s.cfg.LLMMaxTokens,
		JobID: stepID, Unit: billing.UnitCount,
	})
	if err != nil {
		// billing 自身故障：fail-closed，不提交平台调用（设计 §4：billing_unavailable 才整体 fail-closed）。
		s.failStep(ctx, stepID, "billing_unavailable", err.Error())
		return err
	}
	if !d.Allowed {
		s.failStep(ctx, stepID, string(d.Reason), "authorize deny")
		return fmt.Errorf("execution: authorize deny: %s", d.Reason)
	}

	res, err := s.llm.Generate(ctx, llm.GenerateRequest{
		Kind: kind, Title: in.Title, Materials: texts, Note: note, Critique: critique,
	})
	if err != nil {
		// adapter 故障只 fail 该 step，预扣退回。
		s.settleFailure(ctx, d.ReservationID, stepID)
		s.failStep(ctx, stepID, "llm_error", err.Error())
		return err
	}

	if err := s.storeLLMArtifacts(ctx, in.OrgID, packageID, stepID, kind, res); err != nil {
		s.settleFailure(ctx, d.ReservationID, stepID)
		s.failStep(ctx, stepID, "storage_error", err.Error())
		return err
	}
	tokens := float64(res.PromptTokens + res.CompletionTokens)
	cost := float64(res.PromptTokens)/1e6*s.cfg.LLMPriceIn + float64(res.CompletionTokens)/1e6*s.cfg.LLMPriceOut
	if err := s.billing.Settle(ctx, billing.SettleInput{
		ReservationID: d.ReservationID, JobID: stepID,
		ActualAmount: tokens, VendorCost: &cost, Outcome: billing.OutcomeSuccess,
	}); err != nil {
		return err
	}
	return s.transition(ctx, stepID, dbgen.JobsStatusRunning, dbgen.JobsStatusSucceeded)
}

// runPPTStep 跑 ppt step（estimated = actual = 1 份）。成功 = 同时产出 outline、ppt、script；
// notes 为空/页数不齐由 adapter 按 C4 报 notes_missing，大纲缺失按 C8 报 outline_missing。
func (s *Service) runPPTStep(ctx context.Context, in SubmitInput, lessonID, packageID string, docs []pptcreator.Doc, note, critique string) error {
	stepID := ulid.Make().String()
	if err := s.insertStep(ctx, stepID, in, lessonID, packageID, "ppt", "pptcreator"); err != nil {
		return err
	}
	release := s.acquire(ctx, in.OrgID, "pptcreator")
	defer release()
	if err := s.transition(ctx, stepID, dbgen.JobsStatusQueued, dbgen.JobsStatusRunning); err != nil {
		return err
	}

	d, err := s.billing.Authorize(ctx, billing.AuthorizeInput{
		OrgID: in.OrgID, UnitID: in.UnitID, MemberID: in.MemberID, ProjectID: in.ProjectID,
		Capability: "ppt", EstimatedAmount: 1, JobID: stepID, Unit: billing.UnitCount,
	})
	if err != nil {
		s.failStep(ctx, stepID, "billing_unavailable", err.Error())
		return err
	}
	if !d.Allowed {
		s.failStep(ctx, stepID, string(d.Reason), "authorize deny")
		return fmt.Errorf("execution: authorize deny: %s", d.Reason)
	}

	confirmed, err := s.loadCurrentOutline(ctx, packageID)
	if err != nil {
		s.settleFailure(ctx, d.ReservationID, stepID)
		s.failStep(ctx, stepID, "storage_error", err.Error())
		return err
	}
	res, aligned, err := s.produceDeck(ctx, in, packageID, stepID, docs, note, critique, confirmed)
	if err != nil {
		s.settleFailure(ctx, d.ReservationID, stepID)
		code := "partner_error"
		var pe *pptcreator.Error
		if errors.As(err, &pe) {
			code = pe.Code
		}
		s.failStep(ctx, stepID, code, err.Error())
		return err
	}

	if err := s.storePPTArtifacts(ctx, in.OrgID, packageID, stepID, res); err != nil {
		s.settleFailure(ctx, d.ReservationID, stepID)
		s.failStep(ctx, stepID, "storage_error", err.Error())
		return err
	}
	if !aligned {
		if err := s.alignDeckToPlan(ctx, in, packageID, stepID, docs, note, critique, res); err != nil {
			s.settleFailure(ctx, d.ReservationID, stepID)
			s.failStep(ctx, stepID, "storage_error", err.Error())
			return err
		}
	}
	if err := s.billing.Settle(ctx, billing.SettleInput{
		ReservationID: d.ReservationID, JobID: stepID,
		ActualAmount: 1, VendorCost: &res.VendorCost, Outcome: billing.OutcomeSuccess,
	}); err != nil {
		return err
	}
	return s.transition(ctx, stepID, dbgen.JobsStatusRunning, dbgen.JobsStatusSucceeded)
}

// produceDeck 走契约 C8.3：先 stage=outline 对照教案，通过后再 stage=pptx。
// 对方仍一次出齐 COMPLETED（未落地 #127）时 aligned=false，由 alignDeckToPlan 兜底。
// 已有 confirmed_outline（Rebuild）则直接烧片，不再重排页。
func (s *Service) produceDeck(ctx context.Context, in SubmitInput, packageID, stepID string, docs []pptcreator.Doc, note, critique string, confirmed json.RawMessage) (*pptcreator.Result, bool, error) {
	if len(bytes.TrimSpace(confirmed)) > 0 {
		res, err := s.ppt.Generate(ctx, pptcreator.GenerateRequest{
			JobID: stepID, OrgID: in.OrgID, MemberID: in.MemberID,
			Title: in.Title, Documents: docs, Note: note, Critique: critique,
			Stage: pptcreator.StagePPTX, ConfirmedOutline: confirmed,
		})
		return res, true, err
	}

	outlineJob := ulid.Make().String()
	first, err := s.ppt.Generate(ctx, pptcreator.GenerateRequest{
		JobID: outlineJob, OrgID: in.OrgID, MemberID: in.MemberID,
		Title: in.Title, Documents: docs, Note: note, Critique: critique,
		Stage: pptcreator.StageOutline,
	})
	if err != nil {
		return nil, false, err
	}
	if strings.TrimSpace(first.PptxURL) != "" {
		return first, false, nil
	}

	outline, notes := first.Outline, first.Notes
	projectID := first.ProjectID
	plan, err := s.loadCurrentPlan(ctx, packageID)
	if err != nil {
		return nil, false, err
	}
	issues := lessonplan.CheckDeck(plan, outline, notes)
	if focusUncovered(issues) && strings.TrimSpace(critique) == "" {
		retry, rerr := s.ppt.Generate(ctx, pptcreator.GenerateRequest{
			JobID: ulid.Make().String(), OrgID: in.OrgID, MemberID: in.MemberID,
			Title: in.Title, Documents: docs, Note: note,
			Critique:  lessonplan.Critique(issues),
			Stage:     pptcreator.StageOutline,
			ProjectID: projectID,
		})
		if rerr != nil {
			return nil, false, rerr
		}
		if strings.TrimSpace(retry.PptxURL) != "" {
			return retry, false, nil
		}
		outline, notes = retry.Outline, retry.Notes
		if retry.ProjectID != "" {
			projectID = retry.ProjectID
		}
	}
	if plan != nil {
		s.annotatePlanDrift(plan, outline, notes)
		if len(plan.Drift) > 0 {
			if err := s.rewriteCurrentPlan(ctx, in.OrgID, packageID, plan); err != nil {
				return nil, false, err
			}
		}
	}

	res, err := s.ppt.Generate(ctx, pptcreator.GenerateRequest{
		JobID: stepID, OrgID: in.OrgID, MemberID: in.MemberID,
		Title: in.Title, Documents: docs, Note: note, Critique: critique,
		Stage: pptcreator.StagePPTX, ProjectID: projectID, ConfirmedOutline: outline,
	})
	return res, true, err
}

func (s *Service) alignDeckToPlan(ctx context.Context, in SubmitInput, packageID, stepID string, docs []pptcreator.Doc, note, critique string, first *pptcreator.Result) error {
	plan, err := s.loadCurrentPlan(ctx, packageID)
	if err != nil || plan == nil {
		return err
	}
	outline, notes := first.Outline, first.Notes
	issues := lessonplan.CheckDeck(plan, outline, notes)
	if focusUncovered(issues) && strings.TrimSpace(critique) == "" {
		res2, err := s.ppt.Generate(ctx, pptcreator.GenerateRequest{
			JobID: ulid.Make().String(), OrgID: in.OrgID, MemberID: in.MemberID,
			Title: in.Title, Documents: docs, Note: note,
			Critique: lessonplan.Critique(issues),
		})
		if err == nil {
			if err := s.storePPTArtifacts(ctx, in.OrgID, packageID, stepID, res2); err != nil {
				return err
			}
			outline, notes = res2.Outline, res2.Notes
		}
	}
	s.annotatePlanDrift(plan, outline, notes)
	if len(plan.Drift) == 0 {
		return nil
	}
	return s.rewriteCurrentPlan(ctx, in.OrgID, packageID, plan)
}

func focusUncovered(issues []lessonplan.Issue) bool {
	for _, it := range issues {
		if it.Code == "uncovered_focus" {
			return true
		}
	}
	return false
}

func (s *Service) runPlanStep(ctx context.Context, p *preparedLesson, note, critique string) error {
	if err := s.billing.AssertOrgActive(ctx, p.in.OrgID); err != nil {
		if errors.Is(err, billing.ErrOrgSuspended) {
			return ErrOrgSuspended
		}
		return err
	}
	if len(p.texts) == 0 {
		return ErrNoLessonText
	}
	stepID := ulid.Make().String()
	if err := s.insertStep(ctx, stepID, p.in, p.lessonID, p.packageID, "plan", "llm"); err != nil {
		return err
	}
	release := s.acquire(ctx, p.in.OrgID, "llm")
	defer release()
	if err := s.transition(ctx, stepID, dbgen.JobsStatusQueued, dbgen.JobsStatusRunning); err != nil {
		return err
	}
	outline, err := s.loadCurrentOutline(ctx, p.packageID)
	if err != nil {
		s.failStep(ctx, stepID, "storage_error", err.Error())
		return err
	}
	plan, err := s.generatePlan(ctx, p.in.Title, p.texts, outline, note, critique)
	if err != nil {
		s.failStep(ctx, stepID, "llm_error", err.Error())
		return err
	}
	s.annotatePlanDrift(plan, outline, nil)
	if _, err := s.storePlan(ctx, p.in.OrgID, p.packageID, stepID, plan); err != nil {
		s.failStep(ctx, stepID, "storage_error", err.Error())
		return err
	}
	return s.transition(ctx, stepID, dbgen.JobsStatusRunning, dbgen.JobsStatusSucceeded)
}

// --- 内部件 ---

func (s *Service) insertStep(ctx context.Context, stepID string, in SubmitInput, lessonID, packageID, capability, platform string) error {
	return dbgen.New(s.db).InsertJob(ctx, dbgen.InsertJobParams{
		ID: stepID, OrgID: in.OrgID, ProjectID: in.ProjectID,
		PackageID:  sql.NullString{String: packageID, Valid: true},
		ParentID:   sql.NullString{String: lessonID, Valid: true},
		Kind:       dbgen.JobsKindStep,
		Capability: sql.NullString{String: capability, Valid: true},
		Platform:   sql.NullString{String: platform, Valid: true},
		Status:     dbgen.JobsStatusQueued,
	})
}

// storeLLMArtifacts 落 JSON + 渲染 Markdown，artifact 版本迁移同事务。
func (s *Service) storeLLMArtifacts(ctx context.Context, orgID, packageID, stepID string, kind llm.Kind, res *llm.GenerateResult) error {
	version, err := s.nextVersion(ctx, packageID, string(kind))
	if err != nil {
		return err
	}
	base := fmt.Sprintf("org/%s/package/%s/%s-v%d", orgID, packageID, kind, version)
	jsonKey := base + ".json"
	if err := s.store.Put(ctx, jsonKey, strings.NewReader(string(res.JSON)), "application/json"); err != nil {
		return err
	}
	if err := s.store.Put(ctx, base+".md", strings.NewReader(res.Markdown), "text/markdown"); err != nil {
		return err
	}
	return s.insertArtifact(ctx, packageID, string(kind), version, stepID, jsonKey)
}

// storePPTArtifacts 回拷 pptx、逐页 notes、C8 课件大纲到本侧 storage（不转手平台临时链，C3），
// outline / ppt / script 三个 artifact 各升一个版本。
func (s *Service) storePPTArtifacts(ctx context.Context, orgID, packageID, stepID string, res *pptcreator.Result) error {
	if len(res.Outline) == 0 {
		return errors.New("execution: missing outline")
	}
	pptx, err := s.ppt.Fetch(ctx, res.PptxURL)
	if err != nil {
		return err
	}
	outlineVersion, err := s.nextVersion(ctx, packageID, "outline")
	if err != nil {
		return err
	}
	pptVersion, err := s.nextVersion(ctx, packageID, "ppt")
	if err != nil {
		return err
	}
	scriptVersion, err := s.nextVersion(ctx, packageID, "script")
	if err != nil {
		return err
	}
	outlineKey := fmt.Sprintf("org/%s/package/%s/outline-v%d.json", orgID, packageID, outlineVersion)
	if err := s.store.Put(ctx, outlineKey, strings.NewReader(string(res.Outline)), "application/json"); err != nil {
		return err
	}
	pptKey := fmt.Sprintf("org/%s/package/%s/ppt-v%d.pptx", orgID, packageID, pptVersion)
	if err := s.store.Put(ctx, pptKey, strings.NewReader(string(pptx)), "application/vnd.openxmlformats-officedocument.presentationml.presentation"); err != nil {
		return err
	}
	scriptJSONKey := fmt.Sprintf("org/%s/package/%s/script-v%d.json", orgID, packageID, scriptVersion)
	if err := s.store.Put(ctx, scriptJSONKey, strings.NewReader(string(res.Notes)), "application/json"); err != nil {
		return err
	}
	scriptKey := scriptJSONKey
	// 契约 C4：notes JSON 是硬产物；docx 是教师看到的讲稿。有 script_url 时当前构件指向 docx。
	if res.ScriptURL != "" {
		docx, err := s.ppt.Fetch(ctx, res.ScriptURL)
		if err != nil {
			return fmt.Errorf("fetch script docx: %w", err)
		}
		docxKey := fmt.Sprintf("org/%s/package/%s/script-v%d.docx", orgID, packageID, scriptVersion)
		if err := s.store.Put(ctx, docxKey, strings.NewReader(string(docx)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"); err != nil {
			return err
		}
		scriptKey = docxKey
	}
	if err := s.insertArtifact(ctx, packageID, "outline", outlineVersion, stepID, outlineKey); err != nil {
		return err
	}
	if err := s.insertArtifact(ctx, packageID, "ppt", pptVersion, stepID, pptKey); err != nil {
		return err
	}
	return s.insertArtifact(ctx, packageID, "script", scriptVersion, stepID, scriptKey)
}

func (s *Service) loadCurrentOutline(ctx context.Context, packageID string) (json.RawMessage, error) {
	arts, err := dbgen.New(s.db).ListCurrentArtifacts(ctx, packageID)
	if err != nil {
		return nil, err
	}
	for _, a := range arts {
		if a.Kind != "outline" || !a.StorageRef.Valid || a.StorageRef.String == "" {
			continue
		}
		rc, err := s.store.Open(ctx, a.StorageRef.String)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, extract.MaxBytes+1))
		rc.Close()
		if err != nil {
			return nil, err
		}
		return json.RawMessage(data), nil
	}
	return nil, nil
}

func (s *Service) nextVersion(ctx context.Context, packageID string, kind string) (int32, error) {
	return dbgen.New(s.db).NextArtifactVersion(ctx, dbgen.NextArtifactVersionParams{PackageID: packageID, Kind: kind})
}

// insertArtifact 同事务清旧 is_current + 插新版本行（旧版本保留可下载，设计 §3）。
func (s *Service) insertArtifact(ctx context.Context, packageID string, kind string, version int32, stepID, storageKey string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	qt := dbgen.New(s.db).WithTx(tx)
	if err := qt.ClearCurrentArtifact(ctx, dbgen.ClearCurrentArtifactParams{PackageID: packageID, Kind: kind}); err != nil {
		return err
	}
	if err := qt.InsertArtifact(ctx, dbgen.InsertArtifactParams{
		ID: ulid.Make().String(), PackageID: packageID, Kind: kind, Version: version,
		Status:     dbgen.ArtifactsStatusReady,
		StepJobID:  sql.NullString{String: stepID, Valid: stepID != ""},
		StorageRef: sql.NullString{String: storageKey, Valid: true},
		IsCurrent:  true,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

// loadLessonMaterials 列出该课原文件（转交 PPTCreator 用），并尽量抽文本给教案 LLM。
// 抽不出字则无法写教案，由调用方按 ErrNoLessonText 拒绝。
func (s *Service) loadLessonMaterials(ctx context.Context, courseLessonID string) ([]storedMaterial, []string, error) {
	materials, err := dbgen.New(s.db).ListLessonMaterials(ctx, courseLessonID)
	if err != nil {
		return nil, nil, err
	}
	if len(materials) == 0 {
		return nil, nil, ErrNoMaterials
	}
	if len(materials) > MaxMaterialsPerLesson {
		return nil, nil, ErrTooManyMaterials
	}
	files := make([]storedMaterial, 0, len(materials))
	texts := make([]string, 0, len(materials))
	for _, m := range materials {
		kind := string(m.Kind)
		if kind == "image" {
			return nil, nil, fmt.Errorf("%w: material %s is %s", ErrMaterialKindUnsupported, m.ID, m.Kind)
		}
		name := "材料"
		if m.Filename.Valid && m.Filename.String != "" {
			name = m.Filename.String
		}
		files = append(files, storedMaterial{Name: name, Key: m.StorageRef})
		rc, err := s.store.Open(ctx, m.StorageRef)
		if err != nil {
			return nil, nil, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, extract.MaxBytes+1))
		rc.Close()
		if err != nil {
			return nil, nil, err
		}
		if int64(len(data)) > extract.MaxBytes {
			return nil, nil, fmt.Errorf("%w: material %s", ErrMaterialTooLarge, m.ID)
		}
		text, err := extract.Text(kind, data)
		if err != nil {
			log.Printf("execution: skip extract for material %s: %v", m.ID, err)
			continue
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		texts = append(texts, text)
	}
	return files, texts, nil
}

func (s *Service) signMaterialURL(ctx context.Context, key string) (string, error) {
	if strings.TrimSpace(s.publicBase) == "" {
		return "", errors.New("execution: public base URL required to sign material")
	}
	ttl := s.mediaTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	rel, err := s.store.SignGet(ctx, key, ttl)
	if err != nil {
		return "", err
	}
	return absolutizeURL(s.publicBase, rel), nil
}

func absolutizeURL(base, u string) string {
	if u == "" || base == "" {
		return u
	}
	if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	return strings.TrimRight(base, "/") + u
}

// packPPTDocuments 组 create_ppt_from_documents 材料包（契约 C2）。
// 教师原文件走 url；本侧教案走 teaching_design content。不做片前的课件大纲不塞进 documents[]。
func packPPTDocuments(files []pptFile, teachingDesign string) []pptcreator.Doc {
	const maxDocs = 5
	docs := make([]pptcreator.Doc, 0, maxDocs)
	appendDoc := func(d pptcreator.Doc) {
		if len(docs) >= maxDocs {
			return
		}
		docs = append(docs, d)
	}
	if len(files) > 0 {
		name := files[0].Name
		if name == "" {
			name = "课文"
		}
		if strings.TrimSpace(files[0].URL) != "" {
			appendDoc(pptcreator.Doc{Role: "textbook", Name: name, URL: files[0].URL})
		}
		files = files[1:]
	}
	if s := strings.TrimSpace(teachingDesign); len([]rune(s)) >= 10 {
		appendDoc(pptcreator.Doc{Role: "teaching_design", Name: "教案.md", Content: s})
	}
	for i, f := range files {
		if strings.TrimSpace(f.URL) == "" {
			continue
		}
		name := f.Name
		if name == "" {
			name = fmt.Sprintf("材料 %d", i+2)
		}
		appendDoc(pptcreator.Doc{Role: "reference", Name: name, URL: f.URL})
	}
	return docs
}

func (s *Service) loadPPTDocuments(ctx context.Context, p *preparedLesson) ([]pptcreator.Doc, error) {
	signed := make([]pptFile, 0, len(p.files))
	for _, f := range p.files {
		u, err := s.signMaterialURL(ctx, f.Key)
		if err != nil {
			return nil, err
		}
		signed = append(signed, pptFile{Name: f.Name, URL: u})
	}
	design, err := s.loadPlanMarkdown(ctx, p.packageID)
	if err != nil {
		return nil, err
	}
	docs := packPPTDocuments(signed, design)
	for _, d := range docs {
		if d.Role == "textbook" {
			return docs, nil
		}
	}
	return nil, errors.New("execution: ppt materials missing textbook")
}

func lookupProjectPreset(p dbgen.Project) (preset.Preset, error) {
	id := p.PresetID
	if id == "" {
		id = preset.DigitalLesson
	}
	spec, err := preset.Lookup(id)
	if err != nil {
		return preset.Preset{}, fmt.Errorf("%w: %s", ErrUnknownPreset, id)
	}
	return spec, nil
}

func splitGate(steps []preset.Step) (pre, post []preset.Step) {
	for i, s := range steps {
		if s.GateAfter {
			return steps[:i+1], steps[i+1:]
		}
	}
	return steps, nil
}

func stepEmitting(spec preset.Preset, kind string) (preset.Step, error) {
	for _, step := range spec.Steps {
		for _, e := range step.Emits {
			if e != kind {
				continue
			}
			if kind != step.Capability {
				return preset.Step{}, ErrRebuildKind
			}
			return step, nil
		}
	}
	return preset.Step{}, fmt.Errorf("execution: unknown artifact kind %q", kind)
}

func (s *Service) runCatalogStep(ctx context.Context, p *preparedLesson, step preset.Step, note, critique string) error {
	switch step.Platform {
	case "llm":
		if step.Capability == "plan" {
			return s.runPlanStep(ctx, p, note, critique)
		}
		return s.runLLMStep(ctx, p.in, p.project, p.lessonID, p.packageID, llm.Kind(step.Capability), p.texts, note, critique)
	case "pptcreator":
		docs, err := s.loadPPTDocuments(ctx, p)
		if err != nil {
			return err
		}
		return s.runPPTStep(ctx, p.in, p.lessonID, p.packageID, docs, note, critique)
	default:
		return fmt.Errorf("execution: unknown platform %q", step.Platform)
	}
}

// refreshPackageStatus：该包声明的构件都有 current ready 版本 → ready，否则 partial。
func (s *Service) refreshPackageStatus(ctx context.Context, packageID string) error {
	q := dbgen.New(s.db)
	pkg, err := q.GetCoursePackage(ctx, packageID)
	if err != nil {
		return err
	}
	id := pkg.PresetID
	if id == "" {
		project, err := q.GetProject(ctx, pkg.ProjectID)
		if err != nil {
			return err
		}
		id = project.PresetID
	}
	if id == "" {
		id = preset.DigitalLesson
	}
	spec, err := preset.Lookup(id)
	if err != nil {
		return fmt.Errorf("%w: %s", ErrUnknownPreset, id)
	}
	arts, err := q.ListCurrentArtifacts(ctx, packageID)
	if err != nil {
		return err
	}
	ready := map[string]bool{}
	for _, a := range arts {
		if a.Status == dbgen.ArtifactsStatusReady {
			ready[a.Kind] = true
		}
	}
	status := dbgen.CoursePackagesStatusPartial
	all := len(spec.Artifacts) > 0
	for _, k := range spec.Artifacts {
		if !ready[k] {
			all = false
			break
		}
	}
	if all {
		status = dbgen.CoursePackagesStatusReady
	}
	return q.UpdatePackageStatus(ctx, dbgen.UpdatePackageStatusParams{Status: status, ID: packageID})
}

// legalTransitions 是状态机的合法迁移集（设计 §7 job 状态机）。
// 集合是 lesson 与 step 的并集：lesson 多 awaiting_confirm 一跳，step 没有。
var legalTransitions = map[dbgen.JobsStatus]map[dbgen.JobsStatus]bool{
	dbgen.JobsStatusQueued:          {dbgen.JobsStatusRunning: true},
	dbgen.JobsStatusRunning:         {dbgen.JobsStatusAwaitingConfirm: true, dbgen.JobsStatusSucceeded: true, dbgen.JobsStatusFailed: true},
	dbgen.JobsStatusAwaitingConfirm: {dbgen.JobsStatusRunning: true},
}

// transition 状态机迁移守卫：先查合法迁移集，再条件 UPDATE（前态不符 = 已被并发抢走）。
func (s *Service) transition(ctx context.Context, jobID string, from, to dbgen.JobsStatus) error {
	if !legalTransitions[from][to] {
		return fmt.Errorf("%w: %s !-> %s", ErrIllegalTransition, from, to)
	}
	rows, err := dbgen.New(s.db).TransitionJob(ctx, dbgen.TransitionJobParams{Status: to, ID: jobID, Status_2: from})
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("%w: %s !-> %s", ErrIllegalTransition, from, to)
	}
	return nil
}

// failLesson：step 失败后 lesson → failed、package → partial。错误已落在 step 上。
func (s *Service) failLesson(ctx context.Context, lesson *Lesson, stepErr error) (*Lesson, error) {
	_ = dbgen.New(s.db).UpdatePackageStatus(ctx, dbgen.UpdatePackageStatusParams{
		Status: dbgen.CoursePackagesStatusPartial, ID: lesson.PackageID,
	})
	// lesson 可能处于 running；迁移失败（已终态）不掩盖 step 错误。
	if err := s.transition(ctx, lesson.LessonJobID, dbgen.JobsStatusRunning, dbgen.JobsStatusFailed); err == nil {
		lesson.Status = string(dbgen.JobsStatusFailed)
	}
	return lesson, nil
}

// failStep 把 step 置 failed 并落诊断 JSON（error code + message）。
func (s *Service) failStep(ctx context.Context, stepID, code, message string) {
	report, _ := json.Marshal(map[string]string{"error_code": code, "message": message})
	raw := json.RawMessage(report)
	_ = dbgen.New(s.db).SetJobCostReport(ctx, dbgen.SetJobCostReportParams{CostReport: &raw, ID: stepID})
	_ = s.transition(ctx, stepID, dbgen.JobsStatusRunning, dbgen.JobsStatusFailed)
}

// settleFailure 全额退回预扣；billing 故障只记日志语义——这里直接忽略错误，
// 残留预扣由 TTL 扫尾兜底（设计 §4 生产语义）。
func (s *Service) settleFailure(ctx context.Context, reservationID, stepID string) {
	_ = s.billing.Settle(ctx, billing.SettleInput{
		ReservationID: reservationID, JobID: stepID, Outcome: billing.OutcomeFailure,
	})
}

// acquire 按 (org, platform) 取信号量（并发公平，设计 §7）。进程内实现，默认每键 2。
func (s *Service) acquire(ctx context.Context, orgID, platform string) (release func()) {
	key := orgID + "|" + platform
	s.mu.Lock()
	sem, ok := s.sems[key]
	if !ok {
		sem = make(chan struct{}, s.cfg.InFlightPerKey)
		s.sems[key] = sem
	}
	s.mu.Unlock()
	select {
	case sem <- struct{}{}:
	case <-ctx.Done():
		// 调用方 ctx 取消：返回 no-op release，由上层错误路径收尾。
		return func() {}
	}
	return func() { <-sem }
}
