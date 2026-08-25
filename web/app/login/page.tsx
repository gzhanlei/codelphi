export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="mx-auto flex min-h-screen max-w-[480px] flex-col justify-center px-6">
      <p className="font-serif text-3xl tracking-tight">CoDelphi</p>
      <p className="mt-3 text-muted">把材料做成可交付的套件。当前试点是数字课。</p>
      {error ? (
        <p className="mt-6 border border-seal/30 bg-[#f8ece8] px-3 py-2 text-sm text-seal-dark">
          登录失败：{error}
        </p>
      ) : null}
      <div className="mt-10 flex flex-col gap-3">
        <a
          href="/auth/start"
          className="inline-flex items-center bg-seal px-4 py-2 text-sm text-paper hover:bg-seal-dark"
        >
          用 Chandler 登录
        </a>
        {process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production" ? (
          <a href="/auth/dev" className="text-sm text-muted hover:underline">
            本地联调（跳过 Chandler）
          </a>
        ) : null}
      </div>
      <p className="mt-8 text-xs leading-relaxed text-muted">
        首次使用请走机构邀请邮件。一人多机构时，登录后选择身份。
      </p>
    </div>
  );
}
