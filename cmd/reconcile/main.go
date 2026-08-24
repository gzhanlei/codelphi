// reconcile 是日对账小命令（设计 §4 记账纪律 / PLAN §3 B）：
// 对每对（license_id, period）根池核对 used == sum(usage_records settled) + 在途 reserved。
// 任何一对漂移 != 0 时退出码非零。对账跑不通不接第二个能力。
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"codelphi/internal/billing"
	"codelphi/internal/config"
)

func main() {
	cfg := config.Load()
	if cfg.MySQLDSN == "" {
		log.Fatal("MYSQL_DSN empty")
	}
	db, err := sql.Open("mysql", cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("open mysql: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	results, err := billing.New(db).Reconcile(ctx)
	if err != nil {
		log.Fatalf("reconcile: %v", err)
	}

	drifted := 0
	for _, r := range results {
		status := "OK"
		if r.Drift != 0 {
			status = "DRIFT"
			drifted++
		}
		fmt.Printf("%s license=%s capability=%s period=%s..%s used=%.3f settled=%.3f reserved=%.3f drift=%.3f\n",
			status, r.LicenseID, r.Capability,
			r.PeriodStart.Format("2006-01-02"), r.PeriodEnd.Format("2006-01-02"),
			r.Used, r.Settled, r.Reserved, r.Drift)
	}
	if drifted > 0 {
		fmt.Printf("reconcile: %d root pool(s) drifted\n", drifted)
		os.Exit(1)
	}
	fmt.Printf("reconcile: %d root pool(s) aligned\n", len(results))
}
