// Package storage 是材料与产物的唯一交换格式（设计 §2.1、§15 C.4）：
// org 前缀的对象存储 + 短 TTL 签名 URL。
// 驱动：local（开发/M0）→ cos（生产，选型拍板后实现，见开发计划 §11）。
package storage

import (
	"context"
	"io"
	"time"
)

// Store 抽象对象存储。key 必须带 org 前缀（如 "org/<orgID>/material/<id>.pdf"），
// 生命周期策略（到期 90 天只读、之后按前缀删除）由存储侧配置。
type Store interface {
	// Put 写入对象，返回实际存储的 key。
	Put(ctx context.Context, key string, r io.Reader, contentType string) error
	// Open 读取对象（供本网关自己的 /media 端点转发 local 驱动内容）。
	Open(ctx context.Context, key string) (io.ReadCloser, error)
	// SignGet 签发短 TTL 的 GET URL。partner/教师拿到 URL 即可读，不再过鉴权。
	SignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
}
