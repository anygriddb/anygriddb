# Heartbeats

A heartbeat tells a monitor that a scheduled job ran. It is a channel
of its own under Administration, Connections, Notifications. Choose the
schedules it watches: the hourly purge, the change-trail purge, the
trash purge, the file sweep, a backup report, or a scheduled
automation.

The address is HTTPS. A private address is allowed only when private
networks are turned on, on that same page. A failure to ping does not
fail the job.

## Healthchecks

Paste the ping address, for example
`https://hc-ping.example.com/11111111-1111-4111-8111-111111111111`.
AnyGridDB calls it with `GET`. It appends `/start` when the job starts
and `/fail` when the job fails. The address itself means success. A
body that says the check was not found is a failed ping, even when the
status is 200. The address is a secret. After saving, **Send a test**
pings the success address once, without waiting for a schedule.

## Uptime Kuma

Paste the push address the monitor shows, for example
`https://kuma.example.com/api/push/secret`. AnyGridDB calls it with
`status=up` when the job succeeds or starts, and `status=down` when it
fails, plus a short `msg`. The address is a secret. It is the push
address of a Push monitor; other parts of that server's API are not
used.

## A generic address

Give up to three addresses: one for the start, one for success, one
for failure. AnyGridDB calls the one that matches, with `GET`. Leave
out a phase you do not want to signal.
