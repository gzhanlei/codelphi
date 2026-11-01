const errors: Record<string, string> = {
  invalid_oauth_state: "登录状态已失效，请重新发起登录。",
  token_exchange_failed: "Chandler 凭证交换失败，请重试。",
  userinfo_failed: "无法读取 Chandler 用户信息，请重试。",
};

export function loginErrorMessage(error?: string) {
  if (!error) return "";
  const message = errors[error];
  return message === undefined ? "登录失败，请重试。" : message;
}

export function LoginError({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="error-banner" role="alert">{loginErrorMessage(error)}</div>;
}
