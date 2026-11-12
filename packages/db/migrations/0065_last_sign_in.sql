-- The last sign-in is kept on the account. It was read from the sessions,
-- which now go once they have expired, and from the sign-in trail, which
-- goes after its retention: neither should take the date with it.
ALTER TABLE users ADD COLUMN last_sign_in_at timestamptz;

UPDATE users u
SET last_sign_in_at = seen.at
FROM (
  SELECT user_id, max(at) AS at
  FROM (
    SELECT user_id, created_at AS at FROM sessions
    UNION ALL
    SELECT user_id, occurred_at AS at
    FROM auth_events
    WHERE action = 'login_success' AND user_id IS NOT NULL
  ) signs
  GROUP BY user_id
) seen
WHERE seen.user_id = u.id;
