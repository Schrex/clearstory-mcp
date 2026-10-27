// COR log summary (from Clearstory's own /cors/overview and /cors/contract-summary) and COR aging
// (computed from pulled CORs). Exposure = In Review $ + Approved to Proceed $; Void never counted.
import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { BudgetError, type Query } from "../clearstory.js";
import { hasJob, jobArgs, resolveJob, resolveJobId } from "../jobs.js";
import { dayArg, parseDay } from "../dates.js";
import { pullAll } from "../paging.js";
import { COR_STATUS, NOT_VOID, PLACEHOLDER, ballInCourt, corStatus } from "../cors.js";
import { compact, day, money, reply, type Rec } from "../util.js";

const exposureOf = (inReview: unknown, atp: unknown) => money((money(inReview) ?? 0) + (money(atp) ?? 0));

/** CORContractSummary → per-contract totals in GLOSSARY terms (Void dropped). */
function shapeContract(id: number, name: unknown, s: Rec): Rec {
  const v = (s.contractSummaryValues as Rec | undefined) ?? {};
  const by: Rec = {};
  for (const k of NOT_VOID) if (k !== PLACEHOLDER || v[k]) by[corStatus(k)!] = money(v[k]) ?? 0;
  return {
    ...compact({
      contract_id: id, contract: name,
      original_contract_value: money(s.originalContractValue), pending_contract_value: money(s.pendingContractValue),
    }),
    exposure: exposureOf(v[COR_STATUS["In Review"]], v[COR_STATUS["Approved to Proceed"]]),
    by_status_amount: by,
  };
}

/** Aging buckets (days in review, inclusive upper bounds); Stale COR = more than 30 days. */
const BUCKETS = [["0-14", 14], ["15-30", 30], ["31-60", 60], ["60+", Infinity]] as const;
const STALE_AFTER = 30;
const bucketOf = (d: number) => BUCKETS.find(([, max]) => d <= max)![0];
const emptyBuckets = () => Object.fromEntries(BUCKETS.map(([k]) => [k, { count: 0, amount: 0 }])) as Record<string, { count: number; amount: number }>;
const DAY_MS = 864e5;

/** Clearstory's daysInReview when present, else whole calendar days (UTC) from submission to as-of. */
function daysInReview(c: Rec, asOfMs: number): number | undefined {
  if (typeof c.daysInReview === "number") return c.daysInReview;
  const t = typeof c.dateSubmitted === "string" ? Date.parse(`${c.dateSubmitted.slice(0, 10)}T00:00:00.000Z`) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((asOfMs - t) / DAY_MS)) : undefined;
}

export function registerSummaryTools({ server, cs }: ToolContext) {
  server.tool(
    "get_cor_aging",
    "COR aging for Schreiber's Sent CORs on a Job, a GC or all Jobs: In Review CORs bucketed by Days in Review (0-14, 15-30, 31-60, 60+), Stale CORs (more than 30 days) flagged, grouped by GC with Ball in Court and Exposure (In Review $ + Approved to Proceed $) per GC, biggest Exposure first. Void excluded. scope: partial means the pull stopped at the Clearstory request limit and totals are incomplete.",
    {
      ...jobArgs,
      gc_id: z.number().int().positive().optional().describe("GC id (from list_gcs)."),
      include_archived_jobs: z.boolean().optional().describe("Also count CORs on archived Jobs."),
      as_of: dayArg("Age CORs as of this date (default today, UTC)."),
    },
    async (a) => {
      const asOf = a.as_of ? parseDay("as_of", a.as_of) : new Date().toISOString().slice(0, 10);
      const asOfMs = Date.parse(`${asOf}T00:00:00.000Z`);
      // Approved to Proceed pulled too (not aged) so Exposure per GC is complete; Void never pulled.
      const query: Query = {
        inbox: "sent", statuses: `${COR_STATUS["In Review"]},${COR_STATUS["Approved to Proceed"]}`,
        customerIds: a.gc_id, includeFromArchivedProjects: a.include_archived_jobs ? true : undefined,
      };
      if (hasJob(a)) query.projectIds = await resolveJobId(cs, a);
      const pulled = await pullAll<Rec>(cs, { path: "/cors", query });

      const buckets = emptyBuckets();
      const stale = { count: 0, amount: 0 };
      const groups = new Map<string, Rec & { cors: Rec[]; ball_in_court: Record<string, number> }>();
      for (const c of pulled.records) {
        const gc = c.customer as Rec | undefined;
        const name = String(gc?.name ?? c.customerName ?? "Unknown GC");
        const key = String(gc?.id ?? name);
        let g = groups.get(key);
        if (!g) {
          g = { gc: name, gc_id: gc?.id, exposure: 0, in_review_amount: 0, approved_to_proceed_amount: 0, in_review_count: 0, stale_count: 0, ball_in_court: {}, cors: [] };
          groups.set(key, g);
        }
        const inReviewAmt = money(c.inReviewAmount ?? c.requestedAmount) ?? 0;
        if (c.status === COR_STATUS["Approved to Proceed"]) {
          g.approved_to_proceed_amount = money((g.approved_to_proceed_amount as number) + (money(c.approvedToProceedAmount) ?? 0));
          continue;
        }
        const d = daysInReview(c, asOfMs) ?? 0;
        const bucket = bucketOf(d);
        const isStale = d > STALE_AFTER;
        buckets[bucket].count++;
        buckets[bucket].amount = money(buckets[bucket].amount + inReviewAmt)!;
        if (isStale) { stale.count++; stale.amount = money(stale.amount + inReviewAmt)!; g.stale_count = (g.stale_count as number) + 1; }
        g.in_review_count = (g.in_review_count as number) + 1;
        g.in_review_amount = money((g.in_review_amount as number) + inReviewAmt);
        const ball = ballInCourt(c.ballInCourt) ?? "Nobody";
        g.ball_in_court[ball] = (g.ball_in_court[ball] ?? 0) + 1;
        g.cors.push(compact({
          id: c.id, cor_number: c.corNumber, title: c.title, job_number: c.jobNumber, job_name: c.projectName,
          days_in_review: d, bucket, stale: isStale, ball_in_court: ballInCourt(c.ballInCourt), in_review_amount: inReviewAmt,
          date_submitted: day(c.dateSubmitted),
        }));
      }
      const gcs = [...groups.values()].map((g) => {
        g.exposure = exposureOf(g.in_review_amount, g.approved_to_proceed_amount);
        g.cors.sort((x, y) => (y.days_in_review as number) - (x.days_in_review as number));
        return g;
      }).sort((x, y) => (y.exposure as number) - (x.exposure as number));
      const exposure = money(gcs.reduce((s, g) => s + (g.exposure as number), 0));

      return reply({
        as_of: asOf,
        exposure,
        in_review: { count: gcs.reduce((s, g) => s + (g.in_review_count as number), 0), amount: money(gcs.reduce((s, g) => s + (g.in_review_amount as number), 0)) },
        stale,
        buckets,
        gcs,
        scope: pulled.scope,
        ...(pulled.scope === "partial" ? { note: "Stopped early at the Clearstory request limit; totals are incomplete. Narrow to a Job or GC." } : {}),
      });
    },
  );

  server.tool(
    "get_cor_log_summary",
    "COR log summary (Schreiber's Sent CORs) for a Job, a contract, a GC or all Jobs: Exposure (In Review $ + Approved to Proceed $) as the headline, $ and counts per status, average Days in Review, and totals per contract when a Job or contract is given. Void (incl. Waived) CORs are left out. Numbers are Clearstory's own COR log totals (latest revision only).",
    {
      ...jobArgs,
      contract_id: z.number().int().positive().optional().describe("Clearstory contract id (from get_job)."),
      gc_id: z.number().int().positive().optional().describe("GC id (from list_gcs)."),
    },
    async (a) => {
      const query: Query = { inbox: "sent", statuses: NOT_VOID.join(","), customerIds: a.gc_id, contractIds: a.contract_id };
      let job: Rec | undefined;
      if (hasJob(a)) {
        job = await resolveJob(cs, a);
        query.projectIds = job.id as number;
      }
      const o = await cs.get<Rec>("/cors/overview", query);
      const by_status: Rec = {};
      for (const s of NOT_VOID) {
        const v = o[s] as Rec | undefined;
        if (!v || (s === PLACEHOLDER && !v.totalCount)) continue;
        by_status[corStatus(s)!] = { count: v.totalCount ?? 0, amount: money(v.totalAmount) ?? 0 };
      }
      const amt = (s: string) => (o[s] as Rec | undefined)?.totalAmount;

      // Totals per contract: the asked-for contract, else each of the Job's contracts.
      let contracts: Rec[] | undefined;
      let partial = false;
      const list: { id: number; name?: unknown }[] = a.contract_id !== undefined ? [{ id: a.contract_id }]
        : job ? ((job.contracts as Rec[] | undefined) ?? (job.contractWithCustomer ? [job.contractWithCustomer as Rec] : []))
          .map((c) => ({ id: c.id as number, name: c.name }))
        : [];
      if (list.length) {
        contracts = [];
        for (const c of list) {
          let s: Rec | undefined;
          try {
            s = await cs.get<Rec>("/cors/contract-summary", { inbox: "sent", projectIds: query.projectIds, contractIds: c.id });
          } catch (e) {
            if (e instanceof BudgetError) { partial = true; break; }
            throw e;
          }
          contracts.push(shapeContract(c.id, c.name, s ?? {}));
        }
      }

      return reply({
        ...(job ? compact({ job_id: job.id, job_number: job.jobNumber, job_name: job.projectTitle }) : {}),
        exposure: exposureOf(amt(COR_STATUS["In Review"]), amt(COR_STATUS["Approved to Proceed"])),
        cor_count: o.totalCount,
        average_days_in_review: typeof o.averageDaysInReview === "number" ? Math.round(o.averageDaysInReview * 10) / 10 : undefined,
        by_status,
        contracts,
        scope: partial ? "partial" : "complete",
        ...(partial ? { note: "Stopped early at the Clearstory request limit; per-contract totals are incomplete. Ask for one contract_id." } : {}),
      });
    },
  );
}
