---
name: nexus-scout
description: "Use when you need facts from the Pubky social graph - who follows whom, trending tags, thread/reply history, author reputation, trust distance between users. Query the graph with read-only Cypher over HTTP. NOT for building or debugging a Pubky app (use pubky), NOT for native iOS/Android or React Native apps (use pubky-mobile), and NOT for running or self-hosting Pubky services (use pubky-infra)."
metadata:
  author: pubky
  version: "0.1.0"
---

# Querying the Pubky social graph (nexus-scout)

nexus-scout is a public, read-only gateway to the Pubky social graph. You write Cypher, it validates
the query is read-only, runs it against Neo4j, and returns JSON. No account, no API key, no install.

**Base URL: the host that served you this document.** The public instance is
`https://nexus-scout.pubky.app`, which the examples below use. If you fetched this from somewhere
else, a local or staging gateway, substitute that host everywhere: the graph behind each deployment
is different, so pointing these examples at the public instance would answer a different question.

## Quickstart

One POST is the whole API:

```sh
curl -s https://nexus-scout.pubky.app/v1/query \
  -H 'content-type: application/json' \
  -d '{"cypher":"MATCH (u:User)<-[f:FOLLOWS]-() RETURN u.name AS name, count(f) AS followers ORDER BY followers DESC LIMIT 10"}'
```

```json
{"results":[{"name":"Alice","followers":283},{"name":"Bob","followers":161}],"count":10,"truncated":false}
```

Shape only, with the array elided: `count` always equals `results.len()`. Names and numbers depend on
the graph behind the deployment you are querying.

Body fields: `cypher` (required), `params` (object, optional), `limit` (number, optional, forces the
row cap). Single-quote the shell argument so `$param` references reach the server intact.

**If you can only issue GET requests**, the same endpoint takes a query string. Reading changes
nothing, so both verbs do the same work:

```
https://nexus-scout.pubky.app/v1/query?cypher=MATCH%20(u:User)%20RETURN%20u.name%20LIMIT%205
```

Percent-encode the Cypher. `params` takes a percent-encoded JSON object and `limit` a number. Use
POST when a query is long, since URLs have their own length limits.

## Learn the schema first

```sh
curl -s https://nexus-scout.pubky.app/v1/schema
```

Returns the node labels and their properties, the relationship types with direction, and example
queries. It is the source of truth; the recipes below are starting points.

## Recipes

Copy these. They cover most of what gets asked.

**Find a user by name.** Names are display names and are not unique, so check before you commit to
one. `id` is the pubky public key and is the stable handle.

```cypher
MATCH (u:User) WHERE toLower(u.name) CONTAINS toLower($name)
OPTIONAL MATCH (u)<-[f:FOLLOWS]-()
RETURN u.id AS id, u.name AS name, u.bio AS bio, count(f) AS followers
ORDER BY followers DESC LIMIT 10
```

Pick by follower count and bio when several match. A common surname routinely returns several
accounts with wildly different follower counts, including near-empty impersonations, so resolve to an
`id` before asking anything else about "that person".

**Friends.** There is no friendship edge. The usual reading is a mutual follow:

```cypher
MATCH (u:User {id: $id})-[:FOLLOWS]->(f:User)-[:FOLLOWS]->(u)
RETURN count(DISTINCT f) AS friends
```

Swap `count(DISTINCT f)` for `f.id AS id, f.name AS name` plus `ORDER BY f.id`/`SKIP`/`LIMIT` to list
them. Run the count first: the list is capped (see Limits) and the count tells you whether you got all
of them. Say which definition you used, since one-way follows give different numbers.

**Someone's most-used tag.** Start with the combined ranking, which is the answer to the question as
usually asked:

```cypher
MATCH (u:User {id: $id})-[t:TAGGED]->(x)
RETURN t.label AS tag, count(*) AS uses
ORDER BY uses DESC LIMIT 20
```

Then check whether the split changes it, because `TAGGED` points at both posts and users and the
winner really can flip:

```cypher
MATCH (u:User {id: $id})-[t:TAGGED]->(x)
RETURN t.label AS tag, labels(x)[0] AS target, count(*) AS uses
ORDER BY uses DESC LIMIT 20
```

A label used heavily on both posts and people can top the combined ranking while a posts-only label
tops the split one. Report the combined number and mention the split when they disagree. Add
`WHERE x:Post` to count post tags alone.

**Trending tags.**

```cypher
MATCH (:User)-[t:TAGGED]->(p:Post) WHERE t.indexed_at > $since
RETURN t.label AS tag, count(p) AS uses ORDER BY uses DESC LIMIT 20
```

**A user's reputation**, meaning the tags other people put on them:

```cypher
MATCH (:User)-[t:TAGGED]->(u:User {id: $id})
RETURN t.label AS label, count(*) AS n ORDER BY n DESC LIMIT 20
```

**Reply thread under a post.**

```cypher
MATCH (reply:Post)-[:REPLIED*0..5]->(root:Post {id: $post_id})
MATCH (a:User)-[:AUTHORED]->(reply)
RETURN reply.content AS content, a.name AS author, reply.indexed_at AS at
ORDER BY at LIMIT 50
```

**Follow distance between two users.**

```cypher
MATCH path = shortestPath((a:User {id: $from})-[:FOLLOWS*..5]->(b:User {id: $to}))
RETURN length(path) AS distance, [n IN nodes(path) | n.name] AS chain
```

Parameters go in `params`:

```sh
curl -s https://nexus-scout.pubky.app/v1/query \
  -H 'content-type: application/json' \
  -d '{"cypher":"MATCH (u:User {id: $id})-[:FOLLOWS]->(f)-[:FOLLOWS]->(u) RETURN count(DISTINCT f) AS friends",
       "params":{"id":"ihaqcthsdbk751sxctk849bdr7yz7a934qen5gmpcbwcur49i97y"}}'
```

## Limits and paging

**Rows are capped, and the cap is easy to miss.** No `LIMIT` gives you 25. The hard ceiling is 100:
`LIMIT 500` returns at most 100, and if more than 100 rows matched you get 100 plus a `notes` entry
saying it was capped. Fewer matching rows come back untouched and unflagged.

**`truncated` does not mean "there is more".** It fires only when the *gateway* cut rows. If your own
`LIMIT 50` returns 50 rows, Neo4j did the cutting, the gateway never saw a 51st row, and `truncated`
stays `false` even though more rows exist. When that happens you get a `notes` entry saying the page
exactly filled your limit, but treat any full page as suspect and get the total separately:

```cypher
MATCH (u:User {id: $id})-[:FOLLOWS]->(f:User)-[:FOLLOWS]->(u)
RETURN count(DISTINCT f) AS total
```

then page with `SKIP` until you have that many. **Order by `id`, never by `name`:** display names are
not unique here, and duplicates straddling a page boundary silently drop or repeat rows.

```cypher
MATCH (u:User {id: $id})-[:FOLLOWS]->(f:User)-[:FOLLOWS]->(u)
RETURN f.id AS id, f.name AS name ORDER BY f.id SKIP 100 LIMIT 100
```

Getting this wrong is the most common way to report a confidently wrong number: if the count says
N and your list has 100, you are missing N-100. Check the page count against the count query before
you answer.

Other bounds:

- **Query text is capped at 2000 characters.** This is the one most often hit first. A long
  `WHERE ... OR ...` chain will trip it; use a parameter with a list and `IN $ids` instead.
- Parameters: at most 32, and 8 KiB total across all of them.
- Variable-length paths are capped at `*1..5`. Write `*` and it becomes `*1..5`; the response `notes`
  say so when it happens.
- Queries time out around 10 s. Narrow the `MATCH`, add a `LIMIT`, or reduce depth.
- Several `OPTIONAL MATCH` clauses in one query multiply into a cartesian product, which both inflates
  counts and can time out. `count(DISTINCT ...)` fixes the inflated number but not the cost; to fix
  the cost, split it into separate queries or put a `WITH` between the clauses.
- The result payload is capped at 1 MiB. Past that, rows are dropped and `notes` says so. Paging does
  not help; return fewer or smaller columns.
- Request bodies are capped at 64 KiB.
- Address result columns by name. Column order is not guaranteed.

## What is in the graph

Three node labels (`User`, `Post`, `File`) and eight relationship types.

| you want | use |
|---|---|
| followers / following | `FOLLOWS` (User→User) |
| a user's posts | `AUTHORED` (User→Post) |
| reply threads | `REPLIED` (Post→Post) |
| reposts | `REPOSTED` (Post→Post) |
| tags on posts or people | `TAGGED` (User→Post and User→User), tag text is `t.label` |
| bookmarks | `BOOKMARKED` (User→Post) |
| mentions | `MENTIONED` (Post→User) |
| mutes | `MUTED` (User→User) |

`User.id` and `Post.id` are the stable identifiers. `indexed_at` is Unix milliseconds and is the only
time signal.

**Tags are not nodes.** The tag text lives on the `TAGGED` relationship's `label` property. There is
no `(:Tag)` node to traverse to, and matching one returns nothing. Files are found by scanning a
property (`MATCH (f:File) WHERE f.owner_id = $id`), not by traversal.

**Not modeled**, so do not try: likes, reactions, upvotes, view or engagement counts, direct
messages, per-item privacy flags, edit history, and ranked full-text search. Match text with
`CONTAINS` / `STARTS WITH` / `=`, which is exact or substring, not relevance-ranked. Popularity is
inferable only by counting `FOLLOWS` / `TAGGED` / `REPOSTED` edges.

## Rules

Read-only is enforced by a sanitizer, not by convention:

- `CREATE`, `MERGE`, `SET`, `DELETE`, `DETACH`, `REMOVE`, `DROP`, `FOREACH`, `LOAD`, and `INSERT` are
  rejected.
- `CALL` is rejected in every form, both stored procedures and `CALL {}` subqueries. Bare functions
  need no `CALL` and are fine: `count()`, `collect()`, `shortestPath()`, `labels()`, `type()`.
- Namespaced calls (`apoc.*`, `db.*`, `dbms.*`, `gds.*`) are rejected.
- Admin and selector clauses (`USE`, `SHOW`, `PROFILE`, `EXPLAIN`) are rejected.
- **`USING` is rejected**, which catches read-only query hints (`USING INDEX`, `USING SCAN`,
  `USING JOIN`) as well as `USING PERIODIC COMMIT`. The error says "mutating clause"; that wording is
  wrong for a hint, so do not go looking for a write in your query. Just drop the hint.
- Comments and `;` are rejected.
- Quantified path patterns (`((a)-[:R]->(b)){1,3}`) are rejected. Use a bounded variable-length
  relationship instead: `-[:FOLLOWS*1..5]->`.
- A variable that spells a reserved keyword is rejected. Rename it.

## Reading the output

```json
{"results":[{"name":"Alice","followers":142}],"count":1,"truncated":false}
```

`truncated: true` means the gateway dropped rows (see the caveat under Limits: your own `LIMIT` doing
the cutting is *not* flagged). `notes` appears whenever the gateway rewrote your query or capped your
rows, and says which, for example `"variable-length path '*1..10' bounded to '*1..5'"` or
`"the requested limit of 500 was capped to the maximum of 100 rows"`. Read it whenever an answer
looks smaller than you expected.

Two value shapes to expect. A temporal or spatial value Neo4j cannot render as JSON comes back as
`{"_unconvertible": "<type>"}`, so `RETURN datetime()` gives you a marker rather than a timestamp;
compute from `indexed_at` (Unix ms) instead. A row that fails conversion outright becomes
`{"_row_error": ...}` rather than failing the whole query.

Errors are `{"error": CODE, "message": ..., "hint": ...}`. The `hint` names the fix.

| code | meaning | what to do |
|---|---|---|
| `QUERY_REJECTED` | A guardrail refused the query | Read the `hint`; it names the clause. Rewrite with plain `MATCH`/`WITH`/`RETURN`. |
| `QUERY_SYNTAX_ERROR` | Neo4j could not parse it | `message` carries the offending token, line, and column. Fix and resend. |
| `QUERY_TIMEOUT` | Too expensive | Add a `LIMIT`, narrow the `MATCH`, reduce path depth, or split one query into several. |
| `RATE_LIMITED` | Too many requests | Back off and retry. Batch your questions into fewer, larger queries rather than looping one row at a time. |
| `INTERNAL_ERROR` | Transient | Retry once. |

Not every failure uses that envelope: an oversized body (413) and a request timeout (504) are
answered by the outer HTTP layers as plain text, so check the status before parsing JSON.

## The CLI (optional)

`scout` wraps the same HTTP API with exit codes for scripting. **curl is enough and needs no
install**; this is only for ergonomics, and it has to be built from a source checkout.

```sh
cargo install --path crates/nexus-scout-cli   # from a clone of the repo
scout query "MATCH (u:User) RETURN u.name LIMIT 5"
scout schema
```

It defaults to `https://nexus-scout.pubky.app`; override with `--server-url` or `NEXUS_SCOUT_URL`.
Parameters take `--param key=value` for strings and `--params-json '{...}'` for typed values. Exit
codes: `0` ok, `1` internal or transient, `2` rejected, `3` timeout. The JSON envelope always goes to
stdout for `jq`.
