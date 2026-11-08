-- sweep 作业状态（M1-T6）：上次成功执行时间落库（重启补跑观测 + M4-T5 每日对账复核「过期未释放 = 0」）。
CREATE TABLE IF NOT EXISTS billing_sweep_state (
  job_name VARCHAR(64) NOT NULL PRIMARY KEY,
  last_success_at DATETIME(3) NULL,
  last_error VARCHAR(500) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
