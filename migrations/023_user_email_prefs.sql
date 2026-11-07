-- M1 扩展：每用户邮件通知偏好 + 用户粒度的投递记录。
-- 邮件收件人 = 开启偏好的产品成员（users.email），发送走 Chandler /v1/mail/send；
-- 不需要在 notification_channels 里配邮箱，偏好即开关。
CREATE TABLE IF NOT EXISTS user_email_prefs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  email_enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY user_email_prefs_user_product_unique (user_id, product_id),
  CONSTRAINT user_email_prefs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT user_email_prefs_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 邮件投递按用户记录：channel_id 允许 NULL，user_id 参与唯一键去重。
ALTER TABLE notification_deliveries
  MODIFY channel_id BIGINT UNSIGNED NULL,
  ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER channel_id,
  ADD UNIQUE KEY notification_deliveries_run_user_unique (analysis_run_id, user_id),
  ADD CONSTRAINT notification_deliveries_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
