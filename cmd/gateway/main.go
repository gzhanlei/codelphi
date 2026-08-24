// gateway 是 codelphi B2B 平台唯一对外服务：
// 套件工作台/运营后台 HTTP API + 唯一 MCP 工具面 + billing/execution 同进程分模块。
// 设计依据：DESIGN-b2b-capability-platform.md §2。
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"codelphi/internal/config"
	"codelphi/internal/storage"
)

func main() {
	cfg := config.Load()

	var db *sql.DB
	if cfg.MySQLDSN != "" {
		var err error
		db, err = sql.Open("mysql", cfg.MySQLDSN)
		if err != nil {
			log.Fatalf("open mysql: %v", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			log.Fatalf("ping mysql: %v", err)
		}
		log.Printf("mysql connected")
	} else {
		log.Printf("MYSQL_DSN empty: running without database (M0 bootstrap only)")
	}

	store := storage.NewLocal(cfg.StorageDir, cfg.MediaSigningKey)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz(db))
	mux.Handle("GET /media/", mediaHandler(store))
	mux.HandleFunc("GET /auth/callback", authCallbackStub)

	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: mux}

	go func() {
		log.Printf("gateway listening on %s", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func healthz(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		dbStatus := "unconfigured"
		if db != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if err := db.PingContext(ctx); err != nil {
				status = "degraded"
				dbStatus = "error"
				w.WriteHeader(http.StatusServiceUnavailable)
			} else {
				dbStatus = "ok"
			}
		}
		writeJSON(w, map[string]string{"status": status, "db": dbStatus})
	}
}

// mediaHandler 校验签名后回源 local 驱动的对象；换 COS 驱动后此端点可退役。
func mediaHandler(store *storage.Local) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/media/")
		exp, _ := strconv.ParseInt(r.URL.Query().Get("exp"), 10, 64)
		sig := r.URL.Query().Get("sig")
		if exp == 0 || sig == "" || !store.VerifyLocalSignature(key, exp, sig) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		rc, err := store.Open(r.Context(), key)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer rc.Close()
		w.Header().Set("Cache-Control", "private, no-store")
		_, _ = io.Copy(w, rc)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// authCallbackStub 是 chandler OIDC 回调的占位端点。
// 存在理由：注册 codelphi 应用时 chandler 要求回调地址可达；M5 工作台上线后
// 由工作台的路由替换本实现（届时网关不再服务该路径，或 nginx 按路径分流）。
// 注意：授权码只确认存在与否，不落日志、不回显（code 是一次性凭证）。
func authCallbackStub(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	switch {
	case q.Get("error") != "":
		writeJSON(w, map[string]any{
			"status": "error", "error": q.Get("error"),
			"error_description": q.Get("error_description"),
		})
	case q.Get("code") != "":
		writeJSON(w, map[string]any{
			"status": "ok", "code_received": true, "state_received": q.Get("state") != "",
			"message": "codelphi auth callback placeholder; workbench 未上线",
		})
	default:
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]string{"status": "bad_request", "message": "missing code or error"})
	}
}
