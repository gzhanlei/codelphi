CREATE TABLE IF NOT EXISTS repository_connections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(16) NOT NULL,
  identity_hash CHAR(64) NOT NULL,
  display_name VARCHAR(191) NOT NULL,
  account_login VARCHAR(191) NOT NULL,
  base_url VARCHAR(1024) NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_hint VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  last_error VARCHAR(512) NULL,
  last_checked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY repository_connections_org_identity_unique (organization_id, identity_hash),
  KEY repository_connections_org_status_idx (organization_id, status),
  CONSTRAINT repository_connections_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
