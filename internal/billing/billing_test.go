package billing

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
)

func ulidStr() string { return ulid.Make().String() }

func newService() *Service { return New(testDB) }

// 并发 Authorize 抢根池最后一份：N 个 goroutine 只有 1 个 allow（PLAN §9）。
func TestAuthorizeConcurrentLastSlot(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 1)
	s := newService()

	const n = 8
	start := make(chan struct{})
	decisions := make([]Decision, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			decisions[i], errs[i] = s.Authorize(context.Background(), baseInput(f, ulidStr()))
		}(i)
	}
	close(start)
	wg.Wait()

	allowed := 0
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if decisions[i].Allowed {
			allowed++
		} else if decisions[i].Reason != ReasonQuotaExhausted {
			t.Fatalf("unexpected reason: %s", decisions[i].Reason)
		}
	}
	if allowed != 1 {
		t.Fatalf("want exactly 1 allow, got %d", allowed)
	}
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 1) {
		t.Fatalf("root used = %v, want 1", used)
	}
}

// Settle 幂等：同一 job_id 两次 success，used 只变一次（PLAN §9）。
func TestSettleIdempotent(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 10)
	s := newService()

	in := baseInput(f, ulidStr())
	d := mustAllow(t, s, in)
	cost := 0.42
	settle := SettleInput{ReservationID: d.ReservationID, JobID: in.JobID, ActualAmount: 1, VendorCost: &cost, Outcome: OutcomeSuccess}
	if err := s.Settle(context.Background(), settle); err != nil {
		t.Fatal(err)
	}
	if err := s.Settle(context.Background(), settle); err != nil {
		t.Fatalf("重复回调应无害: %v", err)
	}

	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 1) {
		t.Fatalf("root used = %v, want 1（只变一次）", used)
	}
	if status := recordStatus(t, in.JobID); status != "settled" {
		t.Fatalf("status = %s, want settled", status)
	}
	var gotCost float64
	var settledAtSet bool
	if err := testDB.QueryRow("SELECT vendor_cost, settled_at IS NOT NULL FROM usage_records WHERE job_id = ?", in.JobID).
		Scan(&gotCost, &settledAtSet); err != nil {
		t.Fatal(err)
	}
	if !almostEqual(gotCost, cost) {
		t.Fatalf("vendor_cost = %v, want %v", gotCost, cost)
	}
	if !settledAtSet {
		t.Fatal("settled_at 未写入")
	}
}

// 失败退款：reserved → refunded，各命中层回滚（PLAN §9）。
// 且重试用同一 job_id 必须报错（一次尝试一个 job_id，不复活 refunded 行）。
func TestSettleFailureRefundsAllLayers(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 10)
	unitID := ulidStr()
	execSQL(t, `INSERT INTO org_units (id, org_id, name) VALUES (?, ?, '教研室A')`, unitID, f.orgID)
	memberPool := insertPool(t, "member", f.memberID, f.licenseID, "ppt", 5)
	unitPool := insertPool(t, "unit", unitID, f.licenseID, "ppt", 5)
	s := newService()

	in := baseInput(f, ulidStr())
	in.UnitID = unitID
	d := mustAllow(t, s, in)
	for _, p := range []string{memberPool, unitPool, f.rootPoolID} {
		if used := poolUsed(t, p); !almostEqual(used, 1) {
			t.Fatalf("pool %s used = %v, want 1", p, used)
		}
	}

	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: d.ReservationID, JobID: in.JobID, Outcome: OutcomeFailure,
	}); err != nil {
		t.Fatal(err)
	}
	if status := recordStatus(t, in.JobID); status != "refunded" {
		t.Fatalf("status = %s, want refunded", status)
	}
	for _, p := range []string{memberPool, unitPool, f.rootPoolID} {
		if used := poolUsed(t, p); !almostEqual(used, 0) {
			t.Fatalf("pool %s used = %v, want 0（全额退回）", p, used)
		}
	}

	// 同一 job_id 再次 authorize：撞上唯一索引，必须报错而不是复活。
	if _, err := s.Authorize(context.Background(), in); err == nil {
		t.Fatal("重复 job_id 应报错（重试必须新 job 新预扣）")
	}
	// 非本 reservation 的 settle：明确错误。
	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: ulidStr(), JobID: in.JobID, Outcome: OutcomeSuccess, ActualAmount: 1,
	}); !errors.Is(err, ErrJobConflict) {
		t.Fatalf("want ErrJobConflict, got %v", err)
	}
}

// TTL：reserved 过期被扫成 expired 且预扣退回；随后迟到的 Settle 无害（PLAN §9）。
func TestSweepExpiredThenLateSettle(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 10)
	s := New(testDB, WithReservationTTL(time.Hour))

	in := baseInput(f, ulidStr())
	d := mustAllow(t, s, in)

	// TTL 内不扫。
	if n, err := s.SweepExpired(context.Background(), time.Now().Add(30*time.Minute)); err != nil || n != 0 {
		t.Fatalf("swept=%d err=%v, want 0", n, err)
	}
	// 过期后扫尾。
	if n, err := s.SweepExpired(context.Background(), time.Now().Add(2*time.Hour)); err != nil || n != 1 {
		t.Fatalf("swept=%d err=%v, want 1", n, err)
	}
	if status := recordStatus(t, in.JobID); status != "expired" {
		t.Fatalf("status = %s, want expired", status)
	}
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 0) {
		t.Fatalf("root used = %v, want 0（预扣退回）", used)
	}

	// 迟到的 settle 无害，数字不再变。
	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: d.ReservationID, JobID: in.JobID, ActualAmount: 1, Outcome: OutcomeSuccess,
	}); err != nil {
		t.Fatalf("迟到的 settle 应无害: %v", err)
	}
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 0) {
		t.Fatalf("late settle 后 root used = %v, want 0", used)
	}
	if status := recordStatus(t, in.JobID); status != "expired" {
		t.Fatalf("late settle 后 status = %s, want expired", status)
	}
}

// 扫尾与 Settle 并发抢同一行：只有一个生效（PLAN §9，条件更新谁先谁算）。
func TestSweepSettleRace(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 1000)
	s := newService() // 默认 TTL 24h

	const rounds = 50
	settled := 0
	for i := 0; i < rounds; i++ {
		in := baseInput(f, ulidStr())
		d := mustAllow(t, s, in)

		var wg sync.WaitGroup
		var settleErr, sweepErr error
		var swept int
		wg.Add(2)
		go func() {
			defer wg.Done()
			settleErr = s.Settle(context.Background(), SettleInput{
				ReservationID: d.ReservationID, JobID: in.JobID, ActualAmount: 1, Outcome: OutcomeSuccess,
			})
		}()
		go func() {
			defer wg.Done()
			swept, sweepErr = s.SweepExpired(context.Background(), time.Now().Add(48*time.Hour))
		}()
		wg.Wait()
		if settleErr != nil || sweepErr != nil {
			t.Fatalf("round %d: settleErr=%v sweepErr=%v", i, settleErr, sweepErr)
		}

		status := recordStatus(t, in.JobID)
		switch status {
		case "settled":
			if swept != 0 {
				t.Fatalf("round %d: settled 但 sweep 也认领了", i)
			}
			settled++
		case "expired":
			if swept == 0 {
				t.Fatalf("round %d: expired 但 sweep 没认领", i)
			}
		default:
			t.Fatalf("round %d: status = %s", i, status)
		}
	}
	// 无论谁赢，根池 used 必须恰好等于 settled 行数——没有双扣也没有漏退。
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, float64(settled)) {
		t.Fatalf("root used = %v, want %d (settled count)", used, settled)
	}
}

// 多 License：先到期者优先；旧池不够时 deny 而不跨池（PLAN §9）。
func TestMultiLicenseNoCrossPool(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 1) // 旧 License：valid_to +1 年，根池 1

	// 新 License：先到期者是旧的——把旧的 valid_to 改近，新的放远。
	oldTo := time.Now().AddDate(0, 1, 0)
	execSQL(t, "UPDATE licenses SET valid_to = ? WHERE id = ?", oldTo, f.licenseID)
	newLicenseID := ulidStr()
	insertLicense(t, f.orgID, newLicenseID, licenseFrom, time.Now().AddDate(2, 0, 0), "ppt")
	newRootPool := insertPool(t, "org", f.orgID, newLicenseID, "ppt", 10)

	s := newService()
	// 第一笔落在旧池（先到期者优先），新池不动。
	mustAllow(t, s, baseInput(f, ulidStr()))
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 1) {
		t.Fatalf("旧池 used = %v, want 1", used)
	}
	if used := poolUsed(t, newRootPool); !almostEqual(used, 0) {
		t.Fatalf("新池 used = %v, want 0（旧池未尽不动新池）", used)
	}

	// 旧池不够：deny quota_exhausted，不跨池到新池。
	mustDeny(t, s, baseInput(f, ulidStr()), ReasonQuotaExhausted)
	if used := poolUsed(t, newRootPool); !almostEqual(used, 0) {
		t.Fatalf("新池 used = %v, want 0（不跨池拼凑）", used)
	}
}

// 未设帽的 unit/member 层无行也能通过，只扣根池（设计 §4 记账纪律）。
func TestUncappedLayersSkipped(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 10)
	s := newService()

	in := baseInput(f, ulidStr())
	in.UnitID = ulidStr() // unit 无任何计数器行
	d := mustAllow(t, s, in)
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 1) {
		t.Fatalf("root used = %v, want 1", used)
	}
	var hitRaw string
	if err := testDB.QueryRow("SELECT hit_pools FROM usage_records WHERE id = ?", d.ReservationID).
		Scan(&hitRaw); err != nil {
		t.Fatal(err)
	}
	var hitPools []string
	if err := json.Unmarshal([]byte(hitRaw), &hitPools); err != nil {
		t.Fatal(err)
	}
	if len(hitPools) != 1 || hitPools[0] != f.rootPoolID {
		t.Fatalf("hit_pools = %v, want only root pool", hitPools)
	}
}

// 个人帽与根池耗尽是两种 deny，必须分开（设计 §5 错误面）。
func TestMemberCapVsQuotaExhausted(t *testing.T) {
	t.Run("member_cap_exhausted", func(t *testing.T) {
		resetTables(t)
		f := newFixture(t, "ppt", 10)
		insertPool(t, "member", f.memberID, f.licenseID, "ppt", 1)
		s := newService()

		mustAllow(t, s, baseInput(f, ulidStr()))
		mustDeny(t, s, baseInput(f, ulidStr()), ReasonMemberCapExhausted)
		if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 1) {
			t.Fatalf("root used = %v, want 1（帽 deny 不得污染根池）", used)
		}
	})
	t.Run("quota_exhausted", func(t *testing.T) {
		resetTables(t)
		f := newFixture(t, "ppt", 1)
		insertPool(t, "member", f.memberID, f.licenseID, "ppt", 10)
		s := newService()

		mustAllow(t, s, baseInput(f, ulidStr()))
		mustDeny(t, s, baseInput(f, ulidStr()), ReasonQuotaExhausted)
	})
}

// 能力不在快照 / License 过期 / org 暂停 / 成员停用，各自 deny 且落审计（设计 §5）。
func TestDenyReasons(t *testing.T) {
	t.Run("capability_not_entitled", func(t *testing.T) {
		resetTables(t)
		f := newFixture(t, "ppt", 10)
		s := newService()
		in := baseInput(f, ulidStr())
		in.Capability = "lecture_video"
		mustDeny(t, s, in, ReasonCapabilityNotEntitled)
	})
	t.Run("license_expired", func(t *testing.T) {
		resetTables(t)
		f := newFixture(t, "ppt", 10)
		execSQL(t, "UPDATE licenses SET valid_to = ? WHERE id = ?",
			time.Now().AddDate(0, 0, -1), f.licenseID)
		s := newService()
		mustDeny(t, s, baseInput(f, ulidStr()), ReasonLicenseExpired)
	})
	t.Run("org_suspended", func(t *testing.T) {
		resetTables(t)
		f := newFixture(t, "ppt", 10)
		execSQL(t, "UPDATE orgs SET status = 'suspended' WHERE id = ?", f.orgID)
		s := newService()
		mustDeny(t, s, baseInput(f, ulidStr()), ReasonOrgSuspended)
	})
	t.Run("member_disabled", func(t *testing.T) {
		resetTables(t)
		f := newFixture(t, "ppt", 10)
		execSQL(t, "UPDATE members SET status = 'disabled' WHERE id = ?", f.memberID)
		s := newService()
		mustDeny(t, s, baseInput(f, ulidStr()), ReasonMemberDisabled)
	})
	t.Run("deny_audit_log", func(t *testing.T) {
		resetTables(t)
		f := newFixture(t, "ppt", 10)
		s := newService()
		in := baseInput(f, ulidStr())
		in.Capability = "nope"
		mustDeny(t, s, in, ReasonCapabilityNotEntitled)

		var actor, action, target, afterJSON string
		if err := testDB.QueryRow(`SELECT actor, action, target, after_json FROM audit_logs
			ORDER BY id DESC LIMIT 1`).Scan(&actor, &action, &target, &afterJSON); err != nil {
			t.Fatal(err)
		}
		if action != "authorize_deny" || actor != "member:"+f.memberID || target != "org:"+f.orgID {
			t.Fatalf("audit = %s/%s/%s", actor, action, target)
		}
		var after map[string]any
		if err := json.Unmarshal([]byte(afterJSON), &after); err != nil {
			t.Fatal(err)
		}
		if after["reason"] != string(ReasonCapabilityNotEntitled) || after["capability"] != "nope" {
			t.Fatalf("after_json = %v", after)
		}
	})
}

// org_suspended 拦新任务但不杀 in-flight（设计 §4 宽限期）：暂停后 settle 照常结算。
func TestOrgSuspendedDoesNotKillInflight(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 10)
	s := newService()

	in := baseInput(f, ulidStr())
	d := mustAllow(t, s, in)
	execSQL(t, "UPDATE orgs SET status = 'suspended' WHERE id = ?", f.orgID)

	mustDeny(t, s, baseInput(f, ulidStr()), ReasonOrgSuspended) // 新任务被拦
	if err := s.Settle(context.Background(), SettleInput{       // in-flight 照常结算
		ReservationID: d.ReservationID, JobID: in.JobID, ActualAmount: 1, Outcome: OutcomeSuccess,
	}); err != nil {
		t.Fatal(err)
	}
	if status := recordStatus(t, in.JobID); status != "settled" {
		t.Fatalf("status = %s, want settled", status)
	}
}

func TestAssertOrgActive(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 10)
	s := newService()
	if err := s.AssertOrgActive(context.Background(), f.orgID); err != nil {
		t.Fatal(err)
	}
	execSQL(t, "UPDATE orgs SET status = 'suspended' WHERE id = ?", f.orgID)
	if err := s.AssertOrgActive(context.Background(), f.orgID); !errors.Is(err, ErrOrgSuspended) {
		t.Fatalf("err=%v, want ErrOrgSuspended", err)
	}
}

// actual 与 estimated 的差值调平：actual > estimated 补扣，actual < estimated 退回。
func TestSettleDeltaAdjustment(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 100)
	s := newService()

	// actual > estimated：补扣差额。
	in1 := baseInput(f, ulidStr())
	d1 := mustAllow(t, s, in1)
	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: d1.ReservationID, JobID: in1.JobID, ActualAmount: 3, Outcome: OutcomeSuccess,
	}); err != nil {
		t.Fatal(err)
	}
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 3) {
		t.Fatalf("root used = %v, want 3", used)
	}

	// actual < estimated：退回差额。
	in2 := baseInput(f, ulidStr())
	in2.EstimatedAmount = 2
	d2 := mustAllow(t, s, in2)
	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: d2.ReservationID, JobID: in2.JobID, ActualAmount: 0.5, Outcome: OutcomeSuccess,
	}); err != nil {
		t.Fatal(err)
	}
	if used := poolUsed(t, f.rootPoolID); !almostEqual(used, 3.5) {
		t.Fatalf("root used = %v, want 3.5", used)
	}
	var amount float64
	if err := testDB.QueryRow("SELECT amount FROM usage_records WHERE job_id = ?", in2.JobID).Scan(&amount); err != nil {
		t.Fatal(err)
	}
	if !almostEqual(amount, 0.5) {
		t.Fatalf("settled amount = %v, want 0.5（台账记实际值）", amount)
	}
}

// 日对账：造数对齐；篡改 used 后报漂移（PLAN §9）。
func TestReconcile(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 100)
	s := newService()

	// 两笔 settled + 一笔在途 reserved + 一笔 refunded。
	for i := 0; i < 2; i++ {
		in := baseInput(f, ulidStr())
		d := mustAllow(t, s, in)
		if err := s.Settle(context.Background(), SettleInput{
			ReservationID: d.ReservationID, JobID: in.JobID, ActualAmount: 1, Outcome: OutcomeSuccess,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mustAllow(t, s, baseInput(f, ulidStr())) // 在途 reserved
	inFail := baseInput(f, ulidStr())
	dFail := mustAllow(t, s, inFail)
	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: dFail.ReservationID, JobID: inFail.JobID, Outcome: OutcomeFailure,
	}); err != nil {
		t.Fatal(err)
	}

	results, err := s.Reconcile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1", len(results))
	}
	r := results[0]
	if !almostEqual(r.Used, 3) || !almostEqual(r.Settled, 2) || !almostEqual(r.Reserved, 1) || !almostEqual(r.Drift, 0) {
		t.Fatalf("reconcile = %+v, want used=3 settled=2 reserved=1 drift=0", r)
	}

	// 手工篡改 used → 漂移 > 0。
	execSQL(t, "UPDATE quota_pools SET used = used + 5 WHERE id = ?", f.rootPoolID)
	results, err = s.Reconcile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !almostEqual(results[0].Drift, 5) {
		t.Fatalf("drift = %v, want 5", results[0].Drift)
	}
}

// 同一 License 多个能力：对账按 capability 拆开，互不污染。
func TestReconcileMultiCapability(t *testing.T) {
	resetTables(t)
	f := newFixture(t, "ppt", 100)
	// 同一 License 快照加一个能力，根池加一行。
	execSQL(t, "UPDATE licenses SET snapshot = ? WHERE id = ?",
		`[{"capability":"ppt","quota":100,"unit":"count"},{"capability":"design","quota":100,"unit":"count"}]`, f.licenseID)
	insertPool(t, "org", f.orgID, f.licenseID, "design", 100)
	s := newService()

	mustAllow(t, s, baseInput(f, ulidStr()))
	inDesign := baseInput(f, ulidStr())
	inDesign.Capability = "design"
	d := mustAllow(t, s, inDesign)
	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: d.ReservationID, JobID: inDesign.JobID, ActualAmount: 1, Outcome: OutcomeSuccess,
	}); err != nil {
		t.Fatal(err)
	}

	results, err := s.Reconcile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}
	for _, r := range results {
		if !almostEqual(r.Drift, 0) {
			t.Fatalf("capability %s drift = %v, want 0", r.Capability, r.Drift)
		}
	}
}

// 找不到的 job_id：明确错误，不静默。
func TestSettleUnknownJob(t *testing.T) {
	resetTables(t)
	s := newService()
	if err := s.Settle(context.Background(), SettleInput{
		ReservationID: ulidStr(), JobID: ulidStr(), ActualAmount: 1, Outcome: OutcomeSuccess,
	}); !errors.Is(err, ErrJobNotFound) {
		t.Fatalf("want ErrJobNotFound, got %v", err)
	}
}
