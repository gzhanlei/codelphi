package config

import (
	"os"
	"strconv"
	"time"
)

// Config 来自进程环境；密钥只走环境/密钥管理，不进仓库（设计 §10）。
type Config struct {
	HTTPAddr        string
	MySQLDSN        string // 允许为空：空时 /healthz 报 db=unconfigured（M0 部署先用，接库前必须配上）
	StorageDriver   string // local | cos（cos 待 §11 选型拍板后实现）
	StorageDir      string // local 驱动的根目录
	MediaSigningKey string
	MediaURLTTL     time.Duration
	// 预扣 TTL（设计 §4 生产语义），到期 reserved → expired 自动退回。
	ReservationTTL time.Duration
	// Chandler 对接事实（设计 §5 第十一轮，单应用单 client）。
	ChandlerJWKSURL  string
	ChandlerIssuer   string // iss 按字符串比对，生产值 workmembership
	ChandlerClientID string // aud 必须等于它；生产值 cm_aca9bb839faa4a4a96839b389f312636
	// 成员解析短缓存 TTL；disable 走 Resolver.Invalidate 主动失效，不靠它。
	MemberCacheTTL time.Duration
	// design/outline LLM adapter（设计 §2.1：vendor 显式、可换，默认 DeepSeek）。
	DesignLLMBaseURL string
	DesignLLMModel   string
	DesignLLMAPIKey  string
	// token 单价（CNY/百万），默认 DeepSeek 公开价；execution.Config 默认值同源。
	DesignLLMPriceIn  float64
	DesignLLMPriceOut float64
	// PPTCreator partner adapter（契约 C1）。
	PPTCreatorBaseURL    string
	PPTCreatorPartnerKey string
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func Load() Config {
	ttl, err := time.ParseDuration(env("MEDIA_URL_TTL", "15m"))
	if err != nil {
		ttl = 15 * time.Minute
	}
	resTTL, err := time.ParseDuration(env("RESERVATION_TTL", "24h"))
	if err != nil {
		resTTL = 24 * time.Hour
	}
	memberTTL, err := time.ParseDuration(env("MEMBER_CACHE_TTL", "60s"))
	if err != nil {
		memberTTL = 60 * time.Second
	}
	return Config{
		HTTPAddr:             env("HTTP_ADDR", ":8080"),
		MySQLDSN:             os.Getenv("MYSQL_DSN"),
		StorageDriver:        env("STORAGE_DRIVER", "local"),
		StorageDir:           env("STORAGE_DIR", "./data/storage"),
		MediaSigningKey:      env("MEDIA_SIGNING_KEY", "dev-insecure-key-change-me"),
		MediaURLTTL:          ttl,
		ReservationTTL:       resTTL,
		ChandlerJWKSURL:      env("CHANDLER_JWKS_URL", "https://api.chandler.work/.well-known/jwks.json"),
		ChandlerIssuer:       env("CHANDLER_ISSUER", "workmembership"),
		ChandlerClientID:     env("CHANDLER_CLIENT_ID", ""),
		MemberCacheTTL:       memberTTL,
		DesignLLMBaseURL:     env("DESIGN_LLM_BASE_URL", "https://api.deepseek.com"),
		DesignLLMModel:       env("DESIGN_LLM_MODEL", "deepseek-chat"),
		DesignLLMAPIKey:      os.Getenv("DESIGN_LLM_API_KEY"),
		DesignLLMPriceIn:     envFloat("DESIGN_LLM_PRICE_PER_MTOK_INPUT", 2),
		DesignLLMPriceOut:    envFloat("DESIGN_LLM_PRICE_PER_MTOK_OUTPUT", 8),
		PPTCreatorBaseURL:    os.Getenv("PPTCREATOR_PARTNER_BASE_URL"),
		PPTCreatorPartnerKey: os.Getenv("PPTCREATOR_PARTNER_KEY"),
	}
}
