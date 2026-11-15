ALTER TABLE feedback_reports
  ADD COLUMN regression_stable_key VARCHAR(191) NULL,
  ADD KEY feedback_reports_org_regression_idx (organization_id, regression_stable_key);
