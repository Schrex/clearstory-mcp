// Shared list behaviour for every list tool: skip/next_skip paging over Clearstory's limit/offset
// (≤ pageSize, max 100 per request), concatenation across sources, and scope: complete | partial
// when the per-invocation subrequest budget stops a pull early.
import { z } from "zod";
import { BudgetError, type ClearstoryClient, type Query } from "./clearstory.js";
import type { Rec } from "./util.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;

/** zod shape every list tool spreads into its input. */
export const listArgs = {
  skip: z.number().int().min(0).optional().describe("Records to skip; pass the previous reply's next_skip to get the next page."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max records to return (default ${DEFAULT_LIMIT}).`),
  detail: z.boolean().optional().describe("true = full records; default compact."),
};

/** One Clearstory list endpoint (returns a ListEnvelope: { count, limit, offset, records }). */
export interface Source { path: string; query?: Query }

export interface Pulled<T = Rec> {
  records: T[];
  /** Total matching across all sources, when Clearstory reported it for every source. */
  total_matching?: number;
  skip: number;
  /** Set when more records exist (or may exist) after this page. */
  next_skip?: number;
  /** partial = the subrequest budget stopped the pull early; totals over `records` are not complete. */
  scope: "complete" | "partial";
}

type Envelope<T> = { count?: number; records?: T[] };

/**
 * Pull up to `limit` records starting at `skip` from one or more list endpoints, read in order as one list
 * (e.g. unarchived then archived Jobs). Pages sequentially. A budget stop after at least one page
 * returns what was read with scope "partial"; a budget stop before any page rethrows.
 */
export async function pullPage<T = Rec>(cs: ClearstoryClient, sources: Source | Source[], opts: { skip?: number; limit?: number } = {}): Promise<Pulled<T>> {
  const list = Array.isArray(sources) ? sources : [sources];
  const skip = opts.skip ?? 0;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const records: T[] = [];
  let toSkip = skip; // records still to skip, carried across sources
  let total: number | undefined = 0;
  let more = false;
  let partial = false;
  let pages = 0;

  outer: for (let i = 0; i < list.length; i++) {
    const { path, query = {} } = list[i];
    if (records.length >= limit) { more = true; total = undefined; break; } // unread sources may hold more
    let offset = toSkip;
    let srcTotal: number | undefined;
    for (;;) {
      const want = Math.min(cs.pageSize, limit - records.length);
      let env: Envelope<T>;
      try {
        env = (await cs.get<Envelope<T>>(path, { ...query, limit: want, offset })) ?? {};
      } catch (e) {
        if (e instanceof BudgetError && pages > 0) { partial = true; break outer; }
        throw e;
      }
      pages++;
      const recs = env.records ?? [];
      if (typeof env.count === "number") srcTotal = env.count;
      records.push(...recs);
      offset += recs.length;
      const exhausted = recs.length < want || (srcTotal !== undefined && offset >= srcTotal);
      if (exhausted) break;
      if (records.length >= limit) { more = true; break; }
    }
    total = total === undefined || srcTotal === undefined ? undefined : total + srcTotal;
    toSkip = srcTotal === undefined ? 0 : Math.max(0, toSkip - srcTotal);
    if (more) { if (i < list.length - 1) total = undefined; break; }
  }

  const out: Pulled<T> = { records, skip, scope: partial ? "partial" : "complete" };
  if (total !== undefined && !partial) out.total_matching = total;
  if (more || partial || (total !== undefined && skip + records.length < total)) out.next_skip = skip + records.length;
  return out;
}

/** Pull every record (for totals/aggregations), up to the subrequest budget; check `scope`. */
export const pullAll = <T = Rec>(cs: ClearstoryClient, sources: Source | Source[]) =>
  pullPage<T>(cs, sources, { skip: 0, limit: Number.MAX_SAFE_INTEGER });

/**
 * skip/limit over a list already read whole (an unpaged endpoint, or records filtered in the connector).
 * `scope` is the read's scope: total_matching only when complete.
 */
export function localPage<T = Rec>(all: T[], o: { skip?: number; limit?: number }, scope: Pulled["scope"] = "complete"): Pulled<T> {
  const skip = o.skip ?? 0;
  const records = all.slice(skip, skip + (o.limit ?? DEFAULT_LIMIT));
  const end = skip + records.length;
  const out: Pulled<T> = { records, skip, scope };
  if (scope === "complete") out.total_matching = all.length;
  if (end < all.length) out.next_skip = end;
  return out;
}

/** Pull every record from `sources`, keep those matching `keep`, and page the result locally. */
export async function pullFiltered<T = Rec>(cs: ClearstoryClient, sources: Source | Source[], keep: (r: T) => boolean, page: { skip?: number; limit?: number }): Promise<Pulled<T>> {
  const all = await pullAll<T>(cs, sources);
  return localPage(all.records.filter(keep), page, all.scope);
}

/** Standard list reply: { total_matching, returned, skip, next_skip, scope, [key]: shaped records }. */
export function listReply<T>(key: string, p: Pulled<T>, shape: (r: T) => unknown) {
  return {
    total_matching: p.total_matching,
    returned: p.records.length,
    skip: p.skip,
    next_skip: p.next_skip,
    scope: p.scope,
    ...(p.scope === "partial" ? { note: "Stopped early at the Clearstory request limit; narrow the search or page with next_skip." } : {}),
    [key]: p.records.map(shape),
  };
}
