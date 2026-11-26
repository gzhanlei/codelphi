import { z } from "zod";
import type { PatchHunk } from "../spec-diff";

export const codeHostingProviderSchema = z.enum(["github", "gitee", "gitlab", "gitea"]);
export type CodeHostingProvider = z.infer<typeof codeHostingProviderSchema>;

export interface RepositoryRef {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface HostedRepository extends RepositoryRef {
  provider: CodeHostingProvider;
}

export interface RepositoryAccess {
  token?: string;
  connectionId?: number | null;
  organizationId?: number;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface RepositoryChoice {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface RepositoryPage {
  repositories: RepositoryChoice[];
  hasMore: boolean;
}

export interface ChangeFile {
  path: string;
  status: string;
  patch: string;
  /** 调用方已经解析好的行号区间。客户端提案不带补丁文本，区间由客户端算好交上来；托管分析不填，从补丁解析。 */
  hunks?: readonly PatchHunk[];
}

export interface ChangeContext {
  message: string;
  committedAt: string;
  url: string;
  files: ChangeFile[];
  /** 调用方已经算好的「含行为变更的路径集合」。客户端提案不带补丁文本；托管分析不填，从补丁算。 */
  behavioralPaths?: ReadonlySet<string>;
}
