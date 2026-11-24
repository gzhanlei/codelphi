ALTER TABLE spec_changes
  ADD COLUMN judgment VARCHAR(16) NULL,
  ADD COLUMN evidence_state VARCHAR(24) NULL,
  ADD COLUMN reason_codes JSON NULL;
