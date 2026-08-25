package billing

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/oklog/ulid/v2"

	"codelphi/internal/dbgen"
)

// DenyReason 是设计 §5「模型可见错误面」中 M1 计费侧的 deny reason 全集。
type DenyReason string

const (
	ReasonLicenseExpired        DenyReason = "license_expired"
	ReasonCapabilityNotEntitled DenyReason = "capability_not_entitled"
	ReasonMemberCapExhausted    DenyReason = "member_cap_exhausted"
	ReasonQuotaExhausted        DenyReason = "quota_exhausted"
	ReasonOrgSuspended          DenyReason = "org_suspended"
	ReasonMemberDisabled        DenyReason = "member_disabled"
)

// 计量单位（quota_pools.unit / usage_records.unit 的 ENUM）。
const (
	UnitCount  = "count"
	UnitSecond = "second"
	UnitMinute = "minute"
)

// Outcome 是 settle 的 job 结局。
type Outcome string

const (
	OutcomeSuccess Outcome = "success"
	OutcomeFailure Outcome = "failure"
)

var (
	// ErrJobNotFound：settle 的 job_id 在台账里不存在。
	ErrJobNotFound = errors.New("billing: unknown job_id")
	// ErrJobConflict：job_id 已存在且不属于本 reservation——一次尝试一个 job_id（设计 §4），
	// 重试必须新 job 新预扣，不允许在 refunded 行上复活。
	ErrJobConflict = errors.New("billing: job_id belongs to another reservation")
	// ErrRootPoolMissing：Org 根池每单必有（设计 §3），缺失是开通流程的事故，fail-closed。
	ErrRootPoolMissing = errors.New("billing: org root quota pool not found")
	// ErrOrgSuspended：机构已停用。Authorize 与无预扣写入（导回）共用。
	ErrOrgSuspended = errors.New("billing: org_suspended")
)

// AuthorizeInput 是 authorize 闸门的入参（设计 §4）。
type AuthorizeInput struct {
	OrgID           string
	UnitID          string // 可空：空则不查 unit 帽
	MemberID        string
	ProjectID       string
	Capability      string
	EstimatedAmount float64
	JobID           string // 幂等键：一次尝试一个 job_id
	Unit            string // count / second / minute
}

// Decision 是 authorize 的裁决：Allow 带 ReservationID，Deny 带 Reason。
type Decision struct {
	Allowed       bool
	ReservationID string
	Reason        DenyReason
}

// SettleInput 是 settle 的入参（按 JobID 幂等）。
type SettleInput struct {
	ReservationID string
	JobID         string
	ActualAmount  float64
	VendorCost    *float64 // 可空
	Outcome       Outcome
}

// Service 是授权/计费的唯一写入口。
type Service struct {
	db         *sql.DB
	ttl        time.Duration
	sweepBatch int32
}

// Option 可调项；默认即可用于生产。
type Option func(*Service)

// WithReservationTTL 覆盖预扣 TTL（默认 24h，设计 §4 生产语义）。
func WithReservationTTL(ttl time.Duration) Option {
	return func(s *Service) { s.ttl = ttl }
}

// WithSweepBatch 覆盖扫尾单批上限（默认 500）。
func WithSweepBatch(n int32) Option {
	return func(s *Service) { s.sweepBatch = n }
}

func New(db *sql.DB, opts ...Option) *Service {
	s := &Service{db: db, ttl: 24 * time.Hour, sweepBatch: 500}
	for _, o := range opts {
		o(s)
	}
	return s
}

// snapshotItem 是 License 套餐快照的条目（结构同 PackageTemplate.items，设计 §3）。
type snapshotItem struct {
	Capability string  `json:"capability"`
	Quota      float64 `json:"quota"`
	Unit       string  `json:"unit"`
}

// snapshotEntitles 判定能力是否在套餐快照内。快照不可解析视为不含（fail-closed）。
func snapshotEntitles(snapshot json.RawMessage, capability string) bool {
	var items []snapshotItem
	if err := json.Unmarshal(snapshot, &items); err != nil {
		return false
	}
	for _, it := range items {
		if it.Capability == capability {
			return true
		}
	}
	return false
}

// AssertOrgActive 给无 vendor / 无预扣的写入用（导回 pptx）。不落 UsageRecord。
func (s *Service) AssertOrgActive(ctx context.Context, orgID string) error {
	org, err := dbgen.New(s.db).GetOrgByID(ctx, orgID)
	if err != nil {
		return err
	}
	if org.Status == dbgen.OrgsStatusSuspended {
		return ErrOrgSuspended
	}
	return nil
}

// Authorize 实现设计 §4 的 authorize 闸门。全部检查与预扣在一个事务内完成；
// 任一层不足即回滚并 deny，同时落 audit_logs。
func (s *Service) Authorize(ctx context.Context, in AuthorizeInput) (Decision, error) {
	if err := validateAuthorize(in); err != nil {
		return Decision{}, err
	}
	q := dbgen.New(s.db)
	now := time.Now()

	org, err := q.GetOrgByID(ctx, in.OrgID)
	if errors.Is(err, sql.ErrNoRows) {
		return Decision{}, fmt.Errorf("billing: org %s: %w", in.OrgID, sql.ErrNoRows)
	}
	if err != nil {
		return Decision{}, err
	}
	if org.Status == dbgen.OrgsStatusSuspended {
		return s.deny(ctx, in, ReasonOrgSuspended)
	}

	member, err := q.GetMemberByID(ctx, in.MemberID)
	if errors.Is(err, sql.ErrNoRows) {
		return Decision{}, fmt.Errorf("billing: member %s: %w", in.MemberID, sql.ErrNoRows)
	}
	if err != nil {
		return Decision{}, err
	}
	if member.OrgID != in.OrgID {
		return Decision{}, fmt.Errorf("billing: member %s not in org %s", in.MemberID, in.OrgID)
	}
	if member.Status == dbgen.MembersStatusDisabled {
		return s.deny(ctx, in, ReasonMemberDisabled)
	}

	// License 有效期与状态：多 License 并存取先到期者（valid_to 升序，SQL 已排序）。
	licenses, err := q.ListUsableLicenses(ctx, dbgen.ListUsableLicensesParams{
		OrgID: in.OrgID, ValidFrom: now, ValidTo: now,
	})
	if err != nil {
		return Decision{}, err
	}
	if len(licenses) == 0 {
		return s.deny(ctx, in, ReasonLicenseExpired)
	}
	// 能力在套餐快照内：取第一份含该能力的 License；单 job 不跨池拼凑。
	lic := licenses[0]
	found := false
	for _, l := range licenses {
		if snapshotEntitles(l.Snapshot, in.Capability) {
			lic = l
			found = true
			break
		}
	}
	if !found {
		return s.deny(ctx, in, ReasonCapabilityNotEntitled)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Decision{}, err
	}
	defer tx.Rollback() // 提交后调用是 no-op
	qt := q.WithTx(tx)

	// 链式预扣：成员个人帽（行存在才查）→ unit 帽（行存在才查）→ Org 根池。
	var hits []string

	memberHit, ok, err := s.tryReserve(ctx, qt, dbgen.QuotaPoolsNodeTypeMember, in.MemberID, lic.ID, in, now)
	if err != nil {
		return Decision{}, err
	}
	if !ok {
		return s.deny(ctx, in, ReasonMemberCapExhausted)
	}
	if memberHit != "" {
		hits = append(hits, memberHit)
	}

	if in.UnitID != "" {
		unitHit, ok, err := s.tryReserve(ctx, qt, dbgen.QuotaPoolsNodeTypeUnit, in.UnitID, lic.ID, in, now)
		if err != nil {
			return Decision{}, err
		}
		if !ok {
			return s.deny(ctx, in, ReasonQuotaExhausted)
		}
		if unitHit != "" {
			hits = append(hits, unitHit)
		}
	}

	// 根池每单必有：无行是开通事故，不是「未设帽」。
	root, err := qt.GetQuotaPool(ctx, dbgen.GetQuotaPoolParams{
		NodeType: dbgen.QuotaPoolsNodeTypeOrg, NodeID: in.OrgID,
		LicenseID: lic.ID, Capability: in.Capability,
		PeriodStart: now, PeriodEnd: now,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Decision{}, fmt.Errorf("org %s license %s capability %s: %w", in.OrgID, lic.ID, in.Capability, ErrRootPoolMissing)
	}
	if err != nil {
		return Decision{}, err
	}
	rows, err := qt.ReserveQuota(ctx, dbgen.ReserveQuotaParams{
		Used: in.EstimatedAmount, ID: root.ID, Used_2: in.EstimatedAmount,
	})
	if err != nil {
		return Decision{}, err
	}
	if rows == 0 {
		// 第一份 License 根池不够即 deny，不看下一份（设计 §4：不跨池拼凑）。
		return s.deny(ctx, in, ReasonQuotaExhausted)
	}
	hits = append(hits, root.ID)

	hitJSON, err := json.Marshal(hits)
	if err != nil {
		return Decision{}, err
	}
	reservationID := ulid.Make().String()
	err = qt.InsertUsageRecord(ctx, dbgen.InsertUsageRecordParams{
		ID:         reservationID,
		JobID:      in.JobID,
		OrgID:      in.OrgID,
		LicenseID:  lic.ID,
		MemberID:   in.MemberID,
		UnitID:     sql.NullString{String: in.UnitID, Valid: in.UnitID != ""},
		ProjectID:  sql.NullString{String: in.ProjectID, Valid: in.ProjectID != ""},
		Capability: in.Capability,
		Amount:     in.EstimatedAmount,
		Unit:       dbgen.UsageRecordsUnit(in.Unit),
		HitPools:   hitJSON,
	})
	if err != nil {
		return Decision{}, fmt.Errorf("billing: insert usage record (job_id 冲突即重试未换新 job): %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Decision{}, err
	}
	return Decision{Allowed: true, ReservationID: reservationID}, nil
}

// tryReserve 查该节点当前周期的计数器行；无行 = 未设帽，天然跳过（hit 为空、ok=true）。
// 有行则条件更新预扣，不足返回 ok=false。
func (s *Service) tryReserve(ctx context.Context, q *dbgen.Queries, nodeType dbgen.QuotaPoolsNodeType, nodeID, licenseID string, in AuthorizeInput, now time.Time) (hit string, ok bool, err error) {
	pool, err := q.GetQuotaPool(ctx, dbgen.GetQuotaPoolParams{
		NodeType: nodeType, NodeID: nodeID,
		LicenseID: licenseID, Capability: in.Capability,
		PeriodStart: now, PeriodEnd: now,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", true, nil
	}
	if err != nil {
		return "", false, err
	}
	rows, err := q.ReserveQuota(ctx, dbgen.ReserveQuotaParams{
		Used: in.EstimatedAmount, ID: pool.ID, Used_2: in.EstimatedAmount,
	})
	if err != nil {
		return "", false, err
	}
	if rows == 0 {
		return pool.ID, false, nil
	}
	return pool.ID, true, nil
}

// deny 回滚已由 defer 兜底；这里只落审计并返回裁决。
func (s *Service) deny(ctx context.Context, in AuthorizeInput, reason DenyReason) (Decision, error) {
	after, _ := json.Marshal(map[string]any{
		"reason":     string(reason),
		"capability": in.Capability,
		"estimated":  in.EstimatedAmount,
	})
	err := dbgen.New(s.db).InsertAuditLog(ctx, dbgen.InsertAuditLogParams{
		Actor:     "member:" + in.MemberID,
		Action:    "authorize_deny",
		Target:    "org:" + in.OrgID,
		AfterJson: after,
	})
	if err != nil {
		return Decision{}, fmt.Errorf("billing: audit deny: %w", err)
	}
	return Decision{Reason: reason}, nil
}

// Settle 实现设计 §4 的 settle（按 job_id 幂等）。
// 先条件更新认领行（reserved → settled|refunded），认领成功才调平各命中层；
// 重复回调、与扫尾抢输都直接返回 nil，不改数字。
// 宽限期：settle 不查 License 有效期与 org 状态——org_suspended 不杀 in-flight。
func (s *Service) Settle(ctx context.Context, in SettleInput) error {
	if in.JobID == "" || in.ReservationID == "" {
		return errors.New("billing: settle requires job_id and reservation_id")
	}
	if in.Outcome != OutcomeSuccess && in.Outcome != OutcomeFailure {
		return fmt.Errorf("billing: invalid outcome %q", in.Outcome)
	}
	if in.Outcome == OutcomeSuccess && in.ActualAmount < 0 {
		return errors.New("billing: actual_amount must be >= 0")
	}
	q := dbgen.New(s.db)

	rec, err := q.GetUsageRecordByJobID(ctx, in.JobID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrJobNotFound
	}
	if err != nil {
		return err
	}
	if rec.ID != in.ReservationID {
		return ErrJobConflict
	}
	if rec.Status != dbgen.UsageRecordsStatusReserved {
		return nil // 重复回调无害：已 settled/refunded/expired 不再改数字
	}
	hits, err := parseHitPools(rec.HitPools)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	qt := q.WithTx(tx)

	if in.Outcome == OutcomeSuccess {
		rows, err := qt.ClaimSettled(ctx, dbgen.ClaimSettledParams{
			Amount:     in.ActualAmount,
			VendorCost: sql.NullFloat64{Float64: deref(in.VendorCost), Valid: in.VendorCost != nil},
			ID:         rec.ID,
		})
		if err != nil {
			return err
		}
		if rows == 0 {
			return nil // 与扫尾抢输：对方已退款，不再改数字
		}
		// 各命中层按差额调平：actual > estimated 补扣，actual < estimated 退回。
		if delta := in.ActualAmount - rec.Amount; delta != 0 {
			if err := adjustPools(ctx, qt, hits, delta); err != nil {
				return err
			}
		}
	} else {
		rows, err := qt.ClaimTerminal(ctx, dbgen.ClaimTerminalParams{
			Status: dbgen.UsageRecordsStatusRefunded, ID: rec.ID,
		})
		if err != nil {
			return err
		}
		if rows == 0 {
			return nil
		}
		// 失败：各命中层全额退回。
		if err := adjustPools(ctx, qt, hits, -rec.Amount); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SweepExpired 把 created_at 早于 now-TTL 的 reserved 行扫成 expired 并退回预扣。
// 与 Settle 抢同一行靠条件更新，谁先谁算（设计 §4 生产语义）。返回本批扫掉的行数。
func (s *Service) SweepExpired(ctx context.Context, now time.Time) (int, error) {
	q := dbgen.New(s.db)
	recs, err := q.ListExpiredReservations(ctx, dbgen.ListExpiredReservationsParams{
		CreatedAt: now.Add(-s.ttl),
		Limit:     s.sweepBatch,
	})
	if err != nil {
		return 0, err
	}
	swept := 0
	for _, rec := range recs {
		hits, err := parseHitPools(rec.HitPools)
		if err != nil {
			return swept, err
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return swept, err
		}
		rows, err := q.WithTx(tx).ClaimTerminal(ctx, dbgen.ClaimTerminalParams{
			Status: dbgen.UsageRecordsStatusExpired, ID: rec.ID,
		})
		if err != nil {
			tx.Rollback()
			return swept, err
		}
		if rows == 0 {
			// 与 Settle 抢输：行已被 settle/refund，跳过。
			tx.Rollback()
			continue
		}
		if err := adjustPools(ctx, q.WithTx(tx), hits, -rec.Amount); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err := tx.Commit(); err != nil {
			return swept, err
		}
		swept++
	}
	return swept, nil
}

// adjustPools 对命中层做无条件调平；调用前提是行已被条件更新认领。
func adjustPools(ctx context.Context, q *dbgen.Queries, hits []string, delta float64) error {
	for _, id := range hits {
		if err := q.AdjustQuotaUsed(ctx, dbgen.AdjustQuotaUsedParams{Used: delta, ID: id}); err != nil {
			return err
		}
	}
	return nil
}

func parseHitPools(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var hits []string
	if err := json.Unmarshal(raw, &hits); err != nil {
		return nil, fmt.Errorf("billing: parse hit_pools: %w", err)
	}
	return hits, nil
}

func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func validateAuthorize(in AuthorizeInput) error {
	if in.OrgID == "" || in.MemberID == "" || in.Capability == "" || in.JobID == "" {
		return errors.New("billing: org_id/member_id/capability/job_id are required")
	}
	if in.EstimatedAmount <= 0 {
		return errors.New("billing: estimated_amount must be > 0")
	}
	switch in.Unit {
	case UnitCount, UnitSecond, UnitMinute:
	default:
		return fmt.Errorf("billing: invalid unit %q", in.Unit)
	}
	return nil
}
