# Prompt-injection quarantine operations

`security_quarantine.raw_payload` is currently stored as **unencrypted plaintext** for restricted incident audit only. It is excluded from FTS, replay, prompt construction, compaction, and dreaming, but that separation is not encryption.

- The low-level store API is not an authorization boundary and does not persist a raw-access audit event. The service boundary must add both controls before exposing it to an operator or network caller.
- Default low-level reads return metadata and hashes only. They must not return `raw_payload`.
- Raw reads require an opaque quarantine ID, `includeRaw: true`, and a non-empty incident/audit reason, but these parameters alone are not authentication or a durable audit log. Treat every returned raw value as audit-only sensitive data; never copy it into an agent message, prompt, memory, or search index.
- Raw payload persistence is capped at 64 KiB of valid UTF-8. The full-input SHA-256 and byte length are retained, and `truncated` records truncation. Flags, source, and audit metadata are bounded separately.
- Database backups and filesystem permissions must be treated as containing plaintext sensitive data.
- Before production handling of secrets, add KMS-backed envelope encryption, migrate existing plaintext rows to ciphertext, verify backup/restore behavior, and record raw-access audit events at the service boundary.

Until that migration is complete, documentation and dashboards must not label quarantine storage as encrypted.
