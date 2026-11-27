# Notifications

An administrator connects a channel under Administration, Connections,
Notifications. Nothing has to be set in the environment. An instance
with no channel behaves as before.

A channel hears the events that were checked when it was saved. A
failed background job is one of them. The work that failed does not
wait for the channel, and does not fail again because the channel did.

## A signed webhook

The channel is an HTTPS address. AnyGridDB POSTs the event as JSON and
signs those exact bytes with HMAC-SHA256. The header is
`x-anygrid-signature: sha256=` and the hex digest. The signing secret
is at least 16 characters. It is stored encrypted and is not shown
again; leave the field blank when you change something else.

Optional headers are one per line, `Name: value`. They are stored the
same way. `Content-Type` and `x-anygrid-signature` are set by
AnyGridDB.

```json
{
  "id": "6f1c1c3e-7b2a-4c1a-9d2e-1a2b3c4d5e6f",
  "type": "job.failed",
  "at": "2026-11-15T18:00:00.000Z",
  "subject": "6f1c1c3e-7b2a-4c1a-9d2e-1a2b3c4d5e6f",
  "fields": { "kind": "export", "code": "internal_error" }
}
```

`subject` and `fields` are identifiers and codes. They are not a row,
an address, or a secret.

Check the signature over the raw body with the secret, and reject a
body whose digest does not match. A delivery waits at most ten
seconds. It is tried again after one minute, five minutes, and thirty
minutes. The same subject is not sent twice inside five minutes, and a
channel starts at most twenty deliveries an hour. After five exhausted
deliveries the channel pauses, and the other channels may hear
`integration.failing`.

Send a test from the page. The status and a short excerpt of the
answer are shown there. A secret that the answer echoes is replaced.

## Addresses

The address is HTTPS, and the certificate is verified. A public
address is the default. Loopback, link-local, and cloud metadata are
always refused, including after DNS and one redirect.

Turn on **Allow private networks** when the channel is on your own
network, for example `https://10.1.2.3/hook`, and confirm what it opens.
The connection is still HTTPS. It is listed under Administration ›
Security › Relaxed requirements, with whoever turned it on, and can be
turned off there. A notifier that only speaks clear text has to present a
certificate first. A private certificate can be trusted by the process
the same way the stack's own services are (`NODE_EXTRA_CA_CERTS`).

## What the page keeps

The list shows the name, the provider, whether the channel is on, the
last delivery, the last short error, and how many messages were held
back. History shows the last 50 deliveries. They are removed after 30
days.

Creating, changing, and removing a channel is written to the sign-in
trail as a settings change. The secret is not.

## ntfy

Set the server, for example `https://ntfy.example.com`, and the topic.
The topic is the credential: it is stored encrypted and is not shown
again. AnyGridDB POSTs the message to `{server}/{topic}` with a
`Title` and a `Priority` header. If the topic requires a token, put it
in the token field; it is sent as `Authorization: Bearer`.

## Gotify

Set the server, for example `https://gotify.example.com`, and the
application token from Gotify's Apps page. AnyGridDB POSTs JSON
`{ "title", "message", "priority" }` to `{server}/message` with the
header `X-Gotify-Key`.

## Apprise

Set the Apprise API address, for example `https://apprise.example.com`,
and the destination URLs Apprise understands (`mailto://…`, and the
others that server supports). Those URLs are a secret: they often
contain a password, and they are sent in the JSON body of `POST
{server}/notify` as `urls`, with `title`, `body`, and `type`. A
username and password are sent as HTTP basic authentication when the
API requires them.

## Email

List one address per line. AnyGridDB sends through the relay already
configured under Connections. If that relay is not set, the test says
so and nothing is sent.
