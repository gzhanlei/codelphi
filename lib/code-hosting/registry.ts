import type { CodeHostingAdapter } from "./adapter";
import { githubCodeHostingAdapter } from "./github-provider";
import { gitlabCodeHostingAdapter } from "./gitlab-provider";
import { codeHostingProviderSchema, type CodeHostingProvider } from "./types";

const adapters: Partial<Record<CodeHostingProvider, CodeHostingAdapter>> = {
  github: githubCodeHostingAdapter,
  gitlab: gitlabCodeHostingAdapter,
};

export function getCodeHostingAdapter(value: CodeHostingProvider | string = "github"): CodeHostingAdapter {
  const provider = codeHostingProviderSchema.parse(value);
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`代码平台 ${provider} 的分析适配尚未开放`);
  return adapter;
}
