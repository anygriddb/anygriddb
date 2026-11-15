# Rooms and alerts

These channels live under Administration, Connections, Notifications,
next to the webhook. Each one hears the events that were checked when
it was saved. The address is HTTPS. A private address is allowed only
when private networks are turned on, on that same page.

## Matrix

Set the homeserver, for example `https://matrix.example.com`, the room
id, and an access token. The token is a secret. AnyGridDB sends one
text message per event:

`PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{eventId}`

The body is `{ "msgtype": "m.text", "body": "…" }`. The event id is the
transaction id, so a repeat does not post a second message.

## Mattermost and Rocket.Chat

Paste the incoming webhook address. It is a secret: it carries the key.
AnyGridDB POSTs `{ "text": "…" }`.

## Zulip

Paste the generic incoming webhook address. It contains the bot key, so
the whole address is a secret. AnyGridDB POSTs
`application/x-www-form-urlencoded` with a `content` field.

## Alertmanager

Set the Alertmanager address, for example
`https://alerts.example.com`. AnyGridDB POSTs a one-element array to
`/api/v2/alerts`. `labels.alertname` is the event type and `startsAt`
is when it happened. An event whose type ends in `.recovered` or
`.succeeded` also sends `endsAt`, which closes the alert. A username
and password are sent as HTTP basic authentication when the API
requires them.
