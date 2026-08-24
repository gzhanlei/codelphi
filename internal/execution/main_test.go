package execution

import (
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"github.com/oklog/ulid/v2"

	"codelphi/internal/storage"
)

// 测试连真实本地 MySQL（每包独立库 codelphi_test_execution，go test 并行互不踩表），
// adapter 用 httptest 假 server。TestMain 建库 + goose 迁移，每测试前清表。
var testDB *sql.DB

func TestMain(m *testing.M) {
	admin, err := sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open admin dsn:", err)
		os.Exit(1)
	}
	if _, err := admin.Exec("CREATE DATABASE IF NOT EXISTS codelphi_test_execution"); err != nil {
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
		"root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test_execution", "up")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "goose up: %v\n%s\n", err, out)
		os.Exit(1)
	}

	testDB, err = sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test_execution?parseTime=true&loc=Local")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open test dsn:", err)
		os.Exit(1)
	}
	testDB.SetMaxOpenConns(32)
	os.Exit(m.Run())
}

func resetTables(t *testing.T) {
	t.Helper()
	if _, err := testDB.Exec("SET FOREIGN_KEY_CHECKS = 0"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{
		"audit_logs", "usage_records", "member_units", "artifacts", "jobs", "course_packages",
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

func ulidStr() string { return ulid.Make().String() }

func execSQL(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := testDB.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

var (
	licenseFrom = time.Now().AddDate(0, 0, -1)
	licenseTo   = time.Now().AddDate(1, 0, 0)
	periodStart = time.Now().AddDate(0, 0, -1)
	periodEnd   = time.Now().AddDate(1, 0, 0)
)

// fixture 是一套现成的计费链 + 项目 + text 材料：
// org/member/project + license（快照含 design/outline/ppt）+ 三个根池 + 两份 text 材料（已落 storage）。
type fixture struct {
	orgID          string
	memberID       string
	projectID      string
	courseLessonID string
	pptPool        string
	designPool     string
	outlinePool    string
	store          *storage.Local
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	resetTables(t)
	f := fixture{
		orgID:     ulidStr(),
		memberID:  ulidStr(),
		projectID: ulidStr(),
		store:     storage.NewLocal(t.TempDir(), "test-key"),
	}
	execSQL(t, "INSERT INTO orgs (id, name, status) VALUES (?, ?, 'active')", f.orgID, "测试机构")
	execSQL(t, "INSERT INTO members (id, org_id, chandler_sub, role, status) VALUES (?, ?, ?, 'member', 'active')",
		f.memberID, f.orgID, "sub-"+f.memberID)
	licenseID := ulidStr()
	snapshot := `[{"capability":"design","quota":1000000,"unit":"count"},` +
		`{"capability":"outline","quota":1000000,"unit":"count"},` +
		`{"capability":"ppt","quota":100,"unit":"count"}]`
	execSQL(t, `INSERT INTO licenses (id, org_id, contract_no, valid_from, valid_to, status, snapshot)
		VALUES (?, ?, ?, ?, ?, 'active', ?)`, licenseID, f.orgID, "C-"+licenseID, licenseFrom, licenseTo, snapshot)
	f.designPool = insertPool(t, f.orgID, licenseID, "design", 1000000)
	f.outlinePool = insertPool(t, f.orgID, licenseID, "outline", 1000000)
	f.pptPool = insertPool(t, f.orgID, licenseID, "ppt", 100)
	execSQL(t, "INSERT INTO projects (id, org_id, owner_member_id, title) VALUES (?, ?, ?, ?)",
		f.projectID, f.orgID, f.memberID, "高等数学")
	f.courseLessonID = ulidStr()
	execSQL(t, "INSERT INTO course_lessons (id, project_id, title) VALUES (?, ?, ?)",
		f.courseLessonID, f.projectID, "第 3 章 导数")

	for i, text := range []string{"导数的定义：差商的极限……", "几何意义：切线斜率……"} {
		key := fmt.Sprintf("org/%s/material/%d.txt", f.orgID, i)
		if err := f.store.Put(t.Context(), key, stringReader(text), "text/plain"); err != nil {
			t.Fatal(err)
		}
		execSQL(t, "INSERT INTO materials (id, project_id, lesson_id, kind, filename, storage_ref, uploaded_by) VALUES (?, ?, ?, 'text', ?, ?, ?)",
			ulidStr(), f.projectID, f.courseLessonID, fmt.Sprintf("%d.txt", i), key, f.memberID)
	}
	return f
}

func insertPool(t *testing.T, orgID, licenseID, capability string, total float64) string {
	t.Helper()
	id := ulidStr()
	execSQL(t, `INSERT INTO quota_pools (id, node_type, node_id, license_id, capability, unit, total, used, period_start, period_end)
		VALUES (?, 'org', ?, ?, ?, 'count', ?, 0, ?, ?)`,
		id, orgID, licenseID, capability, total, periodStart, periodEnd)
	return id
}

func poolUsed(t *testing.T, poolID string) float64 {
	t.Helper()
	var used float64
	if err := testDB.QueryRow("SELECT used FROM quota_pools WHERE id = ?", poolID).Scan(&used); err != nil {
		t.Fatal(err)
	}
	return used
}

func countUsageRecords(t *testing.T, where string, args ...any) int {
	t.Helper()
	var n int
	if err := testDB.QueryRow("SELECT COUNT(*) FROM usage_records WHERE "+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func jobStatus(t *testing.T, jobID string) string {
	t.Helper()
	var status string
	if err := testDB.QueryRow("SELECT status FROM jobs WHERE id = ?", jobID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func packageStatus(t *testing.T, packageID string) string {
	t.Helper()
	var status string
	if err := testDB.QueryRow("SELECT status FROM course_packages WHERE id = ?", packageID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func stringReader(s string) *strings.Reader { return strings.NewReader(s) }
