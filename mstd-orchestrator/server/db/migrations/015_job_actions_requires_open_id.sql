-- 会议 action 落库后仍保留“低置信负责人必须人工确认”的语义。
ALTER TABLE job_actions ADD COLUMN requires_open_id INTEGER NOT NULL DEFAULT 0;
