-- 013_inbox_raw.sql：C2 入站规范化——inbox_events 落规范化前的原文，供审计与复核。
ALTER TABLE inbox_events ADD COLUMN raw_content TEXT;
