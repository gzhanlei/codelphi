-- payment_orders 行级更新时间戳（M3-T4 sweep 退款推进的时间基准：
-- refund_submitted 停留超 5 分钟即由查单推进；任何状态变更都会刷新本列）。
ALTER TABLE payment_orders ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
