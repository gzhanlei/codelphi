"use client";

import { useState } from "react";
import { submitProductFeedback } from "../lib/feedback-client";

export function analysisFeedbackLabel(pending: boolean, message: string) {
  if (pending) return "提交中…";
  if (message) return "已提交反馈";
  return "提交反馈";
}

interface AnalysisFeedbackControls {
  setPending: (pending: boolean) => void;
  setMessage: (message: string) => void;
}

export async function handleAnalysisFeedback(slug: string, controls: AnalysisFeedbackControls) {
  controls.setPending(true);
  controls.setMessage("");
  try {
    await submitProductFeedback(slug);
    controls.setMessage("反馈已提交，Radar 团队会查看诊断信息。");
  } catch (error) {
    controls.setMessage(error instanceof Error ? error.message : "反馈提交失败");
  } finally {
    controls.setPending(false);
  }
}

export function AnalysisFeedbackButton({ slug }: { slug: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const submit = () => handleAnalysisFeedback(slug, { setPending, setMessage });
  return <span className="analysis-feedback"><button className="secondary-button" type="button" onClick={submit} disabled={pending || Boolean(message)}>{analysisFeedbackLabel(pending, message)}</button>{message ? <small>{message}</small> : null}</span>;
}
