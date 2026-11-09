-- A2 Digest + Release notes（docs/specsight-gap-improvement-plan.md §4.3）：
-- release_notes：客户向宣布稿，人工 Publish 才发布（published_at NULL = 草稿）；
-- share_token 用于匿名只读公开页（Unpublish 后同 URL 下线）。
-- release_note_blocks：块级草稿，每块强制锚定一个 spec_changes.id（§9 R1 核心门禁），
-- 生成阶段做引用存在性校验，锚定缺失 / 越界证据路径的草稿不允许落库。
-- digests：内部周报，无变化的周不生成（沿用现有通知规则）。
-- voices：项目级语气定义，每项目最多 3 个（应用层约束）。
CREATE TABLE IF NOT EXISTS voices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(191) NOT NULL,
  audience VARCHAR(191) NOT NULL DEFAULT '',
  tone VARCHAR(191) NOT NULL DEFAULT '',
  structure TEXT NOT NULL DEFAULT (''),
  house_rules TEXT NOT NULL DEFAULT (''),
  language VARCHAR(32) NOT NULL DEFAULT 'zh',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY voices_product_idx (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS release_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  release_id BIGINT UNSIGNED NOT NULL,
  voice_id BIGINT UNSIGNED NULL,
  emphasis TEXT NOT NULL DEFAULT (''),
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  share_token CHAR(32) NULL,
  published_at DATETIME(3) NULL,
  unpublished_at DATETIME(3) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY release_notes_release_unique (release_id),
  UNIQUE KEY release_notes_share_token_unique (share_token),
  KEY release_notes_product_idx (product_id, status),
  CONSTRAINT release_notes_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT release_notes_release_fk FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
  CONSTRAINT release_notes_voice_fk FOREIGN KEY (voice_id) REFERENCES voices(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS release_note_blocks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_note_id BIGINT UNSIGNED NOT NULL,
  position INT UNSIGNED NOT NULL,
  spec_change_id BIGINT UNSIGNED NOT NULL,
  emphasis TEXT NOT NULL DEFAULT (''),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY release_note_blocks_note_position_unique (release_note_id, position),
  KEY release_note_blocks_change_idx (spec_change_id),
  CONSTRAINT release_note_blocks_note_fk FOREIGN KEY (release_note_id) REFERENCES release_notes(id) ON DELETE CASCADE,
  CONSTRAINT release_note_blocks_change_fk FOREIGN KEY (spec_change_id) REFERENCES spec_changes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS digests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  content_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY digests_product_period_unique (product_id, period_start),
  CONSTRAINT digests_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
