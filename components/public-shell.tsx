import Link from "next/link";
import { Brand, ShellFrame } from "./shell-frame";

const PUBLIC_NAV_ITEMS = [
  { href: "/", icon: "⌁", label: "产品总览" },
  { href: "/pricing", icon: "◇", label: "套餐与定价" },
  { href: "/terms", icon: "§", label: "服务条款" },
  { href: "/data-notice", icon: "◌", label: "数据说明" },
];

/** 公开页外壳（未登录可见的页面复用 AppShell 布局）：侧栏品牌 + 公开导航 + 顶栏登录入口。 */
export function PublicShell({ activeHref, children }: { activeHref?: string; children: React.ReactNode }) {
  return (
    <ShellFrame
      sidebar={
        <>
          <Brand />
          <nav className="main-nav" aria-label="站点导航">
            {PUBLIC_NAV_ITEMS.map((item) => (
              <Link key={item.href} href={item.href} className={`nav-item${activeHref === item.href ? " active" : ""}`}><span>{item.icon}</span>{item.label}</Link>
            ))}
          </nav>
          <div className="sidebar-note">CODE → CONTEXT<br />让每一次发布都有据可查</div>
        </>
      }
      topbar={
        <>
          <span className="environment"><i />CoDelphi</span>
          <div className="user-menu">
            <Link href="/login" className="text-button">登录 / 注册</Link>
          </div>
        </>
      }
    >
      {children}
    </ShellFrame>
  );
}
