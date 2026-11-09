# Brief client — API REST, OpenAPI et MCP

## Synthèse

| Besoin                    | Réponse                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| API documentée            | **Oui** — REST `/api/v1`, un document OpenAPI 3.1 par base, une page qui essaie les requêtes  |
| Sans SQL direct           | **Oui** — jetons `ag_…` : lecture et écriture des lignes sous les droits de leur titulaire    |
| Formules, vues, filtres   | **Oui** en lecture (`?view=`, filtres, tri, recherche)                                        |
| Webhooks, automatisations | **Oui** (configurés dans l’application)                                                       |
| IA embarquée              | **Non** — vous branchez la vôtre (Claude, Cursor, un modèle local derrière un client MCP)     |
| Serveur MCP               | **Oui** — Streamable HTTP sur `/mcp`, avec un jeton                                           |
| Ce que l’IA peut faire    | Ce que permet le jeton : lire, et écrire s’il n’est pas en lecture seule ; ni admin ni schéma |

## Texte prêt à envoyer

> AnyGridDB expose une API REST `/api/v1`, décrite par un document OpenAPI 3.1 pour chaque base, et une page de l’application permet d’essayer les requêtes. Votre data engineer lit et écrit des enregistrements avec des jetons à portée limitée, sans accès direct aux bases de données.
>
> Pour brancher une IA que vous opérez (Claude, Cursor, un modèle local derrière un client MCP), AnyGridDB fournit un serveur MCP sur `/mcp`. Ses outils couvrent les mêmes enregistrements que l’API REST. AnyGridDB n’embarque aucun modèle et n’appelle aucun service extérieur : vous gardez la main sur l’IA. Elle agit avec les droits du jeton, jamais plus que ceux de son titulaire ; un jeton en lecture seule ne lui propose que la lecture.
>
> Détail pour l’exploitant : `docs/mcp.md` dans le dépôt.
