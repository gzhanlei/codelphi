package identity

import (
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	_ "github.com/go-sql-driver/mysql"

	"github.com/oklog/ulid/v2"
)

// 与 internal/billing 同一套约定：测试连真实本地 MySQL，TestMain 建库 + goose 迁移，
// 每个测试前 resetTables 清表。用独立的 codelphi_test_identity 库——
// go test 并行跑多个包，共享一个库会被对方清表打断。
var testDB *sql.DB

func TestMain(m *testing.M) {
	admin, err := sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open admin dsn:", err)
		os.Exit(1)
	}
	if _, err := admin.Exec("CREATE DATABASE IF NOT EXISTS codelphi_test_identity"); err != nil {
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
		"root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test_identity", "up")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "goose up: %v\n%s\n", err, out)
		os.Exit(1)
	}

	testDB, err = sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test_identity?parseTime=true&loc=Local")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open test dsn:", err)
		os.Exit(1)
	}
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

func insertOrg(t *testing.T, orgID, status string) {
	t.Helper()
	execSQL(t, "INSERT INTO orgs (id, name, status) VALUES (?, ?, ?)", orgID, "测试机构", status)
}

func insertMember(t *testing.T, memberID, orgID, sub, status string) {
	t.Helper()
	execSQL(t, "INSERT INTO members (id, org_id, chandler_sub, role, status) VALUES (?, ?, ?, 'member', ?)",
		memberID, orgID, sub, status)
}

func insertUnit(t *testing.T, unitID, orgID string) {
	t.Helper()
	execSQL(t, "INSERT INTO org_units (id, org_id, name) VALUES (?, ?, ?)", unitID, orgID, "教研室")
}

func linkMemberUnit(t *testing.T, memberID, unitID string) {
	t.Helper()
	execSQL(t, "INSERT INTO member_units (member_id, unit_id) VALUES (?, ?)", memberID, unitID)
}
