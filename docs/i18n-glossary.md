# UI glossary (English source)

Use these terms in `` t`…` `` / `` msg`…` `` so English stays consistent.
French translations live in `apps/web/locales/fr/messages.po`.

| Concept           | English                                                  | Notes                                                                                                                            |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Base              | Base                                                     | A workspace of tables                                                                                                            |
| Table             | Table                                                    |                                                                                                                                  |
| Field / column    | Field                                                    | Prefer “field” in chrome; “column” only for SQL/source talk                                                                      |
| Row / record      | Row                                                      | Prefer “row” in the grid                                                                                                         |
| View              | View                                                     | Grid, kanban, calendar, …                                                                                                        |
| Share             | Share                                                    | Public link                                                                                                                      |
| Automation        | Automation                                               |                                                                                                                                  |
| Webhook           | Webhook                                                  |                                                                                                                                  |
| Source            | Source                                                   | External client database                                                                                                         |
| Sync / copy       | Sync, copy                                               | ADR 0034                                                                                                                         |
| Trash             | Trash                                                    | Soft-delete                                                                                                                      |
| Restore point     | Restore point                                            | A whole base kept on the instance for a time; restoring one makes a new base and changes nothing (French: point de restauration) |
| Role              | Role                                                     | Owner, editor, …                                                                                                                 |
| Instance          | Instance                                                 | The deployment                                                                                                                   |
| Locale / language | Language                                                 | User-facing menu label                                                                                                           |
| Account create    | Add a person                                             | Administration accounts; not “Create account” there                                                                              |
| Account erase     | Delete                                                   | Not “Erase”; confirmation still types the email                                                                                  |
| Second factor     | Second factor                                            | Not “two-factor authentication”, “2FA”, or “MFA”                                                                                 |
| Sign-up           | Create an account                                        | “Sign-up” is the noun (sign-up domains); the action is “create an account”, not “sign up” or “register”                          |
| Card              | Card                                                     | A row drawn as a card in the kanban and the gallery (“Add a card”, “Card fields”); a row everywhere else                         |
| Person field      | Collaborator                                             | The field that holds people of the base; not “user field”                                                                        |
| Invite / grant    | Invite, Add                                              | Prefer the verb people look for                                                                                                  |
| Client database   | Add a source                                             | Not “Declare a source”                                                                                                           |
| SCIM-managed      | Managed by your identity provider                        | Not “Kept by…”; the Provisioning page is labelled “Provisioning (SCIM)”                                                          |
| Admin sections    | People, Security, Connections, Sources, Trails, Instance | Named by task (ROADMAP #49); “Connections” are the services the instance talks to, “Sign-ins” are people signing in              |

## Tone

- Sentence case for buttons and labels (`Add a row`, not `Add A Row`).
- Named ICU placeholders only (`{count}`, `{name}`).
- English plurals with `plural` / ICU `one` / `other` (and `=0` when needed).
- Do not invent French formula aliases; function names stay `LEN`, `IF`, …
- French: the typographic apostrophe (’), and a non-breaking space before `:` `;` `?` `!` and inside « ». The catalog check refuses the straight apostrophe and an ordinary space there.
