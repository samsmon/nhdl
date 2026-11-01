# Content type (Comic / Manga) — Design

Status: design approved in chat (2026-10-06), awaiting written spec review.
Branch: `rework`. Continues [multi-source download](2026-10-06-multi-source-download-design.md).

> Repo documentation rule: sites are written generically — **site A** (default, unchanged), **site B1/B2** (numeric ID, category read from the page), **site C** (slug ID, category from the API). Real names, domains, and prefixes exist only in code.

## 1. Goal

Galleries from site B1, B2, and C have a **category** on their site. NHDL maps it to a `comic` / `manga` / `other` content type, then:
- stores downloads in a per-type folder (`Download/<Type>/<Language>/<Author>/<Title>`), and
- shows the type in the UI (badge, sidebar filter, Library Manager).

Success criteria:
- New galleries from site B1/B2/C land in the correct type folder; `western`/Western comic galleries go to `Comic`, `manga` and `doujinshi` go to `Manga`.
- The queue and library show the type per item and can be filtered by type.
- Old data (queue, library, `.nhdl-id` markers, already downloaded files) stays valid; no files are moved automatically.
- Site A is completely unchanged (no type, old folder).

Out of scope: moving the existing library to the new structure, types for site A, categories other than the mapping below as their own type.

## 2. Data findings (checked directly against the sites)

| Site | Category source | Example |
|---|---|---|
| Site B1 | the gallery page contains category links styled like `href='/category/<slug>/'` | `manga` |
| Site B2 | same as B1 | `western`, `doujinshi` |
| Site C | the detail endpoint `GET /api/comics/<slug>` returns `category: { name, slug }`; the `/images` endpoint currently used does not include it | `porn-comic`, `manga` |

Categories seen: doujinshi, manga, non-h, western, imageset, artistcg, misc, and one comic category specific to site C. Doujinshi is the largest category on site C.

## 3. Type model

`ContentType = 'comic' | 'manga' | 'other'`. UI label and folder name: `Comic`, `Manga`, `Other`.

Category slug (lowercase) → type mapping, a single function `mapCategoryToType(slug)` in `core/providers/contentType.js`:

| Slug | Type |
|---|---|
| `western`, `porn-comic`, `comic` | `comic` |
| `manga`, `doujinshi` | `manga` |
| any other non-empty slug (non-h, imageset, artistcg, misc, etc.) | `other` |
| empty / not found | `null` (no type) |

The provider fills `meta.category` (raw slug) and `meta.contentType` (mapped result). Site A fills neither.

## 4. Fetching the category

- **Site B1/B2 (`boards.js`)**: read the category slug from the `href='/category/<slug>/'` link on the gallery page (the same single-quote pattern as other taxonomies). If there are several, take the first non-duplicate; if none → `null`.
- **Site C (`slugapi.js`)**: after `/images` succeeds, fetch `GET /api/comics/<slug>` and read `category.slug`. This request uses the same transport (curl). **A failed category request must not fail the download**: log a warning in the activity log and continue with `null`.
- Validation: a category slug from the remote is accepted only if it matches `^[a-z0-9][a-z0-9-]{0,40}$`; otherwise it is treated as `null` (never used raw as a folder name — the folder uses the fixed type label).

## 5. Folder storage

In `core/engine.js` `processGallery`, for non-default providers with a non-`null` `contentType`:

`parentDir = <base>/<TypeLabel>/<Language>/<Author>` (previously `<base>/<Language>/<Author>`). If `contentType` is `null`, or the provider is the default, the old layout is used.

Impact checked:
- `deriveLineageFromPath` (artist = parent, language = grandparent) remains correct because the type level sits above language.
- `rescanLibrary` uses `MAX_DEPTH = 6` and markers; the new depth (`base/Type/Language/Author/Title` = 4) is still within the limit.
- `findExistingOnDisk` (fallback on 429) currently walks two levels (`Language/Author`); it is extended to also walk `Type/Language/Author`.
- A gallery that was partly downloaded in the old layout will restart in the new layout (pages are downloaded again); this is accepted and noted in the documentation.

## 6. Database (migration v4, both adapters)

- `ALTER TABLE queue ADD COLUMN category TEXT` (nullable) — stores the mapped `contentType` (`comic`/`manga`/`other`), not the raw slug.
- SQLite: add the column only if it does not exist (check `PRAGMA table_info`); PostgreSQL: `ADD COLUMN IF NOT EXISTS`. Idempotent; `CURRENT_APP_SCHEMA_VERSION` goes up to 4; export/import stays compatible (the new column is optional).
- `library`: `contentType` and `category` are stored in the existing `meta` JSON (no new column).
- The `updateQueueItem` function accepts a `category` field; `formatQueueRow` emits `category` (string or `null`). The SSE `item` event carries it automatically because it uses `formatQueueRow`.

## 7. API (documented in `docs/API.md` before implementation)

- `QueueItem.category`: `"comic" | "manga" | "other" | null`. `null` for site A and for items whose metadata has not been fetched yet.
- `LibraryItem.category`: the same values, from `meta`.
- No new endpoints.

## 8. UI

- Type badge (`Comic` / `Manga` / `Other`) in the list row, next to the source badge; items without a type have no badge.
- Sidebar: a **"Type"** section with `Comic`/`Manga`/`Other` filter chips with counts, shown when at least 1 type is present (same as the "Source" section). The type filter is combined (AND) with the status, source, batch, and search filters.
- Library Manager: type badge and a type filter dropdown next to the source filter.
- Pure helper in `webui/src/lib/sources.js` (or `contentType.js` in webui) with `node:test` tests.
- A pending item has no type until its metadata is fetched when its turn comes (accepted limitation).

## 9. Error handling

| Case | Behavior |
|---|---|
| Category not found / invalid | `contentType = null`, old folder layout, no error |
| Site C category request fails | warning in the activity log, `contentType = null`, download continues |
| Unknown category slug | type `other` |

## 10. Testing

1. `mapCategoryToType`: complete mapping table, uppercase, empty slug, invalid slug.
2. Boards category parser (HTML fixture) and site C (JSON fixture; a failed category request does not fail `fetchMeta`).
3. Engine: test galleries with category `manga` and `western` land in `Manga/...` and `Comic/...`; without a category the old layout is used; site A is unchanged; `findExistingOnDisk` finds items in the layout with a type.
4. Migration v4: a v3 DB with data → v4 without losing rows, idempotent, `category` column nullable; `formatQueueRow` emits `category`.
5. `rescanLibrary` recognizes markers in `Type/Language/Author/Title`.
6. UI helper + web UI build; `npm test` green.

## 11. Decisions made

- Doujinshi is mapped to `manga` (user decision).
- Site A stays without a type and in the old folder (proposal, not rejected by the user).
- The existing library is not moved automatically.
