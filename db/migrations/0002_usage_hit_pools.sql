-- +goose Up
-- M1：usage_records 记录本次预扣命中的 quota_pools.id 列表（JSON 数组）。
-- settle / 失败退款 / TTL 扫尾都靠它找到要调平的层；行上没有这层信息就无法回滚预扣。

ALTER TABLE usage_records
  ADD COLUMN hit_pools JSON NULL COMMENT '本预扣命中的 quota_pools.id 列表，供 settle/sweep 调平';

-- +goose Down
ALTER TABLE usage_records DROP COLUMN hit_pools;
