package httpapi

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/oklog/ulid/v2"
)

var testDB *sql.DB

func TestMain(m *testing.M) {
	admin, err := sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open admin dsn:", err)
		os.Exit(1)
	}
	if _, err := admin.Exec("CREATE DATABASE IF NOT EXISTS codelphi_test_httpapi"); err != nil {
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
		"root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test_httpapi", "up")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "goose up: %v\n%s\n", err, out)
		os.Exit(1)
	}

	testDB, err = sql.Open("mysql", "root:yuntouyan333@tcp(127.0.0.1:3306)/codelphi_test_httpapi?parseTime=true&loc=Local")
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

const (
	testKid      = "test-key-1"
	testIssuer   = "workmembership"
	testClientID = "cm_aca9bb839faa4a4a96839b389f312636"
)

func signToken(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": kid, "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func validClaims(sub string) map[string]any {
	return map[string]any{
		"sub": sub,
		"iss": testIssuer,
		"aud": testClientID,
		"exp": time.Now().Add(time.Hour).Unix(),
	}
}

func jwksJSON(pub *rsa.PublicKey) []byte {
	doc := map[string]any{"keys": []map[string]any{{
		"kty": "RSA", "kid": testKid, "use": "sig", "alg": "RS256",
		"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}}}
	b, _ := json.Marshal(doc)
	return b
}
