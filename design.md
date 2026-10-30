# Clearstory connector for Claude Team: design (v0.1 proposal, 2026-10-27)

Read-only MCP server for Clearstory (change orders, T&M tags), built the same way as `../hcss-heavyjob-mcp`: Cloudflare Workers **Free** plan, stateless Streamable HTTP, OAuth 2.1 team sign-in (`@cloudflare/workers-oauth-provider`), `ALLOWED_USER_EMAIL` + PBKDF2 password, `TOKEN_EPOCH` revoke, Anthropic IP allowlist on `/mcp`, one-time KV export links. Worker name proposal: `schrex-clearstory-mcp`.

Source: Clearstory's public OpenAPI 2.0 spec at https://io.clearstory.build/clearstory/docs/swagger.json (Redoc UI at `/clearstory/docs`), fetched 2026-10-27, copy in [reference/](reference/clearstory-swagger-2026-10-27.json). Help center: https://knowledge.clearstory.build/using-the-clearstory-api and https://knowledge.clearstory.build/move-to-the-new-clearstory-api. No endpoint below is invented.

## Clearstory API (VERIFIED from spec/help center unless noted)
- Base: `https://io.clearstory.build/clearstory/v1`. Legacy `web-api.clearstory.build` (Basic auth keys) shuts off **after 2026-12-15**; build only on the new API.
- Auth: OAuth2 client credentials. `POST https://auth.clearstory.build/oauth/token` with `grant_type=client_credentials`, `client_id`, `client_secret`, `audience=https://io.clearstory.build` (must match exactly). Bearer token, `expires_in` 24 h default.
- **No scopes.** The app acts as the whole company with read *and* write. Write protection must be enforced by us: `clearstory.ts` allows GET plus exactly one write, `POST /cors` (draft COR create, [ADR 0003](docs/adr/0003-draft-cor-create-only-write.md)); every other POST/PATCH/DELETE is refused before sending.
- `User-Agent` header required (blank → 400). Errors: 401 bad token, 422 validation (e.g. `take=0`), 429 throttled (token URL too) with `Retry-After`.
- Credentials: Account Owner only, Professional plan only, Settings > Advanced Settings > Web API Applications. Max 3 apps; secret shown once.
- Paging: `limit`/`offset` (aliases `take`/`skip`), 1–100 per page. Most lists take `fromUpdatedAt`/`untilUpdatedAt` (ISO-8601, UTC default).
- Rate limits: no numbers published (UNVERIFIED). Help center warns against new token per call and top-of-hour bursts.
- `inbox=sent|received` on CORs, tags, change notifications. Schreiber as a sub mostly **sends** CORs/tags to GCs; **received** = what Schreiber's own subs/vendors send it, and GC change notifications (pricing requests, T&M authorizations).

## Data model (key fields)
- **Project**: id, projectTitle, jobNumber, customerJobNumber, customer, contractValue, office, division, start/endDate, archived, contracts[].
- **Contract**: id, name, contractValue, contractorProject / customerProject (links the sub's and GC's copies).
- **COR**: id, corNumber, title, status (`in_review`, `approved_to_proceed`, `approved_co_issued`, `rejected` (= "Void"), `placeholder`), stage (e.g. `void`, `waived`), ballInCourt, requestedAmount, inReviewAmount, approvedToProceedAmount, approvedCoIssuedAmount, voidAmount, dateSubmitted, daysInReview, coIssueDate, customerCoNumber, customerReferenceNumber, reasonCategory, responsibleParty, labels, tmTags[], percentComplete, version/originalCorId (revision chain). Detail adds description and hours ST/OT/DT/PST/PDT. Line items = LMEO (labor/material/equipment/other) lines: description, quantity, unit, rate, total, internalId.
- **T&M tag**: id, number, title, status (`draft`, `open`, `awaiting_signature`, `signed`, `signed_not_sent`, `rejected`, `revise_and_resubmit`), dateOfWorkPerformed, costCode, customerSignerName, signedAt, totalHours by ST/OT/DT, workDescription, **hcssTimecardId** (source HeavyJob time card when made via the HeavyJob integration), attachmentSignedUrl. Detail has labor/material/equipment/other items.
- **Change notification** (GC → sub): type `pricing_request` or `authorize_tm_work`, dueDate, status, hasResponded, noCostImpact, linked COR.
- **Overview** (`/cors/overview`): per-status count and $, totalRequestedAmount, totalAmountRemaining, averageDaysInReview, valueCompleted, margin, labor ST/OT/DT. **Contract summary** (`/cors/contract-summary`): $ by status per contract.
- Reference: offices, divisions, users, customers, labels, reason categories, rates (`labor|material|equipment|other`, company and per project).

## Tools (proposed)
| Tool | Clearstory endpoint(s) | What it answers |
|---|---|---|
| get_company | GET /company | Connection check, company name/id |
| list_offices | GET /offices, GET /divisions | Office/division ids for filters |
| search_jobs | GET /projects (searchTitle, jobNumber, archived, fromUpdatedAt) | Find a Job by name or **job number** (same as HeavyJob job code, confirmed by user 2026-10-27) |
| get_job | GET /projects/{id} + GET /contracts?projectId + GET /projects/{id}/integrations | Contract value, customer, GC contracts, whether Procore/HCSS sync is on |
| list_cors | GET /cors (inbox, projectIds/jobNumber, statuses, stages, labelIds, hasTags, dateSubmitted / coIssueDate / updatedAt ranges, sortBy daysInReview) | "Open CORs on job X", "everything approved last month" |
| get_cor | GET /cors/{id} (+ /line-items, /revisions on `detail`) | Full COR with LMEO lines, hours, revision history |
| get_cor_log_summary | GET /cors/overview + GET /cors/contract-summary | $ in review vs approved vs void per job/contract; avg days in review |
| get_cor_aging | GET /cors (statuses=in_review, sorted by daysInReview; server-side buckets 0-14/15-30/31-60/60+) | Stale CORs, ball in court, $ at risk, by GC |
| list_tm_tags | GET /tags (inbox, status, projectIds, jobNumber, dateOfWorkPerformed, updatedAt range) | Unsigned tags, tags by day, `hcssTimecardId` link |
| list_unbilled_tm_tags | GET /cors (hasTags=1, non-Void) + GET /tags (status signed, signed_not_sent; work-date window, default 60 d); KV read of `cor-source:<jobId>:tag:<id>` | Unbilled T&M stage "Signed, not on a COR" in one call: tags, hours, days since signed, totals per Job, oldest first; tags in the source ledger listed as `on_draft_cor` (drafts aren't in `GET /cors`); no $ (not on the tag list); `scope: partial` when capped (#22) |
| get_tm_tag | GET /tags/{id} | Labor/material/equipment items, signer, signed PDF link |
| list_change_notifications | GET /change-notifications (inbox=received default, types, due date range) | GC pricing requests and T&M authorizations, which are overdue / not responded |
| get_change_notification | GET /change-notifications/{id} | Detail + linked COR |
| list_gcs | GET /customers | GC list, internal ids |
| list_rates | GET /rates/{type} or /rates/project/{projectId}/{type} | Labor/equipment rates used for pricing (check vs HeavyJob pay classes) |
| list_reference | GET /labels, GET /reason-categories, GET /users | Label/reason/user ids for filters |
| preview_draft_cor | GET /projects, /contracts, /cors; KV `cor-preview:<id>` (15 min), ledgers `cor-created:<jobId>:<title>` and `cor-source:<jobId>:<hb:estimate:item \| tag:id>` | Draft COR preview (checks, contract + duplicate warnings by title and by `sources`: HeavyBid bid items, T&M Tag ids on a non-Void COR or in the source ledger; sources in the footer; `preview_id` for `create_draft_cor`); no Clearstory write (#14, #20) |
| create_draft_cor | POST /cors (body from the stored preview); no lookup on unknown outcome (`GET /cors` does not list drafts); KV ledgers `cor-created:<jobId>:<title>` (30 d) and `cor-source:…` per source (365 d), on created/unknown only | Creates the previewed draft COR (`preview_id` only, single use); never retried, unknown outcome → user checks the Job's Draft COR Log in Clearstory (#15, #19, #20) |

Deferred to v0.2: `export_cor_log` (list_cors + line items → xlsx/csv in KV, single-use 15-min link).

Defaults (agreed 2026-10-27): inbox `sent`; Void/Waived CORs and archived Jobs excluded unless asked; Stale COR = In Review > 30 days; aging buckets 0–14 / 15–30 / 31–60 / 60+; **Exposure** (In Review $ + Approved to Proceed $) is the headline number on `get_cor_log_summary` and `get_cor_aging`. Terms per [GLOSSARY.md](GLOSSARY.md).

Deliberately **not** exposed (write): POST /tags, PATCH/DELETE /tags/{id}, POST/PATCH /customers, POST/PATCH /projects, project users/integrations, COR labels, POST /change-notifications, POST /attachments. Candidate for later with confirmation: `create_tm_tag` (drafts only, never send).

## Cross-system (HeavyJob + Clearstory): Unbilled T&M (priority 1)
v0.1: Claude joins the two connectors (decided, [ADR 0002](docs/adr/0002-separate-worker-from-heavyjob.md)); combined reconcile tool deferred.
- T&M Work = HeavyJob time-card hours on cost codes with `isTm` (VERIFIED: HeavyJob connector already returns `is_tm`).
- Match to T&M Tags by `hcssTimecardId` (certain); fallback Job + work date + cost code = **probable**, never certain.
- Report by stage: Untagged → Unsigned → Signed, not on a COR → On a COR, not approved.
- Default window: last 60 days of work dates; per-Job pull recommended.
- `list_tm_tags` must return `hcss_timecard_id` (Clearstory `hcssTimecardId`), cost code, work date, status, and take a `work_date_from`/`work_date_until` window (main or additional work dates); `list_cors` with `hasTags=1` must return each COR's tag ids so "Signed, not on a COR" is computable. (UNVERIFIED that `tmTags[]` on CORs lists every linked tag; check with a real token.)
- Priority 2: COR aging / Exposure. Priority 3: reporting/export (v0.2).

## Lessons applied from HeavyJob
Accept job **number** as well as id; trimmed codes; compact default records with `detail`; `skip`/`next_skip` paging with totals labelled `scope: partial` when capped; money 2 dp, hours 4 dp; strict `YYYY-MM-DD` (converted to ISO `…T00:00:00Z` / end-of-day for `until*`); Clearstory 4xx bodies passed through (500 chars); not-found → close matches.

## Free-plan limits
- **Subrequests (50; budget 45):** page size max 100 → ~4,000 rows per pull. Fine for one job; company-wide COR history may hit the cap → `scope: partial`, narrow by date/job, or use `/cors/overview` (one call) for totals.
- **Token:** 24 h token; cache in KV (not just isolate memory) so cold isolates don't hit the token URL, which Clearstory throttles. UNVERIFIED how aggressive.
- **429:** honor `Retry-After`, ≤4 tries, sequential paging.

## Decided (2026-10-27)
- Team access (2026-10-28): `ALLOWED_USER_EMAIL` = the same 6 named @schrex.com emails as HeavyJob (zach, dave, prasad, ryan, sumanth, jeri) + one shared team password (Bitwarden item "ClearStory MCP connector", "HCSS Connectors" collection); sign-in lasts 90 days (refresh TTL), access tokens 1 h. Email is not verified, so the password is the gate. Revoke everyone: rotate `TOKEN_EPOCH` (+ password via `scripts/set-password.sh`). Changing the password alone signs no one out.
- Read-only v0.1 ([ADR 0001](docs/adr/0001-read-only-enforced-in-server.md)).
- v0.2 draft COR ([ADR 0003](docs/adr/0003-draft-cor-create-only-write.md)): `preview_draft_cor` then `create_draft_cor`, the only write (POST /cors, never sent to the GC); every signed-in user may create, for now; amount cap per draft COR 250,000 by default (`MAX_DRAFT_COR_AMOUNT`). Pricing (2026-10-30): default HeavyBid bid price × quantity; markup, cost basis or actual HeavyJob hours only when the PM asks in chat; PM reviews the preview and confirms; math goes in the COR description.
- Draft COR live check (2026-10-30, J2610, COR id 2030894): `POST /cors` returned 201 with id, COR number (`3`, assigned at create) and status `Draft`; `amount` landed as `requestedAmount`. `GET /cors` does **not** list drafts (only `GET /cors/{id}` finds them), so the KV ledger is the only duplicate check for drafts. The draft opens in Clearstory's **Upload COR** form: Job, COR number, title, requested total, T&M Tags, customer reference, one PDF. No line items and no description field on that form, so the line-item breakdown must go in an attached PDF if the GC is to see it. Drafts are deleted from the Draft COR Log (trash icon).
- How CORs are priced today (2026-10-30, 6 CORs reviewed): (a) change built as new bid items in the Job's "-PM" HeavyBid estimate (e.g. J2611-PM 20505 = COR 8 New Rink Drainage; unit price per line = activity direct cost × bid item markup, matched to the cent), (b) T&M Tags at role/equipment rates +10%, (c) material invoices + PM hours +10%, (d) lump sum.
- Schreiber is mainly a sub: default inbox `sent`.
- Confirmed in Clearstory settings 2026-10-27: plan **Professional**, company type **Subcontractor**.
- Web API Application `Schreiber Claude MCP` created 2026-10-27 by Sumanth; `CLEARSTORY_CLIENT_ID` / `CLEARSTORY_CLIENT_SECRET` set as Worker secrets.
- Believed true (verify on first token): HeavyJob → Clearstory T&M integration on; job numbers equal HeavyJob job codes.

## Open
1. Deploy: real KV namespace id in wrangler.toml; secrets `ALLOWED_USER_EMAIL`, `ACCESS_PASSWORD_HASH`, `TOKEN_EPOCH`; then live check (#8).
2. Verify with a real token: `/cors/overview` and `contract-summary` shapes, COR `tmTags[]` completeness, actual rate limits.
