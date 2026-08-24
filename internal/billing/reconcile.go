package billing

import (
	"context"
	"time"

	"codelphi/internal/dbgen"
)

// ReconcileResult 是一对（license_id, period）根池的对账结果。
type ReconcileResult struct {
	PoolID      string
	LicenseID   string
	Capability  string
	PeriodStart time.Time
	PeriodEnd   time.Time
	Used        float64 // 根池计数器
	Settled     float64 // 台账 settled 合计
	Reserved    float64 // 在途预扣合计（未过 TTL 的 reserved）
	// Drift = Used - Settled - Reserved。设计 §4 口径是「根池 used == sum(settled)」，
	// 在途预扣属「允许延迟」的部分，不计漂移；refunded/expired 已退回，天然不入账。
	Drift float64
}

// Reconcile 日对账（设计 §4 记账纪律）：只对根池，帽行不参与。
// 台账行的归属按 license_id + created_at 落在池周期内判定。
func (s *Service) Reconcile(ctx context.Context) ([]ReconcileResult, error) {
	pools, err := dbgen.New(s.db).ListRootPools(ctx)
	if err != nil {
		return nil, err
	}
	results := make([]ReconcileResult, 0, len(pools))
	q := dbgen.New(s.db)
	for _, p := range pools {
		// period_end 是 DATE 闭区间，求和用 [start, end+1d) 半开区间。
		end := p.PeriodEnd.AddDate(0, 0, 1)
		settled, err := q.SumSettledAmount(ctx, dbgen.SumSettledAmountParams{
			LicenseID: p.LicenseID, Capability: p.Capability, CreatedAt: p.PeriodStart, CreatedAt_2: end,
		})
		if err != nil {
			return nil, err
		}
		reserved, err := q.SumReservedAmount(ctx, dbgen.SumReservedAmountParams{
			LicenseID: p.LicenseID, Capability: p.Capability, CreatedAt: p.PeriodStart, CreatedAt_2: end,
		})
		if err != nil {
			return nil, err
		}
		results = append(results, ReconcileResult{
			PoolID:      p.ID,
			LicenseID:   p.LicenseID,
			Capability:  p.Capability,
			PeriodStart: p.PeriodStart,
			PeriodEnd:   p.PeriodEnd,
			Used:        p.Used,
			Settled:     settled,
			Reserved:    reserved,
			Drift:       p.Used - settled - reserved,
		})
	}
	return results, nil
}
