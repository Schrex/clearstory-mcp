import { z } from "zod";
import type { ToolContext } from "../tools.js";
import type { Query } from "../clearstory.js";
import { hasJob, jobArgs, resolveJob, resolveJobId } from "../jobs.js";
import { dateRange, dayArg } from "../dates.js";
import { listArgs, listReply, pullAll, pullFiltered, pullPage } from "../paging.js";
import { COR_STATUS, NOT_VOID, VOID_STAGES, shapeCor, shapeLineItems, corStatus, tmTagIds, type CorStatus } from "../cors.js";
import { compact, day, hours, money, reply, type Rec } from "../util.js";

const SORT = { days_in_review: "daysInReview", date_submitted: "dateSubmitted", co_issue_date: "coIssueDate", updated: "updatedAt" } as const;
const STATUSES = Object.keys(COR_STATUS) as [CorStatus, ...CorStatus[]];

const reasonMatches = (c: Rec, q: string) => {
  const r = c.reasonCategory as Rec | null | undefined;
  const g = (r?.reasonCategoryGroup ?? c.reasonCategoryGroup) as Rec | null | undefined;
  return [r?.name, g?.name].some((n) => typeof n === "string" && n.toLowerCase().includes(q));
};

/** No linked T&M Tags (Clearstory's count, else its tag list). */
const hasNoTags = (c: Rec) => (typeof c.tmTagCount === "number" ? c.tmTagCount : tmTagIds(c).length) === 0;

export function registerCorTools({ server, cs }: ToolContext) {
  server.tool(
    "list_cors",
    "List CORs (latest revision of each) for a Job, a GC, or all Jobs. Inbox Sent (Schreiber's CORs to GCs) by default. Void (incl. Waived) CORs left out unless include_void or asked for by status/stage. Each COR carries status, Ball in Court, Days in Review, $ by status and its linked T&M Tag ids (tm_tag_ids; tm_tags_incomplete if Clearstory listed fewer than tm_tag_count). Page with skip/next_skip.",
    {
      inbox: z.enum(["sent", "received"]).optional().describe("sent (default) = Schreiber's CORs to GCs; received = CORs sent to Schreiber."),
      ...jobArgs,
      gc_id: z.number().int().positive().optional().describe("GC id (Sent inbox only)."),
      statuses: z.array(z.enum(STATUSES)).optional().describe("COR statuses to include. Void includes Waived."),
      stages: z.array(z.string()).optional().describe("Clearstory stages, e.g. owner_review, pricing, void, waived."),
      label_ids: z.array(z.number().int().positive()).optional().describe("Label ids (any match)."),
      reason_category: z.string().optional().describe("Part of the reason category (or its group) name."),
      has_tm_tags: z.boolean().optional().describe("true = only CORs with one or more linked T&M Tags; false = only CORs with none."),
      include_void: z.boolean().optional().describe("Also return Void (incl. Waived) CORs."),
      include_archived_jobs: z.boolean().optional().describe("Also return CORs on archived Jobs."),
      submitted_from: dayArg("Submitted on or after."),
      submitted_until: dayArg("Submitted on or before."),
      co_issued_from: dayArg("CO issue date on or after."),
      co_issued_until: dayArg("CO issue date on or before."),
      updated_from: dayArg("Updated on or after."),
      updated_until: dayArg("Updated on or before."),
      sort_by: z.enum(["days_in_review", "date_submitted", "co_issue_date", "updated"]).optional().describe("Sort, descending."),
      ...listArgs,
    },
    async (a) => {
      const submitted = dateRange(a, "submitted_from", "submitted_until");
      const coIssued = dateRange(a, "co_issued_from", "co_issued_until");
      const updated = dateRange(a, "updated_from", "updated_until");
      const inbox = a.inbox ?? "sent";

      const query: Query = {
        inbox,
        stages: a.stages?.length ? a.stages.join(",") : undefined,
        customerIds: a.gc_id,
        labelIds: a.label_ids?.length ? a.label_ids.join(",") : undefined,
        hasTags: a.has_tm_tags === true ? 1 : undefined,
        includeFromArchivedProjects: a.include_archived_jobs ? true : undefined,
        fromDateSubmitted: submitted.from, untilDateSubmitted: submitted.until,
        fromCOIssueDate: coIssued.from, untilCOIssueDate: coIssued.until,
        fromUpdatedAt: updated.from, untilUpdatedAt: updated.until,
        ...(a.sort_by ? { sortBy: SORT[a.sort_by], sortDirection: "desc" } : {}),
      };
      const askedVoid = a.include_void || a.statuses?.includes("Void") || a.stages?.some((s) => VOID_STAGES.includes(s.toLowerCase()));
      if (a.statuses?.length) query.statuses = a.statuses.map((s) => COR_STATUS[s]).join(",");
      else if (!askedVoid) query.statuses = NOT_VOID.join(",");

      if (hasJob(a)) {
        // Received CORs carry the sender's projectId, so match our Job by its job number instead.
        if (inbox === "received") query.companyJobNumber = a.job?.trim() || String((await resolveJob(cs, a)).jobNumber ?? "");
        else query.projectIds = await resolveJobId(cs, a);
      }

      const source = { path: "/cors", query };
      const page = { skip: a.skip, limit: a.limit };
      // Filters Clearstory lacks (reason category; "no T&M Tags", as hasTags only takes 1): read all, filter, page here.
      const keep: ((c: Rec) => boolean)[] = [];
      const reason = a.reason_category?.trim().toLowerCase();
      if (reason) keep.push((c) => reasonMatches(c, reason));
      if (a.has_tm_tags === false) keep.push(hasNoTags);
      const p = keep.length
        ? await pullFiltered<Rec>(cs, source, (c) => keep.every((k) => k(c)), page)
        : await pullPage<Rec>(cs, source, page);
      return reply(listReply("cors", p, (c) => shapeCor(c, a.detail)));
    },
  );

  server.tool(
    "get_cor",
    "One COR in full: description, status, Ball in Court, Days in Review, $ by status, hours ST/OT/DT, LMEO line items (labor, materials, equipment, other, plus markups), and linked T&M Tags. detail adds labels, dates and the revision history.",
    {
      id: z.union([z.number().int().positive(), z.string().min(1)]).describe("COR id (from list_cors) or UUID."),
      detail: z.boolean().optional().describe("true = also labels, dates and revision history."),
    },
    async (a) => {
      const id = encodeURIComponent(String(a.id));
      const c = await cs.get<Rec>(`/cors/${id}`);
      const li = (c.lineItems as Rec | null | undefined) ?? await cs.get<Rec>(`/cors/${id}/line-items`);
      const full = shapeCor(c, true);
      const out: Rec = {
        ...(a.detail ? full : { ...shapeCor(c), tm_tags: full.tm_tags }),
        ...compact({ description: c.description }),
        hours: compact({ st: hours(c.totalHoursST), ot: hours(c.totalHoursOT), dt: hours(c.totalHoursDT), total: hours(c.totalHours) }),
        line_items: shapeLineItems(li ?? {}),
      };
      if (!a.detail) return reply(out);
      const revs = await pullAll<Rec>(cs, { path: `/cors/${id}/revisions` });
      out.revisions = revs.records.map((r) => compact({
        id: r.id, revision: r.version, latest: r.isLatestVersion, status: corStatus(r.status),
        requested_amount: money(r.requestedAmount), date_submitted: day(r.dateSubmitted), updated_at: r.updatedAt,
      }));
      if (revs.scope === "partial") out.revisions_scope = "partial";
      return reply(out);
    },
  );
}
