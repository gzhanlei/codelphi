-- 流程图空态原因：护栏拒绝生成时落库失败码，供流程图 tab 空态解释「为什么没有图」
ALTER TABLE spec_feature_flows
  MODIFY graph_json JSON NULL,
  ADD COLUMN last_error_code VARCHAR(64) NULL AFTER scenario_fingerprint,
  ADD COLUMN last_error_at DATETIME(3) NULL AFTER last_error_code;
