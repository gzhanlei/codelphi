CREATE TABLE IF NOT EXISTS github_apps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(191) NOT NULL UNIQUE,
  app_id BIGINT UNSIGNED NOT NULL,
  client_id VARCHAR(191) NOT NULL UNIQUE,
  client_secret_encrypted TEXT NOT NULL,
  pem_encrypted TEXT NOT NULL,
  webhook_secret_encrypted TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS github_connections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app_id BIGINT UNSIGNED NOT NULL,
  installation_id BIGINT UNSIGNED NOT NULL UNIQUE,
  account_login VARCHAR(191) NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY github_connections_app_status_idx (app_id, status),
  CONSTRAINT github_connections_app_fk FOREIGN KEY (app_id) REFERENCES github_apps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE repositories ADD COLUMN connection_id BIGINT UNSIGNED NULL;
ALTER TABLE repositories ADD KEY repositories_connection_idx (connection_id);
ALTER TABLE repositories ADD CONSTRAINT repositories_connection_fk FOREIGN KEY (connection_id) REFERENCES github_connections(id) ON DELETE SET NULL;
