async function postFeedbackJson(url: string, fallback: string, fetcher: typeof fetch) {
  const response = await fetcher(url, { method: "POST" });
  const data = await response.json() as { error?: string; id?: number; issueUrl?: string };
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

export async function submitProductFeedback(slug: string, fetcher: typeof fetch = fetch) {
  return postFeedbackJson(`/api/products/${slug}/feedback`, "反馈提交失败", fetcher);
}

export async function submitGithubIssue(id: number, fetcher: typeof fetch = fetch) {
  const data = await postFeedbackJson(`/api/admin/feedback/${id}/github`, "GitHub Issue 创建失败", fetcher);
  if (!data.issueUrl) throw new Error("GitHub Issue 创建失败");
  return data.issueUrl;
}
