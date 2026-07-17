-- 007_observed.sql：旁听消息消费标记（群@ pending 窗口注入一次后不重复）
ALTER TABLE agent_messages ADD COLUMN observed_consumed INTEGER NOT NULL DEFAULT 0;
