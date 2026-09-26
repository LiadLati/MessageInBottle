-- Policy v4: the map clock's history starts from what each account already has. An account a
-- device has spoken for keeps that zone, effective from the instant it was accepted; nothing
-- else is inferred. Accounts with no device zone get their harbour/UTC fallback from the
-- application the first time their weather is needed. No existing row is changed.
INSERT INTO `account_zone_changes` (`id`, `user_id`, `zone`, `source`, `effective_at`, `created_at`)
SELECT 'azc_backfill_' || `id`, `id`, `time_zone`, 'device', `time_zone_since`, `time_zone_since`
FROM `users`
WHERE `time_zone` IS NOT NULL AND `time_zone_since` IS NOT NULL;
