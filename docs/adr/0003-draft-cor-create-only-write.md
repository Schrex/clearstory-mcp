# One write allowed: creating a draft COR, with a separate preview and create step

Narrows [ADR 0001](0001-read-only-enforced-in-server.md): the connector is read-only except for creating a draft COR. The Clearstory client allows exactly `POST /cors` (exact path, no query string) and still refuses every other non-GET (other paths, PATCH, PUT, DELETE) before any network call. Clearstory's API can't submit, send, approve or void a COR, so a person always reviews and sends the draft in Clearstory. A write is two tool calls: a preview that sends nothing to Clearstory, then a create that sends exactly what was previewed.

`POST /cors` has no idempotency key, so the client sorts every answer into three outcomes: **created** (2xx with the COR), **refused** (Clearstory answered and did not create it: 4xx, after one token refresh on 401 and Retry-After waits on 429) and **outcome unknown** (5xx, network error, timeout, or a 2xx we can't read). Outcome unknown is never retried, to avoid a second draft; the user is told to check Clearstory.

## Considered options

- **Stay read-only and have Claude prepare the COR for a person to type in.** Rejected: retyping estimate pricing into Clearstory is the work the team wants gone.
- **Retry 5xx/timeouts as reads do.** Rejected: a request that reached Clearstory may have created the draft, and a retry would duplicate it.
