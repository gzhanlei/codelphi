package billing

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// 测试连真实本地 MySQL（codelphi_test 库）——并发条件更新语义只有在真库上才算数（PLAN §9）。
// TestMain 负责建库 + goose 迁移；每个测试前 resetTables 清表。
var testDB *sql.DB

func TestMain(m *testing.M) {
	admin, err := sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open admin dsn:", err)
		os.Exit(1)
	}
	if _, err := admin.Exec("CREATE DATABASE IF NOT EXISTS codelphi_test"); err != nil {
		fmt.Fprintln(os.Stderr, "create database:", err)
		os.Exit(1)
	}
	admin.Close()

	gooseBin, err := exec.LookPath("goose")
	if err != nil {
		gooseBin = "/Users/leihan/go/bin/goose"
	}
	migrations, err := filepath.Abs("../../db/migrations")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cmd := exec.Command(gooseBin, "-dir", migrations, "mysql",
		"root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test", "up")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "goose up: %v\n%s\n", err, out)
		os.Exit(1)
	}

	testDB, err = sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test?parseTime=true&loc=Local")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open test dsn:", err)
		os.Exit(1)
	}
	testDB.SetMaxOpenConns(32)
	os.Exit(m.Run())
}

// resetTables 清全表（外键顺序由 FOREIGN_KEY_CHECKS 兜底）。
func resetTables(t *testing.T) {
	t.Helper()
	if _, err := testDB.Exec("SET FOREIGN_KEY_CHECKS = 0"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{
		"audit_logs", "usage_records", "artifacts", "jobs", "course_packages",
		"materials", "course_lessons", "projects", "quota_pools", "licenses", "package_templates",
		"members", "org_units", "orgs",
	} {
		if _, err := testDB.Exec("TRUNCATE TABLE " + table); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := testDB.Exec("SET FOREIGN_KEY_CHECKS = 1"); err != nil {
		t.Fatal(err)
	}
}

// fixture 是一套现成的授权链：org + member + license + 根池。
type fixture struct {
	orgID      string
	memberID   string
	licenseID  string
	rootPoolID string
}

var (
	licenseFrom = time.Now().AddDate(0, 0, -1)
	licenseTo   = time.Now().AddDate(1, 0, 0)
	periodStart = time.Now().AddDate(0, 0, -1)
	periodEnd   = time.Now().AddDate(1, 0, 0)
)

// newFixture 建 org(active) + member(active) + license(active, 快照含 capability) + 根池(total)。
func newFixture(t *testing.T, capability string, rootTotal float64) fixture {
	t.Helper()
	f := fixture{
		orgID:     ulidStr(),
		memberID:  ulidStr(),
		licenseID: ulidStr(),
	}
	execSQL(t, `INSERT INTO orgs (id, name, status) VALUES (?, ?, 'active')`, f.orgID, "测试机构")
	execSQL(t, `INSERT INTO members (id, org_id, chandler_sub, role, status) VALUES (?, ?, ?, 'member', 'active')`,
		f.memberID, f.orgID, "sub-"+f.memberID)
	insertLicense(t, f.orgID, f.licenseID, licenseFrom, licenseTo, capability)
	f.rootPoolID = insertPool(t, "org", f.orgID, f.licenseID, capability, rootTotal)
	return f
}

func insertLicense(t *testing.T, orgID, licenseID string, from, to time.Time, capability string) {
	t.Helper()
	snapshot := fmt.Sprintf(`[{"capability":%q,"quota":1000,"unit":"count"}]`, capability)
	execSQL(t, `INSERT INTO licenses (id, org_id, contract_no, valid_from, valid_to, status, snapshot)
		VALUES (?, ?, ?, ?, ?, 'active', ?)`,
		licenseID, orgID, "C-"+licenseID, from, to, snapshot)
}

// insertPool 建当前周期的计数器行，返回 pool id。
func insertPool(t *testing.T, nodeType, nodeID, licenseID, capability string, total float64) string {
	t.Helper()
	id := ulidStr()
	execSQL(t, `INSERT INTO quota_pools (id, node_type, node_id, license_id, capability, unit, total, used, period_start, period_end)
		VALUES (?, ?, ?, ?, ?, 'count', ?, 0, ?, ?)`,
		id, nodeType, nodeID, licenseID, capability, total, periodStart, periodEnd)
	return id
}

func execSQL(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := testDB.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

// poolUsed 读计数器 used。
func poolUsed(t *testing.T, poolID string) float64 {
	t.Helper()
	var used float64
	if err := testDB.QueryRow("SELECT used FROM quota_pools WHERE id = ?", poolID).Scan(&used); err != nil {
		t.Fatal(err)
	}
	return used
}

// recordStatus 读台账行状态。
func recordStatus(t *testing.T, jobID string) string {
	t.Helper()
	var status string
	if err := testDB.QueryRow("SELECT status FROM usage_records WHERE job_id = ?", jobID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func almostEqual(a, b float64) bool {
	d := a - b
	return d > -1e-9 && d < 1e-9
}

func mustAllow(t *testing.T, s *Service, in AuthorizeInput) Decision {
	t.Helper()
	d, err := s.Authorize(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Allowed {
		t.Fatalf("want allow, got deny %s", d.Reason)
	}
	return d
}

func mustDeny(t *testing.T, s *Service, in AuthorizeInput, reason DenyReason) {
	t.Helper()
	d, err := s.Authorize(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if d.Allowed || d.Reason != reason {
		t.Fatalf("want deny %s, got %+v", reason, d)
	}
}

func baseInput(f fixture, jobID string) AuthorizeInput {
	return AuthorizeInput{
		OrgID: f.orgID, MemberID: f.memberID, ProjectID: ulidStr(),
		Capability: "ppt", EstimatedAmount: 1, JobID: jobID, Unit: UnitCount,
	}
}
