---
name: pinakes
description: "Use when you need facts about the external links people share on Pubky - what a link is (its typed card: web page, place, event, book, music, video, paper, post on another network, another Pubky app's object), places near a point with a tag, events in a city and time window, every link with one ISBN, DOI, ISRC or OSM id, and which links are the same thing on several services (Also on). Search Pinakes over HTTP or MCP. There is no public default instance: use the Pinakes URL you were given in place of <pinakes-url>. NOT for building or debugging a Pubky app (use pubky), NOT for native iOS/Android or React Native apps (use pubky-mobile), NOT for running or self-hosting Pubky services (use pubky-infra), and NOT for follows, users or threads in the social graph (use nexus-scout)."
metadata:
  author: pubky
  version: "0.1.0"
---

# Searching the links people share on Pubky (Pinakes)

Pinakes is a public index of the external links people reference on Pubky: web pages, places,
events, books, music, videos, papers, posts on other networks and objects of other Pubky apps.
Each link is read into a small typed card. You ask by text, type, tag, map area, time or an exact
identifier, and get cards back as JSON. No account, no API key, no install. Asking stores no new
link, except `POST /v1/resolve` (the MCP `card` tool with `resolve: true`): it fetches a link this
instance does not hold yet and stores it as a preview. A lookup or resolve of a held card that is
overdue moves it to the front of the refresh queue.

**Base URL: the host that served you this document**, `<pinakes-url>` here. Every instance indexes the
links its own Nexus reported, so another instance answers a different question.

## Quickstart

One GET is most of the API:

```sh
curl -s '<pinakes-url>/v1/search?q=lugano&limit=5'
```

```json
{"items":[{"id":"…","uri":"https://…","status":"ok","type":"Place","name":"…","description":"…","point":{"lat":46.0037,"lon":8.9511},"start":null,"site":"OpenStreetMap","group":null,"also_on":[]}],"cursor":"…","reach_truncated":false}
```

That is the shape only. `items` are cards; `cursor` is the next page (pass it back as `cursor`
with the same filters), `null` at the end.

To read one link you already have:

```sh
curl -s '<pinakes-url>/v1/resources/by-uri?uri=https://www.openstreetmap.org/node/240109189'
```

A link this instance does not know is a 404 there: nobody referenced it, or it has not been read.

## What is in the index

- **Cards.** `type` is a schema.org type (`Place`, `Event`, `MusicEvent`, `Book`,
  `ScholarlyArticle`, `MusicRecording`, `VideoObject`, `SocialMediaPosting`, `WebPage`, …).
  `name`, `description`, `image`, `site`, `point` (`lat`, `lon`), `start` and `end` are what the
  link's page or the service's own API says, except where `credits` names another source (a
  MusicBrainz card's Wikipedia or Wikidata text, its Commons image, or an album's cover from the
  Cover Art Archive, a film's or series' TMDB poster or overview): show each credit's author,
  licence and source page with its value (a cover has no author or licence: name the Cover Art
  Archive and link its source page). Cards may carry `credits` with provider `tmdb`: a client
  showing them must show TMDB's logo and its notice, both in `GET /v1/info` `attributions`. A MusicBrainz
  card's `facts` hold MusicBrainz's `rating` (0 to 5) and `rating_count` when people voted.
  `status` is `ok`, `pending`, `missing` (the object is gone upstream), `unreachable` or `error`.
  `embed` is the frame that shows the link as its own site does (a player, a post, a map): load
  its `src` in a sandboxed iframe sized by `height` or `aspect`; `null` when there is none. Each
  `also_on` link carries its own.
- **Only referenced links.** Search lists links someone tagged, replied to, embedded or added to a
  collection on Pubky.
  Pinakes holds no posts, users or tags of its own: those are Nexus's (below).
- **Groups.** Links that are the same thing on several services (a song on Spotify and on
  Apple Music, a DOI and its landing page, an event page and the same date in its organiser's
  calendar) form a group: `group.id` on each card, `also_on` lists the others. Every link keeps
  its own card. Only exact identifiers join a group; a match by title or time is a hint
  (`kind: "maybe"` in `also_on`, or `maybe_same` on events and recordings).
- **Podcasts.** A show's card (`PodcastSeries`) carries `episodes`: its latest 5 episodes with
  public audio or video, newest first, each with `uri`, `name`, `published` and a `stream` (`url`, `type`,
  `duration_s`) to play. `GET <pinakes-url>/v1/resources/{id}/episodes` pages through its latest 1000,
  20 at a time (`offset`, `next_offset`); `truncated: true` when its feed lists older ones than that.
- **Places and events.** `point` places a card on the map; events have `start`, `end` and, for
  calendars, one card per occurrence.
- **Identifiers.** Books, papers, music, films, podcasts and OSM objects carry exact keys:
  `isbn:`, `doi:`, `isrc:`, `upc:`, `mb:recording:` (and the other `mb:` kinds), `wikidata:`,
  `imdb:`, `podcast:`, `osm:`. Search's `key=` also takes `mbid:{uuid}` for any MusicBrainz kind.
- **Other Pubky apps.** `pubky://` objects of other apps, such as a Loopky deck or a marketplace
  listing, are cards too, with `open_in` naming the clients that open them.

`GET <pinakes-url>/v1/search?facet=type&limit=1` counts the card types this instance holds; each
entry's `type_path` (`["Thing", "CreativeWork", "MusicRecording"]`) places it in the schema.org
tree. `type` takes several types, any of them: `type=MusicRecording,MusicAlbum,MusicGroup`.
`exclude_type` leaves types out, each with its subtypes (up to 50): `exclude_type=Event,Place`
lists every card of another type (links with no type yet are left out too).
`facet` counts over every match of a search, not just the page: any of `type`, `tags`, `host`
(services: `{host, site, count}`, the `host` as `host=` takes it) and `category` (categories
such as OpenStreetMap's `amenity/cafe`, as `category=` takes them), e.g. `facet=type,host`.
`host` takes several hosts too, any of them: `host=open.spotify.com,www.deezer.com`.

## Recipes

**What is this link?**

```sh
curl -s '<pinakes-url>/v1/resources/by-uri?uri=https://www.imdb.com/title/tt0111161/'
```

A spelling people referenced works (the index keeps it as an alias), and so do tracking
parameters, a `doi.org` or ISBN link and a service's other URL forms of a known card, worked out
from the URI alone; `http` for `https`, `www.` or a trailing slash is another link unless someone
referenced it. A read is one flat object: the card's fields, and beside them the
address, facts from official APIs, `also_on` (one link per service, as on every card), the keys
`key=` takes (`keys`) and the other spellings (`aliases`). A Bitcoin or Lightning card also lists
the objects it points at in `related` (a transaction's block, inputs and outputs, an address's
latest transactions, a node's channels: `{rel, uri, name, amount_sat, at}`, each `uri` a card
root you can read the same way). To have an unknown link read, see `POST /v1/resolve` under
Limits.

**Places near a point, tagged something.**

```sh
curl -s '<pinakes-url>/v1/search?type=Place&near=47.3769,8.5417&radius=2000&tags=coffee&sort=distance'
```

`near` is `lat,lon`, `radius` metres (at most 200 km by default). `tags` takes up to five
comma-separated labels, any of them; add `match=all` for all of them (at most three). For a map
viewport use `bbox=minLon,minLat,maxLon,maxLat` instead of `near`.

**Events in Zürich this week.**

```sh
curl -s '<pinakes-url>/v1/search?type=Event&near=47.3769,8.5417&radius=15000&from=now&to=now%2B7d&sort=start'
```

`from` and `to` take RFC 3339, Unix milliseconds or `now`, `now+7d`, `now-12h`. In a query
string write `+` as `%2B` (a bare `+` is read as a space, which Pinakes also accepts as `+`).
`type=Event` includes `MusicEvent` and every other event type, and calendar dates.

**Remote jobs posted this month.**

```sh
curl -s '<pinakes-url>/v1/search?type=JobPosting&remote=true&from=now-30d'
```

A job posting's `start` is the date it was posted and its `end` its closing date; `from` and
`to` select by the date posted. `remote=false` keeps the postings that may not be done
remotely, with or without a workplace; `near` or `bbox` find those with one on the map. A closed
posting is left out unless you add `closed=true`.
`facts` holds the employer, employment type, salary, remote regions, apply link and
`job_status` (`open` or `closed`).

**Recipes with an ingredient.**

```sh
curl -s '<pinakes-url>/v1/search?type=Recipe&ingredient=chickpeas,lemon'
```

`ingredient` takes up to three comma-separated words; each must be a whole word of an
ingredient's name as the recipe's card records it, without amounts (`flour` matches
"all-purpose flour"). `facts` holds the time in minutes, yield, cuisine, category,
diets, rating and the ingredient list.

**Everything with one identifier.**

```sh
curl -s '<pinakes-url>/v1/search?key=isbn:9780140328721'
curl -s '<pinakes-url>/v1/search?key=doi:10.1038/nphys1170'
curl -s '<pinakes-url>/v1/search?key=isrc:GBAYE9701376'
curl -s '<pinakes-url>/v1/search?key=osm:node/240109189'
```

One key per search, in any spelling (ISBN-10 or ISBN-13, an ISRC with hyphens). An unknown
namespace is a 400.

**What else is the same thing?** Read the card and follow its group:

```sh
curl -s '<pinakes-url>/v1/resources/by-uri?uri=https://open.spotify.com/track/…'
curl -s '<pinakes-url>/v1/groups/{group.id}'
```

The group lists every member's card. `also_on` on a card already names one link per service,
including links nobody tagged that a source derived (`derived: true`), never another page of the
card's own service; for a song or an album, the one on the card's own release, else on the
original edition (not a deluxe, anniversary or remastered one).

**One row per thing, not per link.** Add `collapse=group` to a search: one row per group, the
member with the most references standing for it.

**What is popular.** `sort=trending&window=7d` ranks by references made in the window;
`sort=recent` by the newest reference; the default `activity` by taggers and references with a
30-day decay.

**Best match first.** With `q`, the default is `sort=relevance`: a name match first (the exact
name, then the words as a phrase, then all the words, then a partial name), then a tag label
equal to `q` or holding it, then the description; `activity` breaks ties. Add `sort=activity` for
the most popular matches instead. `sort=relevance` needs `q`. A short `q` (letters and digits, at
most three characters with the spaces, like `ai` or `btc`; not Hebrew, Arabic or a script written
without spaces) matches a name only where a word starts (`Airbnb`, not `Rain`).

**Similar links.** `related=<card id>` lists what the people who tagged a card also referenced,
most shared taggers first. Each row's `because` says why: `shared` (how many of them) and
`taggers` (up to three Pubky keys, the most recent first); ask Nexus for their names and tags.

## Joining with Nexus by URI

Pinakes ranks, Nexus hydrates. Pinakes's `id` is its own: join the two indexes by **URI**, never
by id. Who tagged a link, with which labels, and what your own follows think of it are Nexus's.

1. Search Pinakes: take each card's `uri` **and its `refs`**. A typed card's `uri` is often not
   a link anyone wrote: the card of a Bitcoin block is `btc:block/…`, a protein's `uniprot:…`,
   a book's `isbn:…`, while people tagged the mempool.space, UniProt or Open Library page.
   `refs` lists those links, the ones that carry references, most referenced first (at most
   5). An occurrence's `uri` is the event's own page, which nobody tagged: people tagged its
   feed, `occurrence.feed_uri`, and its `refs` are the feed's. A full read
   (`GET /v1/resources/{id}`) lists every other spelling of a card's link in `aliases` (at most
   50); add those for a complete join. Ask Nexus about all of them, and add up a
   card's tags over its links. To show group tags, also include each exact, non-derived
   `also_on` member's `uri` and optional `refs`: the same selection as its card's `refs`,
   at most 5, omitted when empty or just its `uri`. Batch these with the card's own links;
   no group read is needed for the supplied members. Derived and `kind: "maybe"` links
   have no `refs` and are not exact-group tag sources. The lists are bounded, not every
   group member or every alias.
2. Send those URIs, 100 at a time, to the Nexus batch resource view:

```sh
curl -s "$NEXUS/v1/stream/resources/by_ids" -H 'content-type: application/json' \
  -d '{"uris":["https://www.openstreetmap.org/node/240109189"],"viewer_id":"<your pubky key>"}'
```

Each answer has `details.uri`, `tags` (`label`, `taggers_count`, and with `viewer_id`
`tag_uri`: the address of the viewer's own tag file for that label, `null` when they did not use
it) and `taggers_count`, in request order;
unknown URIs are skipped. Through MCP, the `social` tool does the whole join with the Nexus this
instance reads: give it card ids, and it asks by each card's `uri` and `refs` and merges the
answers per card (each tagger counted once per label; `at_least: true` marks a count that is a
lower bound, when several links' views count taggers they do not list).

**Collections.** A card's `collections` counts the public Pubky collection posts that hold its
link (its own or an alias's); `GET <pinakes-url>/v1/resources/{id}/collections?viewer=<pubky key>`
lists them, the viewer's own first (their 100 newest), then newest first: `{uri, author, indexed_at}` each, paged
with `cursor`. `uri` is the collection post: ask Nexus for its name and items. A search with
`in_collection=<that uri>` lists the cards one collection holds.

For graph questions (who follows whom, trust, threads, a user's tags) use **nexus-scout**
(`https://nexus-scout.pubky.app/llms.txt`): read-only Cypher over the Pubky social graph. To keep
only links your network referenced, search here with `reach=following&viewer=<pubky key>` (or
`friends`); to rank them first and keep the rest, use `boost` instead of `reach`.

## MCP

`POST <pinakes-url>/mcp` is a Model Context Protocol endpoint (Streamable HTTP, stateless, no auth).
No tool stores a new link, except `card` with `resolve: true`, which stores an unknown link as a
preview and has this instance fetch it from its site. Its tools are thin calls into the routes
above, and each answer names the REST URL with the full result:

| tool | does |
| --- | --- |
| `search` | `GET /v1/search`: `q`, `type` (one or several), `exclude_type`, `tags`, `match`, `near` + `radius`, `bbox`, `from`, `to`, `key`, `remote`, `closed`, `ingredient`, `in_collection`, `host`, `category`, `facet`, `sort`, `window`, `collapse`, `referenced`, `reach` or `boost` + `viewer`, `limit`, `cursor` |
| `card` | One link's card by URI (`GET /v1/resources/by-uri`); `resolve: true` asks `POST /v1/resolve` for an unknown link. A card a public collection holds carries `collections` (the count), `in_collections` (the newest 5) and `collections_url` |
| `lookup` | Every card with one identifier (`isbn:…`, `doi:…`, `isrc:…`, `osm:…`, …) |
| `group` | A group's members by group id |
| `types` | The card types this instance holds, with counts, and the kinds of links it resolves |
| `social` | Tags and taggers per card, from the Nexus this instance reads: card `ids` (asked by their `uri` and `refs`, merged; an alias's id answers with its `root`) or plain `uris` this instance holds (others come back in `unknown_uris`, unasked), 1–100 together |

Add it to a client as a remote (HTTP) MCP server at `<pinakes-url>/mcp`.

## Limits

- **Per-IP budget**: 120 requests a minute over every public route by default
  (`limits.requests_per_minute` in `GET <pinakes-url>/v1/info`). A `reach` or `boost` search costs 6, a
  `related` search 6. Over budget is a 429 with `Retry-After: 60`. An MCP message costs one, and a tool
  call costs what its REST call costs on top; the `social` tool costs one per 100 URIs it asks.
- **Pages**: `limit` 1–500, default 50. Follow `cursor`; a full page does not mean there is no
  more.
- **Inputs**: a URI at most 2048 bytes, `q` at most 256 bytes, at most 5 tags, bodies at most
  2 MB.
- **Reading new links**: `POST <pinakes-url>/v1/resolve` with `{"uri": "…"}` reads a link now (within 3
  seconds, else 202 `pending`: read it again later by id). It has its own smaller budget
  (`limits.previews_per_minute` and `previews_per_uri_per_minute` in `/v1/info`). Search never
  fetches, and nothing you resolve is listed by search until someone references it on Pubky. A
  link that carries a credential (a private calendar link, a `token` or `key` parameter) is
  refused with 400; never send one. When the instance has taken all the new links it reads in an
  hour, a new one gets 503 with `Retry-After`; a link it knows still reads.

## Errors

Errors are `{"error": "…"}` with the status:

| status | meaning | what to do |
| --- | --- | --- |
| 400 | A parameter Pinakes cannot use; the message names it | Fix it. A 400 on a `cursor` means the daemon restarted or the filters changed: search again without it |
| 404 | An unknown link, resource or group | For a link: nobody referenced it here. Resolve it, or search by `q` or `key` |
| 413 | Body over 2 MB | Send less |
| 429 | Over the per-IP budget | Wait the `Retry-After` seconds. Ask fewer, larger questions: one search with `facet`, or `POST /v1/resources/lookup` for up to 500 links at once |
| 502 | Nexus did not answer a `reach` search in time | Retry once, or drop `reach` |
| 503 | The instance has read all the new links it takes this hour (`POST /v1/resolve`) | Wait the `Retry-After` seconds; links it knows still read |
| 504 | The request took longer than the instance's timeout (30 s by default) | Retry once with a narrower question |
| 500 | Internal | Retry once |

`GET <pinakes-url>/v1/openapi.json` describes every route and parameter.
