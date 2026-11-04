ALTER TABLE repositories ADD COLUMN provider VARCHAR(16) NOT NULL DEFAULT 'github' AFTER product_id;
ALTER TABLE repositories DROP INDEX repositories_owner_name_unique;
ALTER TABLE repositories ADD UNIQUE KEY repositories_provider_owner_name_unique (provider, owner, name);
