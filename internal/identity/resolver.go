package identity

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"codelphi/internal/dbgen"
)

// 解析失败的 reason 全集（设计 §5 模型可见错误面）。
const (
	ReasonIdentityUnbound = "identity_unbound" // 未绑定机构
	ReasonMemberDisabled  = "member_disabled"  // 账号被停用
	ReasonOrgMismatch     = "org_mismatch"     // X-Org-Id 不属于此 sub（疑似 IDOR）
	ReasonOrgUnspecified  = "org_unspecified"  // 多归属未指明
	ReasonUnitMismatch    = "unit_mismatch"    // X-Unit-Id 不属于此成员/此 org
	ReasonUnitUnspecified = "unit_unspecified" // 多归属未指明
)

// ResolveError 带 §5 reason 的 typed error，中间件据此映射状态码与响应体。
type ResolveError struct {
	Reason string
	Detail string
}

func (e *ResolveError) Error() string { return fmt.Sprintf("identity: %s: %s", e.Reason, e.Detail) }

func resolveErr(reason, detail string) *ResolveError {
	return &ResolveError{Reason: reason, Detail: detail}
}

// Context 是一次请求解析出的身份上下文。OrgID/UnitID 总是回显实际值
// （默认归属时也填，避免静默，设计 §5）。
type Context struct {
	MemberID    string
	OrgID       string
	UnitID      string // 可空：成员无 unit 归属
	Role        string
	ChandlerSub string
}

// Resolver 把 chandler sub 解析成成员/组织上下文（设计 §5）。
// 进程内短缓存（默认 60s）；成员 disable 必须调 Invalidate 主动失效，不靠 TTL。
type Resolver struct {
	db  *sql.DB
	ttl time.Duration

	mu      sync.Mutex
	entries map[string]cacheEntry
}

type cacheEntry struct {
	member dbgen.Member
	expiry time.Time
}

// ResolverOption 主要用于测试（覆盖缓存 TTL）。
type ResolverOption func(*Resolver)

func WithMemberCacheTTL(ttl time.Duration) ResolverOption {
	return func(r *Resolver) { r.ttl = ttl }
}

func NewResolver(db *sql.DB, opts ...ResolverOption) *Resolver {
	r := &Resolver{db: db, ttl: 60 * time.Second, entries: make(map[string]cacheEntry)}
	for _, o := range opts {
		o(r)
	}
	return r
}

// Resolve 按设计 §5 逐字执行归属规则：
//   - 未带 X-Org-Id：唯一 active 归属默认并回显；零个 → identity_unbound；多个 → org_unspecified
//   - 带了 X-Org-Id：必须是该 sub 的 active membership，否则 org_mismatch；disabled → member_disabled
//   - X-Unit-Id 同款：单归属默认回显；多归属未带 → unit_unspecified；
//     带了但不属于该成员或不属于该 org → unit_mismatch
//
// org status=suspended 不在此拦——拦新任务是 billing.Authorize 的事（宽限期不杀 in-flight）。
func (r *Resolver) Resolve(ctx context.Context, sub, xOrgID, xUnitID string) (*Context, error) {
	if sub == "" {
		return nil, resolveErr(ReasonIdentityUnbound, "empty sub")
	}
	member, err := r.resolveMembership(ctx, sub, xOrgID)
	if err != nil {
		return nil, err
	}

	units, err := dbgen.New(r.db).ListMemberUnits(ctx, member.ID)
	if err != nil {
		return nil, err
	}
	unitID, err := resolveUnit(member, units, xUnitID)
	if err != nil {
		return nil, err
	}

	return &Context{
		MemberID:    member.ID,
		OrgID:       member.OrgID,
		UnitID:      unitID,
		Role:        string(member.Role),
		ChandlerSub: sub,
	}, nil
}

// resolveMembership 解析成员归属 org（带缓存）。缓存键 member:{sub}:{org}，
// 默认归属路径用 member:{sub}: 键；两条键都被 Invalidate 覆盖。
func (r *Resolver) resolveMembership(ctx context.Context, sub, xOrgID string) (dbgen.Member, error) {
	key := "member:" + sub + ":" + xOrgID
	if m, ok := r.cached(key); ok {
		return checkMembership(m, xOrgID)
	}

	q := dbgen.New(r.db)
	if xOrgID != "" {
		m, err := q.GetMembershipBySubOrg(ctx, dbgen.GetMembershipBySubOrgParams{ChandlerSub: sub, OrgID: xOrgID})
		if errors.Is(err, sql.ErrNoRows) {
			return dbgen.Member{}, resolveErr(ReasonOrgMismatch, "x-org-id is not this sub's membership")
		}
		if err != nil {
			return dbgen.Member{}, err
		}
		r.store(key, m)
		return checkMembership(m, xOrgID)
	}

	members, err := q.ListMembershipsBySub(ctx, sub)
	if err != nil {
		return dbgen.Member{}, err
	}
	var active []dbgen.Member
	for _, m := range members {
		if m.Status == dbgen.MembersStatusActive {
			active = append(active, m)
		}
	}
	switch len(active) {
	case 0:
		return dbgen.Member{}, resolveErr(ReasonIdentityUnbound, "no active membership")
	case 1:
		r.store(key, active[0])
		return active[0], nil
	default:
		return dbgen.Member{}, resolveErr(ReasonOrgUnspecified, "multiple active memberships, x-org-id required")
	}
}

// checkMembership 命中缓存或查出后的统一状态检查。
func checkMembership(m dbgen.Member, xOrgID string) (dbgen.Member, error) {
	if m.Status == dbgen.MembersStatusDisabled {
		return dbgen.Member{}, resolveErr(ReasonMemberDisabled, "member disabled")
	}
	if m.Status != dbgen.MembersStatusActive {
		// invited 等未激活态按「不是 active membership」处理（设计 §5：否则 org_mismatch）。
		return dbgen.Member{}, resolveErr(ReasonOrgMismatch, "membership not active")
	}
	return m, nil
}

// resolveUnit 归属规则与 org 对称；成员无 unit 归属时 UnitID 为空（不是错误）。
func resolveUnit(member dbgen.Member, units []dbgen.OrgUnit, xUnitID string) (string, error) {
	if xUnitID != "" {
		for _, u := range units {
			if u.ID == xUnitID && u.OrgID == member.OrgID {
				return xUnitID, nil
			}
		}
		return "", resolveErr(ReasonUnitMismatch, "x-unit-id not member's unit in this org")
	}
	switch len(units) {
	case 0:
		return "", nil
	case 1:
		return units[0].ID, nil
	default:
		return "", resolveErr(ReasonUnitUnspecified, "multiple unit memberships, x-unit-id required")
	}
}

// Invalidate 主动失效缓存（成员 disable 时调用方必须调，设计 §5 硬要求）。
// 同时清默认归属键，否则单归属成员被 disable 后默认路径仍命中旧缓存。
func (r *Resolver) Invalidate(sub, orgID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, "member:"+sub+":"+orgID)
	delete(r.entries, "member:"+sub+":")
}

func (r *Resolver) cached(key string) (dbgen.Member, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[key]
	if !ok || time.Now().After(e.expiry) {
		return dbgen.Member{}, false
	}
	return e.member, true
}

func (r *Resolver) store(key string, m dbgen.Member) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[key] = cacheEntry{member: m, expiry: time.Now().Add(r.ttl)}
}
