# Applications (OAuth)

An application asks a person for access to the bases they choose, and
gets a token for the REST API and the MCP endpoint. The person can take
it back at any time, and so can an administrator.

AnyGridDB gives the authorization code grant with PKCE (S256) and
refresh tokens, to applications an administrator registered. Nothing
else: no implicit grant, no device grant, no application that registers
itself.

## Register the application

Administration, Connections, Applications: a name, and the addresses
the application is sent back to (`https://…`, or `http://` on the
machine's own loopback). The page shows a client id (`agc_…`) and a
secret (`ags_…`), once.

## Where the addresses are

```sh
curl https://grid.example.org/.well-known/oauth-authorization-server
```

answers the addresses below and what they take, as RFC 8414 describes.

## Ask the person

Send the person's browser to:

```text
https://grid.example.org/oauth/authorize
  ?client_id=agc_…
  &redirect_uri=https://app.example.org/callback
  &code_challenge=<base64url(sha256(verifier))>
  &state=<a value the application checks on return>
```

The verifier is 43 to 128 characters the application keeps to itself.
The person signs in, chooses the bases, and whether the application may
only read. They are sent back to `redirect_uri` with `code` and `state`,
or with `error=access_denied`. The address must be one of those
registered, character for character.

## Exchange the code

Within ten minutes, once:

```sh
curl https://grid.example.org/oauth/token \
  -u 'agc_…:ags_…' \
  -d grant_type=authorization_code \
  -d code=ago_… \
  -d redirect_uri=https://app.example.org/callback \
  -d code_verifier=<the verifier>
```

```json
{
  "access_token": "ag_…",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "refresh_token": "agr_…"
}
```

The client proves itself with its id and secret, in the
`Authorization: Basic` header (as above) or as `client_id` and
`client_secret` in the body: one or the other, never both.

The access token is an API token like any other: `Authorization: Bearer
ag_…` on `/api/v1` and `/mcp`, limited to the bases the person chose.
It lives as long as the instance lets a token live, thirty days unless
the policy is shorter.

## Renew, and give back

```sh
curl https://grid.example.org/oauth/token -u 'agc_…:ags_…' \
  -d grant_type=refresh_token -d refresh_token=agr_…
```

answers a new pair; the earlier access token and refresh token stop
working. A refresh token lives ninety days and works once.

```sh
curl https://grid.example.org/oauth/revoke -u 'agc_…:ags_…' -d token=agr_…
```

ends the grant: the refresh token and its access token, whichever of the
two is given. It answers 200 whether or not the token was still there.

These two addresses take 120 requests a minute per client address, apart
from people's sign-ins: a backend that renews its people's grants takes
nothing from theirs. Past that, they answer 429.

## Refusals

| Answer                       | When                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 401 `invalid_client`         | The id or the secret is wrong, or the application was revoked                                       |
| 400 `invalid_grant`          | The code or the refresh token is wrong, used, expired, or was given for another address or verifier |
| 400 `invalid_request`        | The secret was sent in the header and in the body                                                   |
| 400 `unsupported_grant_type` | Any grant but the two above                                                                         |
| 429                          | More than twenty requests a minute from one address                                                 |

The person finds the grant among their tokens (Account settings), named
after the application, and revokes it there. An administrator who
revokes the application ends every grant it was given.
