export interface Evidence {
  path: string;
  startLine?: number;
  endLine?: number;
  url?: string;
  note?: string;
}

export interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface ProductRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export interface RepositoryRecord {
  id: string;
  productId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}
