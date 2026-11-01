ALTER TABLE features ADD COLUMN parent_id BIGINT UNSIGNED NULL;
ALTER TABLE features ADD KEY features_parent_idx (parent_id);
ALTER TABLE features ADD CONSTRAINT features_parent_fk FOREIGN KEY (parent_id) REFERENCES features(id) ON DELETE SET NULL;
