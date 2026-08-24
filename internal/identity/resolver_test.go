package identity

import (
	"context"
	"errors"
	"testing"
)

func newResolver() *Resolver { return NewResolver(testDB) }

// 唯一 active 归属：未带 X-Org-Id 默认并回显实际 org（设计 §5）。
func TestResolveSingleMembershipDefault(t *testing.T) {
	resetTables(t)
	orgID, memberID := ulidStr(), ulidStr()
	insertOrg(t, orgID, "active")
	insertMember(t, memberID, orgID, "sub-1", "active")

	c, err := newResolver().Resolve(context.Background(), "sub-1", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if c.OrgID != orgID || c.MemberID != memberID || c.UnitID != "" || c.Role != "member" {
		t.Fatalf("ctx = %+v", c)
	}
}

// 单 unit 归属：默认并回显实际 unit。
func TestResolveSingleUnitDefault(t *testing.T) {
	resetTables(t)
	orgID, memberID, unitID := ulidStr(), ulidStr(), ulidStr()
	insertOrg(t, orgID, "active")
	insertMember(t, memberID, orgID, "sub-1", "active")
	insertUnit(t, unitID, orgID)
	linkMemberUnit(t, memberID, unitID)

	c, err := newResolver().Resolve(context.Background(), "sub-1", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if c.UnitID != unitID {
		t.Fatalf("UnitID = %q, want %q（回显）", c.UnitID, unitID)
	}
}

// 多机构归属未带 X-Org-Id → org_unspecified。
func TestResolveOrgUnspecified(t *testing.T) {
	resetTables(t)
	orgA, orgB := ulidStr(), ulidStr()
	insertOrg(t, orgA, "active")
	insertOrg(t, orgB, "active")
	insertMember(t, ulidStr(), orgA, "sub-1", "active")
	insertMember(t, ulidStr(), orgB, "sub-1", "active")

	_, err := newResolver().Resolve(context.Background(), "sub-1", "", "")
	assertReason(t, err, ReasonOrgUnspecified)
}

// 带了 X-Org-Id 但不是该 sub 的 membership → org_mismatch。
func TestResolveOrgMismatch(t *testing.T) {
	resetTables(t)
	orgA, orgB := ulidStr(), ulidStr()
	insertOrg(t, orgA, "active")
	insertOrg(t, orgB, "active")
	insertMember(t, ulidStr(), orgA, "sub-1", "active")

	_, err := newResolver().Resolve(context.Background(), "sub-1", orgB, "")
	assertReason(t, err, ReasonOrgMismatch)
}

// 显式 X-Org-Id 命中：正常解析。
func TestResolveExplicitOrg(t *testing.T) {
	resetTables(t)
	orgA, orgB := ulidStr(), ulidStr()
	insertOrg(t, orgA, "active")
	insertOrg(t, orgB, "active")
	insertMember(t, ulidStr(), orgA, "sub-1", "active")
	memberB := ulidStr()
	insertMember(t, memberB, orgB, "sub-1", "active")

	c, err := newResolver().Resolve(context.Background(), "sub-1", orgB, "")
	if err != nil {
		t.Fatal(err)
	}
	if c.OrgID != orgB || c.MemberID != memberB {
		t.Fatalf("ctx = %+v", c)
	}
}

// disabled 成员 → member_disabled（显式与默认两条路径都要拦）。
func TestResolveMemberDisabled(t *testing.T) {
	resetTables(t)
	orgID, memberID := ulidStr(), ulidStr()
	insertOrg(t, orgID, "active")
	insertMember(t, memberID, orgID, "sub-1", "disabled")

	_, err := newResolver().Resolve(context.Background(), "sub-1", orgID, "")
	assertReason(t, err, ReasonMemberDisabled)

	// 默认路径下 disabled 不算 active 归属 → identity_unbound。
	_, err = newResolver().Resolve(context.Background(), "sub-1", "", "")
	assertReason(t, err, ReasonIdentityUnbound)
}

// X-Unit-Id 不属于该成员、或不属于该 org → unit_mismatch。
func TestResolveUnitMismatch(t *testing.T) {
	resetTables(t)
	orgA, orgB := ulidStr(), ulidStr()
	insertOrg(t, orgA, "active")
	insertOrg(t, orgB, "active")
	memberA := ulidStr()
	insertMember(t, memberA, orgA, "sub-1", "active")
	unitA, unitB := ulidStr(), ulidStr()
	insertUnit(t, unitA, orgA)
	insertUnit(t, unitB, orgB)

	r := newResolver()
	// unit 属于成员隔壁 org：不属于该 org → mismatch。
	_, err := r.Resolve(context.Background(), "sub-1", orgA, unitB)
	assertReason(t, err, ReasonUnitMismatch)
	// unit 属于本 org 但没挂到该成员：不属于该成员 → mismatch。
	_, err = r.Resolve(context.Background(), "sub-1", orgA, unitA)
	assertReason(t, err, ReasonUnitMismatch)
}

// 多 unit 归属未带 X-Unit-Id → unit_unspecified。
func TestResolveUnitUnspecified(t *testing.T) {
	resetTables(t)
	orgID, memberID := ulidStr(), ulidStr()
	insertOrg(t, orgID, "active")
	insertMember(t, memberID, orgID, "sub-1", "active")
	u1, u2 := ulidStr(), ulidStr()
	insertUnit(t, u1, orgID)
	insertUnit(t, u2, orgID)
	linkMemberUnit(t, memberID, u1)
	linkMemberUnit(t, memberID, u2)

	_, err := newResolver().Resolve(context.Background(), "sub-1", "", "")
	assertReason(t, err, ReasonUnitUnspecified)

	// 带了其中一个 → 通过。
	c, err := newResolver().Resolve(context.Background(), "sub-1", orgID, u2)
	if err != nil {
		t.Fatal(err)
	}
	if c.UnitID != u2 {
		t.Fatalf("UnitID = %q, want %q", c.UnitID, u2)
	}
}

// 无任何归属 → identity_unbound。
func TestResolveIdentityUnbound(t *testing.T) {
	resetTables(t)
	_, err := newResolver().Resolve(context.Background(), "sub-ghost", "", "")
	assertReason(t, err, ReasonIdentityUnbound)
}

// 缓存主动失效（设计 §5 硬要求）：resolve 命中缓存后，库里 disable +
// Invalidate，下一请求即 member_disabled，不等 TTL。
func TestResolveCacheInvalidate(t *testing.T) {
	resetTables(t)
	orgID, memberID := ulidStr(), ulidStr()
	insertOrg(t, orgID, "active")
	insertMember(t, memberID, orgID, "sub-1", "active")
	r := newResolver() // TTL 60s，远长于测试时长

	if _, err := r.Resolve(context.Background(), "sub-1", "", ""); err != nil {
		t.Fatal(err)
	}

	execSQL(t, "UPDATE members SET status = 'disabled' WHERE id = ?", memberID)

	// 未失效前：命中缓存仍放行（缓存语义如此，所以 disable 必须主动失效）。
	if _, err := r.Resolve(context.Background(), "sub-1", "", ""); err != nil {
		t.Fatalf("缓存命中期应放行: %v", err)
	}

	r.Invalidate("sub-1", orgID)
	_, err := r.Resolve(context.Background(), "sub-1", "", "")
	assertReason(t, err, ReasonIdentityUnbound) // 默认路径：disabled 不算 active

	// 显式路径也要即拦。
	_, err = r.Resolve(context.Background(), "sub-1", orgID, "")
	assertReason(t, err, ReasonMemberDisabled)
}

// org suspended 不在 identity 拦（那是 billing.Authorize 的事）。
func TestResolveOrgSuspendedNotBlockedHere(t *testing.T) {
	resetTables(t)
	orgID, memberID := ulidStr(), ulidStr()
	insertOrg(t, orgID, "suspended")
	insertMember(t, memberID, orgID, "sub-1", "active")

	c, err := newResolver().Resolve(context.Background(), "sub-1", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if c.OrgID != orgID {
		t.Fatalf("ctx = %+v", c)
	}
}

func assertReason(t *testing.T, err error, want string) {
	t.Helper()
	var re *ResolveError
	if !errors.As(err, &re) || re.Reason != want {
		t.Fatalf("want reason %s, got %v", want, err)
	}
}
