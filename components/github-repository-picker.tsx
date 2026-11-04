"use client";

import { useEffect, useRef, useState } from "react";
import type { RepositoryChoice } from "../lib/code-hosting/types";
import { errorMessage } from "../lib/error-message";
import {
  applyUnlessAborted,
  filterRepositories,
  initialRepositoryPage,
  loadInitialRepositories,
  runNextRepositories,
  repositoryChoices,
  selectRepository,
} from "../lib/repository-picker";
import { FormError } from "./form-feedback";

interface GitHubRepositoryPickerProps {
  connectionId: number | null;
  repository: string;
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
}

export function RepositoryFilter({ count, value, onChange }: { count: number; value: string; onChange: (value: string) => void }) {
  if (count <= 10) return null;
  return <label className="field filter-field"><span>筛选仓库</span><input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder="输入 owner 或仓库名" /></label>;
}

export function RepositorySelect({ choices, count, repository, pending, onSelect }: { choices: RepositoryChoice[]; count: number; repository: string; pending: boolean; onSelect: (value: string) => void }) {
  const loading = pending && count === 0;
  return (
    <label className="field"><span>从 GitHub 选择</span><select value={repository} disabled={loading} onChange={(event) => onSelect(event.target.value)}>
      <option value="">{loading ? "正在读取 GitHub 仓库…" : "请选择仓库（也可下方手动输入）"}</option>
      {choices.map((item) => <option value={item.fullName} key={item.fullName}>{item.fullName}{item.private ? " · 私有" : ""}</option>)}
    </select><small>只列出当前 GitHub App 安装可访问的仓库；也可在下方手动输入。已加载 {count} 个。</small></label>
  );
}

export function RepositoryLoadMore({ hasMore, page, pending, onLoad }: { hasMore: boolean; page: number; pending: boolean; onLoad: () => void }) {
  if (hasMore && page < 5) return <button className="text-button repository-load-more" type="button" disabled={pending} onClick={onLoad}>{pending ? "读取中…" : "加载更多仓库"}</button>;
  if (hasMore) return <small>已显示前 500 个仓库，其余请手动输入。</small>;
  return null;
}

export function GitHubRepositoryPicker({ connectionId, repository, onRepositoryChange, onBranchChange }: GitHubRepositoryPickerProps) {
  const [repositories, setRepositories] = useState<RepositoryChoice[]>([]);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(initialRepositoryPage);
  const [hasMore, setHasMore] = useState(false);
  const [pending, setPending] = useState(Boolean(connectionId));
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setRepositories([]);
    setFilter("");
    setPage(1);
    setHasMore(false);
    setError("");
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    loadInitialRepositories(connectionId, controller.signal)
      .then((result) => applyUnlessAborted(controller.signal, () => {
        setRepositories(result.repositories);
        setHasMore(result.hasMore);
      }))
      .catch((cause: unknown) => applyUnlessAborted(controller.signal, () => setError(errorMessage(cause, "仓库列表读取失败"))))
      .finally(() => applyUnlessAborted(controller.signal, () => setPending(false)));
    return () => controller.abort();
  }, [connectionId]);

  async function loadMore() {
    await runNextRepositories({ connectionId, page, pending, signal: requestRef.current!.signal }, repositories, {
      setPending,
      setError,
      apply: (nextRepositories, nextPage, nextHasMore) => {
        setRepositories(nextRepositories);
        setPage(nextPage);
        setHasMore(nextHasMore);
      },
    });
  }

  if (!connectionId) return null;
  const filtered = filterRepositories(repositories, filter);
  const choices = repositoryChoices(filtered, repository);
  const select = (value: string) => selectRepository(repositories, value, onRepositoryChange, onBranchChange);

  return (
    <div className="repository-picker" aria-busy={pending}>
      <div className="repository-picker-tools">
        <RepositoryFilter count={repositories.length} value={filter} onChange={setFilter} />
        <RepositorySelect choices={choices} count={repositories.length} repository={repository} pending={pending} onSelect={select} />
      </div>
      <FormError message={error} />
      <RepositoryLoadMore hasMore={hasMore} page={page} pending={pending} onLoad={loadMore} />
    </div>
  );
}
