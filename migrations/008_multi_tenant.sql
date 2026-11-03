CREATE TABLE IF NOT EXISTS organizations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(191) NOT NULL UNIQUE,
  name VARCHAR(191) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (organization_id, user_id),
  KEY organization_members_user_idx (user_id),
  CONSTRAINT organization_members_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT organization_members_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO organizations (id, slug, name) VALUES (1, 'default', 'Default Workspace')
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO organization_members (organization_id, user_id, role)
SELECT 1, id, 'owner' FROM users
ON DUPLICATE KEY UPDATE role = 'owner', updated_at = CURRENT_TIMESTAMP(3);

UPDATE products SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE products MODIFY organization_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE products DROP INDEX slug;
ALTER TABLE products ADD UNIQUE KEY products_organization_slug_unique (organization_id, slug);
ALTER TABLE products ADD CONSTRAINT products_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE github_connections ADD COLUMN organization_id BIGINT UNSIGNED NULL;
UPDATE github_connections SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE github_connections MODIFY organization_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE github_connections ADD CONSTRAINT github_connections_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id);
