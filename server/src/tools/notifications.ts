import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { hasJob, jobArgs, resolveJobId } from "../jobs.js";
import { listArgs, listReply, pullAll, pullFiltered, pullPage } from "../paging.js";
import { dateRange, dayArg } from "../dates.js";
import { shapeLinkedCor } from "../cors.js";
import { compact, day, money, personName, reply, type Rec } from "../util.js";

const TYPES = { pricing_request: "Pricing Request", authorize_tm_work: "Authorize T&M Work" } as const;
const typeLabel = (t: unknown) => TYPES[t as keyof typeof TYPES] ?? t;

/** Overdue = due date has passed and not responded. */
const isOverdue = (due: unknown, responded: boolean, now: number) =>
  !responded && typeof due === "string" && Number.isFinite(Date.parse(due)) && Date.parse(due) < now;

/** Received (definitions.ChangeNotificationContractorView) → Change Notification in GLOSSARY terms. */
function shapeReceived(v: Rec, now: number, detail = false): Rec {
  const cn = (v.changeNotification ?? {}) as Rec;
  const gc = cn.customer as Rec | undefined;
  const contract = v.contract as Rec | undefined;
  const responded = v.hasResponded === true;
  return compact({
    id: cn.id, contract_id: v.contractId, job_id: v.projectId,
    gc: gc?.name, gc_reference: cn.customerReferenceNumber,
    type: typeLabel(cn.type), title: cn.title,
    date_received: day(cn.dateReceived), due_date: day(cn.dueDate),
    responded, overdue: isOverdue(cn.dueDate, responded, now),
    no_cost_impact: v.noCostImpact === true ? true : undefined,
    cor: shapeLinkedCor(v.cor, detail),
    ...(detail ? {
      contract: contract?.name, description: cn.description, message: cn.emailMessage, sent_by: personName(cn.sentBy),
      due_at: cn.dueDate, updated_at: cn.updatedAt,
    } : {}),
  });
}

/** Sent (definitions.ChangeNotificationSent / Detail): Schreiber acting as GC to its own subs. */
function shapeSent(s: Rec, now: number, detail = false): Rec {
  const job = s.project as Rec | undefined;
  const responses = (s.responses as Rec[] | undefined) ?? [];
  const submitted = typeof s.totalSubmitted === "number" ? s.totalSubmitted : responses.length;
  const answered = typeof s.totalResponded === "number" ? s.totalResponded : responses.filter((r) => r.hasResponded === true).length;
  const responded = submitted > 0 && answered >= submitted;
  return compact({
    id: s.id, job_id: job?.id, job_number: job?.jobNumber, job_name: job?.projectTitle,
    reference: s.customerReferenceNumber, type: typeLabel(s.type), title: s.title, status: s.status,
    date_submitted: day(s.dateSubmitted), due_date: day(s.dueDate),
    responded, responded_count: `${answered} of ${submitted}`, overdue: isOverdue(s.dueDate, responded, now),
    ...(detail ? {
      replies: responses.map((r) => compact({
        contract_id: r.contractId, contract: (r.contract as Rec | undefined)?.name,
        responded: r.hasResponded === true, no_cost_impact: r.noCostImpact === true ? true : undefined, cor: shapeLinkedCor(r.cor, detail),
      })),
      description: s.description, message: s.emailMessage, sent_by: personName(s.sentBy),
      estimate: money(s.estimate), projected_cost: money(s.projectedCost), cost_impact: money(s.costImpact),
      due_at: s.dueDate, updated_at: s.updatedAt,
    } : {}),
  });
}

const inboxArg = z.enum(["received", "sent"]).optional();

export function registerNotificationTools({ server, cs }: ToolContext) {
  server.tool(
    "list_change_notifications",
    "List Change Notifications: a GC's request to Schreiber to price a change (Pricing Request) or to authorize T&M work. Received inbox by default (sent to Schreiber); sent = ones Schreiber sent to its own subs. Each shows type, due date, whether Schreiber responded, overdue (due date passed and not responded) and the COR it was answered with. Soonest due first; page with skip/next_skip.",
    {
      inbox: inboxArg.describe("received (default) or sent."),
      type: z.enum(["Pricing Request", "Authorize T&M Work"]).optional().describe("Only this type."),
      ...jobArgs,
      due_from: dayArg("Due on or after."),
      due_until: dayArg("Due on or before."),
      submitted_from: dayArg("Sent by the GC on or after."),
      submitted_until: dayArg("Sent by the GC on or before."),
      ...listArgs,
    },
    async (a) => {
      const inbox = a.inbox ?? "received";
      const due = dateRange(a, "due_from", "due_until");
      const sub = dateRange(a, "submitted_from", "submitted_until");
      const type = a.type && (Object.keys(TYPES) as (keyof typeof TYPES)[]).find((k) => TYPES[k] === a.type);
      const jobId = hasJob(a) ? await resolveJobId(cs, a) : undefined;
      const query = {
        inbox, // Clearstory returns an empty list when inbox is omitted
        types: type,
        // Sent: Schreiber's own Job id. Received records carry the GC's projectId, so match on contracts below.
        projectIds: inbox === "sent" ? jobId : undefined,
        fromDueDate: due.from, untilDueDate: due.until, fromDateSubmitted: sub.from, untilDateSubmitted: sub.until,
        sortBy: "dueDate", sortDirection: "asc",
      };
      const source = { path: "/change-notifications", query };
      const page = { skip: a.skip, limit: a.limit };
      let p;
      if (inbox === "received" && jobId !== undefined) {
        // Clearstory's contractIds filter is Sent-only: filter on the Job's contracts here.
        const contracts = await pullAll<Rec>(cs, { path: "/contracts", query: { projectId: jobId } });
        const ids = new Set(contracts.records.map((c) => c.id));
        p = await pullFiltered<Rec>(cs, source, (r) => ids.has(r.contractId), page);
        if (contracts.scope === "partial") { p.scope = "partial"; delete p.total_matching; }
      } else {
        p = await pullPage<Rec>(cs, source, page);
      }
      const now = Date.now();
      const shaped = p.records.map((r) => inbox === "sent" ? shapeSent(r, now, a.detail) : shapeReceived(r, now, a.detail));
      const overdue = shaped.filter((c) => c.overdue === true).length;
      return reply({ inbox, overdue_count: overdue, ...listReply("change_notifications", { ...p, records: shaped }, (c) => c) });
    },
  );

  server.tool(
    "get_change_notification",
    "One Change Notification in full: type, GC, description, due date, whether Schreiber responded, overdue, and the linked COR. Received (default) takes the id (contract_id optional; looked up when not given); sent shows each sub's reply.",
    {
      id: z.number().int().positive().describe("Change Notification id (from list_change_notifications)."),
      contract_id: z.number().int().positive().optional().describe("contract_id from list_change_notifications (Received only; looked up when left out)."),
      inbox: inboxArg.describe("received (default) or sent."),
    },
    async (a) => {
      const now = Date.now();
      if (a.inbox === "sent") {
        return reply(shapeSent(await cs.get<Rec>(`/change-notifications/${a.id}`), now, true));
      }
      const contractId = a.contract_id ?? await receivedContractId(cs, a.id);
      return reply(shapeReceived(await cs.get<Rec>(`/change-notifications/${a.id}/${contractId}`), now, true));
    },
  );
}

/** The contract a Received Change Notification came in on, from the Received list. */
async function receivedContractId(cs: ToolContext["cs"], id: number): Promise<number> {
  const all = await pullAll<Rec>(cs, { path: "/change-notifications", query: { inbox: "received" } });
  const ids = [...new Set(all.records.filter((r) => (r.changeNotification as Rec | undefined)?.id === id).map((r) => r.contractId as number))];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) throw new Error(`Change Notification ${id} came in on contracts ${ids.join(", ")}; pass contract_id.`);
  const more = all.scope === "partial" ? " (the Received list was too long to read in full)" : "";
  throw new Error(`No Received Change Notification ${id} found${more}; pass contract_id from list_change_notifications.`);
}
