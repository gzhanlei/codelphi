ALTER TABLE products
  ADD COLUMN description_source VARCHAR(16) NOT NULL DEFAULT 'manual' AFTER description,
  ADD COLUMN description_evidence JSON NULL AFTER description_source;
