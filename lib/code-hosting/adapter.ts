import type { RemoteSourceBackend } from "../remote-source-index/types";
import type { ChangeContext, CodeHostingProvider, RepositoryAccess, RepositoryPage, RepositoryRef } from "./types";

export interface CodeHostingAdapter {
  readonly provider: CodeHostingProvider;
  parseRepository(fullName: string): RepositoryRef;
  getRepository(repository: RepositoryRef, access: RepositoryAccess): Promise<RepositoryRef>;
  getBranchHead(repository: RepositoryRef, access: RepositoryAccess): Promise<string>;
  listRepositories(access: RepositoryAccess, page: number): Promise<RepositoryPage>;
  getChangeContext(repository: RepositoryRef, before: string | null, after: string, access: RepositoryAccess): Promise<ChangeContext>;
  createSourceBackend(access: RepositoryAccess): RemoteSourceBackend;
  repositoryUrl(repository: Pick<RepositoryRef, "owner" | "name">): string;
  explainRegistrationError?(error: unknown, access: RepositoryAccess): Error | null;
}
