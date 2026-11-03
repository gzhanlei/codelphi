"use client";

import { useState } from "react";
import { submitGithubIssue } from "../lib/feedback-client";

export function issueActionLabel(pending: boolean, status: string) {
  if (pending) return "提交中…";
  if (status === "failed") return "重试提交";
  return "提交到 GitHub";
}

interface IssueControls {
  setPending: (pending: boolean) => void;
  setError: (message: string) => void;
  setIssueUrl: (url: string) => void;
  setStatus: (status: string) => void;
}

export async function handleGithubIssue(id: number, controls: IssueControls) {
  controls.setPending(true);
  controls.setError("");
  try {
    const url = await submitGithubIssue(id);
    controls.setIssueUrl(url);
    controls.setStatus("submitted");
  } catch (error) {
    controls.setError(error instanceof Error ? error.message : "GitHub Issue 创建失败");
    controls.setStatus("failed");
  } finally {
    controls.setPending(false);
  }
}

export function FeedbackIssueButton({ id, issueUrl: initialIssueUrl, status: initialStatus }: { id: number; issueUrl: string | null; status: string }) {
  const [issueUrl, setIssueUrl] = useState(initialIssueUrl);
  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = () => handleGithubIssue(id, { setPending, setError, setIssueUrl, setStatus });

  if (issueUrl) return <a href={issueUrl} target="_blank" rel="noreferrer">查看 Issue ↗</a>;
  return <span><button className="secondary-button" type="button" onClick={submit} disabled={pending}>{issueActionLabel(pending, status)}</button>{error ? <small className="error-text">{error}</small> : null}</span>;
}
