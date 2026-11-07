-- M4 管线加固：消除 queueAnalysis 的同 sha check-then-insert 竞态。
-- 活跃（queued/running）run 通过生成列参与唯一索引；终态 run 的槽位为 NULL，不阻挡重新排队。
-- 先收敛历史遗留的重复活跃 run（只保留最新一条，其余标记失败），再上唯一约束。
UPDATE analysis_runs r
LEFT JOIN analysis_runs newer
  ON newer.repository_id = r.repository_id
 AND newer.after_sha = r.after_sha
 AND newer.id > r.id
 AND newer.status IN ('queued', 'running')
SET r.status = 'failed',
    r.error_message = 'duplicate active run collapsed by M4 dedup migration'
WHERE r.status IN ('queued', 'running')
  AND newer.id IS NOT NULL;

ALTER TABLE analysis_runs
  ADD COLUMN active_slot TINYINT GENERATED ALWAYS AS (IF(status IN ('queued', 'running'), 1, NULL)) STORED,
  ADD UNIQUE KEY analysis_runs_active_unique (repository_id, after_sha, active_slot);
