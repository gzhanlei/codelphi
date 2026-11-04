import { z } from "zod";

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
}

export interface ChangeContext {
  message: string;
  committedAt: string;
  url: string;
  files: ChangeFile[];
}
