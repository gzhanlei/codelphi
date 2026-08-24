import Link from "next/link";

export function Shell({
  children,
  orgName,
}: {
  children: React.ReactNode;
  orgName?: string;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[880px] items-baseline justify-between px-6 py-5">
          <Link href="/" className="font-serif text-xl tracking-tight">
            CoDelphi
            <span className="ml-2 text-sm font-sans font-normal text-muted">套件工作台</span>
          </Link>
          <div className="flex items-baseline gap-4">
            {orgName ? <span className="text-sm text-muted">{orgName}</span> : null}
            <a href="/auth/logout" className="text-sm underline decoration-line underline-offset-4 hover:text-seal">
              退出登录
            </a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[880px] px-6 py-10">{children}</main>
    </div>
  );
}

export function Banner({ code, message, hint }: { code: string; message: string; hint?: string }) {
  return (
    <div className="border border-seal/30 bg-[#f8ece8] px-4 py-3 text-sm text-seal-dark">
      <div className="font-medium">{message || code}</div>
      <div className="mt-1 text-muted">{hint || "联系本机构管理员"}</div>
    </div>
  );
}

export function Button({
  children,
  href,
  onClick,
  type = "button",
  disabled,
  variant = "seal",
}: {
  children: React.ReactNode;
  href?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  variant?: "seal" | "ghost";
}) {
  const cls =
    variant === "seal"
      ? "inline-flex items-center bg-seal px-4 py-2 text-sm text-paper hover:bg-seal-dark disabled:opacity-40"
      : "inline-flex items-center border border-line px-4 py-2 text-sm text-ink hover:bg-line/40 disabled:opacity-40";
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
