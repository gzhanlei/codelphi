package execution

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"codelphi/internal/dbgen"
)

// PackageSnapshot 是 get_package 的返回值：构件列表 + 当前指针 + 最近版本 + 签名 URL。
// 文件永不进返回值（设计 §7 / 计划 G）。
type PackageSnapshot struct {
	ID           string             `json:"id"`
	ProjectID    string             `json:"project_id"`
	Status       string             `json:"status"`
	LessonJobID  string             `json:"lesson_job_id,omitempty"`
	LessonStatus string             `json:"lesson_status,omitempty"`
	Error        *StepError         `json:"error,omitempty"`
	Steps        []StepSnapshot     `json:"steps,omitempty"`
	Artifacts    []ArtifactKindSnap `json:"artifacts"`
}

// StepSnapshot 是 lesson 下每个 step 的进度（工作台进度条）。
type StepSnapshot struct {
	ID         string     `json:"id"`
	Capability string     `json:"capability"`
	Status     string     `json:"status"`
	Error      *StepError `json:"error,omitempty"`
}

// StepError 来自 jobs.cost_report，工作台横幅直接用 code。
type StepError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ArtifactKindSnap 一个构件种类的当前指针 + 版本列表（新→旧）。
type ArtifactKindSnap struct {
	Kind     string         `json:"kind"`
	Current  *ArtifactSnap  `json:"current"`
	Versions []ArtifactSnap `json:"versions"`
}

// ArtifactSnap 单版本；URL 是签名链，不是文件内容。
type ArtifactSnap struct {
	ID      string `json:"id"`
	Version int32  `json:"version"`
	Status  string `json:"status"`
	URL     string `json:"url,omitempty"`
}

// GetPackage 读套件快照并签发短 TTL URL。package 不存在返回 sql.ErrNoRows。
func (s *Service) GetPackage(ctx context.Context, packageID string, ttl time.Duration) (*PackageSnapshot, error) {
	q := dbgen.New(s.db)
	pkg, err := q.GetCoursePackage(ctx, packageID)
	if err != nil {
		return nil, fmt.Errorf("execution: package: %w", err)
	}
	snap := &PackageSnapshot{
		ID:        pkg.ID,
		ProjectID: pkg.ProjectID,
		Status:    string(pkg.Status),
		Artifacts: []ArtifactKindSnap{},
	}
	if pkg.LessonJobID.Valid {
		snap.LessonJobID = pkg.LessonJobID.String
		job, err := q.GetJob(ctx, pkg.LessonJobID.String)
		if err != nil {
			return nil, err
		}
		snap.LessonStatus = string(job.Status)
		steps, err := q.ListStepJobs(ctx, sql.NullString{String: job.ID, Valid: true})
		if err != nil {
			return nil, err
		}
		for _, st := range steps {
			ss := StepSnapshot{ID: st.ID, Capability: st.Capability.String, Status: string(st.Status), Error: parseStepError(st.CostReport)}
			snap.Steps = append(snap.Steps, ss)
			if ss.Error != nil {
				snap.Error = ss.Error // 最后一次失败覆盖，工作台横幅看这个
			}
		}
	}

	arts, err := q.ListArtifactsByPackage(ctx, packageID)
	if err != nil {
		return nil, err
	}
	grouped := map[string]*ArtifactKindSnap{}
	var order []string
	for _, a := range arts {
		kind := string(a.Kind)
		g, ok := grouped[kind]
		if !ok {
			g = &ArtifactKindSnap{Kind: kind, Versions: []ArtifactSnap{}}
			grouped[kind] = g
			order = append(order, kind)
		}
		item := ArtifactSnap{ID: a.ID, Version: a.Version, Status: string(a.Status)}
		if a.StorageRef.Valid && a.StorageRef.String != "" {
			url, err := s.store.SignGet(ctx, a.StorageRef.String, ttl)
			if err != nil {
				return nil, err
			}
			item.URL = url
		}
		g.Versions = append(g.Versions, item)
		if a.IsCurrent {
			cp := item
			g.Current = &cp
		}
	}
	for _, k := range order {
		snap.Artifacts = append(snap.Artifacts, *grouped[k])
	}
	return snap, nil
}

func parseStepError(raw *json.RawMessage) *StepError {
	if raw == nil {
		return nil
	}
	var m struct {
		Code    string `json:"error_code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(*raw, &m); err != nil || m.Code == "" {
		return nil
	}
	return &StepError{Code: m.Code, Message: m.Message}
}

// RecoverInFlight 进程启动时调用：上一进程残留的 queued/running 一律 failed，
// 对应 package 置 partial。预扣不在这里退——billing TTL 扫尾兜底（设计 §4）。
func (s *Service) RecoverInFlight(ctx context.Context) (int, error) {
	jobs, err := dbgen.New(s.db).ListJobsByStatuses(ctx, dbgen.ListJobsByStatusesParams{
		Status:   dbgen.JobsStatusQueued,
		Status_2: dbgen.JobsStatusRunning,
	})
	if err != nil {
		return 0, err
	}
	return s.abortJobs(ctx, jobs, "stale_running", "process restart: in-flight job aborted")
}

// SweepTimedOut 超时收敛：running 且 updated_at 早于 now-maxAge 的 job 置 failed。
func (s *Service) SweepTimedOut(ctx context.Context, maxAge time.Duration) (int, error) {
	if maxAge <= 0 {
		maxAge = 30 * time.Minute
	}
	jobs, err := dbgen.New(s.db).ListStaleRunningJobs(ctx, time.Now().Add(-maxAge))
	if err != nil {
		return 0, err
	}
	return s.abortJobs(ctx, jobs, "timed_out", "job exceeded timeout")
}

func (s *Service) abortJobs(ctx context.Context, jobs []dbgen.Job, code, message string) (int, error) {
	q := dbgen.New(s.db)
	report, _ := json.Marshal(map[string]string{"error_code": code, "message": message})
	raw := json.RawMessage(report)
	n := 0
	lessons := map[string]bool{}
	parents := map[string]bool{}
	for _, j := range jobs {
		rows, err := q.AbortJob(ctx, dbgen.AbortJobParams{CostReport: &raw, ID: j.ID})
		if err != nil {
			return n, err
		}
		if rows == 0 {
			continue
		}
		n++
		if j.Kind == dbgen.JobsKindLesson {
			lessons[j.ID] = true
		} else if j.ParentID.Valid {
			lessons[j.ParentID.String] = true
			parents[j.ParentID.String] = true
		}
	}
	// 超时扫到的 step 要把还在跑的父 lesson 一并收敛（不计入 n，避免打乱启动恢复计数）。
	for id := range parents {
		if _, already := findJob(jobs, id); already {
			continue
		}
		_, _ = q.AbortJob(ctx, dbgen.AbortJobParams{CostReport: &raw, ID: id})
	}
	for id := range lessons {
		_ = q.PartialPackageByLesson(ctx, sql.NullString{String: id, Valid: true})
	}
	return n, nil
}

func findJob(jobs []dbgen.Job, id string) (dbgen.Job, bool) {
	for _, j := range jobs {
		if j.ID == id {
			return j, true
		}
	}
	return dbgen.Job{}, false
}
