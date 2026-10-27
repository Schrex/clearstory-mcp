import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { jobArgs, resolveJobId } from "../jobs.js";
import { listArgs, listReply, pullPage } from "../paging.js";
import { dateRange, dayArg } from "../dates.js";
import { compact, day, money, reply, type Rec } from "../util.js";

const TYPES = { pricing_request: "Pricing Request", authorize_tm_work: "Authorize T&M Work" } as const;
const typeLabel = (t: unknown) => TYPES[t as keyof typeof TYPES] ?? t;

const COR_STATUS: Record<string, string> = {
  in_review: "In Review", approved_to_proceed: "Approved to Proceed", approved_co_issued: "Approved CO Issued",
  rejected: "Void", void: "Void", draft: "Draft",
};
const corStatus = (s: unknown) => (typeof s === "string" ? COR_STATUS[s] ?? s : undefined);

/** Overdue = due date has passed and not responded. */
const isOverdue = (due: unknown, responded: boolean, now: number) =>
  !responded && typeof due === "string" && Number.isFinite(Date.parse(due)) && Date.parse(due) < now;

const person = (p: unknown) => {
  const r = p as Rec | undefined;
  return r ? [r.firstName, r.lastName].filter(Boolean).join(" ") || (r.email as string | undefined) : undefined;
};

/** The COR Schreiber answered with (or a sub answered with, on the Sent side). */
function shapeCor(c: unknown, detail = false): Rec | undefined {
  const r = c as Rec | null | undefined;
  if (!r || (!r.number && !r.uuid && !r.title)) return undefined;
  return compact({
    number: r.number, title: r.title, status: corStatus(r.status),
    ...(r.stage === "waived" ? { void_kind: "Waived" } : {}),
    total: money(r.total), submitted: day(r.dateSubmitted),
    ...(detail ? {
      uuid: r.uuid, gc_co_number: r.customerCoNumber, approved_to_proceed: day(r.approvedToProceedDate),
      co_issued: day(r.coIssueDate), void_date: day(r.voidDate), updated_at: r.updatedAt,
    } : {}),
  });
}

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
    received: day(cn.dateReceived), due_date: day(cn.dueDate),
    responded, overdue: isOverdue(cn.dueDate, responded, now),
    no_cost_impact: v.noCostImpact === true ? true : undefined,
    cor: shapeCor(v.cor, detail),
    ...(detail ? {
      contract: contract?.name, description: cn.description, message: cn.emailMessage, sent_by: person(cn.sentBy),
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
    submitted: day(s.dateSubmitted), due_date: day(s.dueDate),
    responded, responded_count: `${answered} of ${submitted}`, overdue: isOverdue(s.dueDate, responded, now),
    ...(detail ? {
      replies: responses.map((r) => compact({
        contract_id: r.contractId, contract: (r.contract as Rec | undefined)?.name,
        responded: r.hasResponded === true, no_cost_impact: r.noCostImpact === true ? true : undefined, cor: shapeCor(r.cor, detail),
      })),
    } : {}),
    ...(detail ? {
      description: s.description, message: s.emailMessage, sent_by: person(s.sentBy),
      estimate: money(s.estimate), projected_cost: money(s.projectedCost), cost_impact: money(s.costImpact),
      due_at: s.dueDate, updated_at: s.updatedAt,
    } : {}),
  });
}

const inboxArg = z.enum(["Received", "Sent"]).optional();

export function registerNotificationTools({ server, cs }: ToolContext) {
  server.tool(
    "list_change_notifications",
    "List Change Notifications: a GC's request to Schreiber to price a change (Pricing Request) or to authorize T&M work. Received inbox by default (sent to Schreiber); Sent = ones Schreiber sent to its own subs. Each shows type, due date, whether Schreiber responded, overdue (due date passed and not responded) and the COR it was answered with. Soonest due first; page with skip/next_skip.",
    {
      inbox: inboxArg.describe("Received (default) or Sent."),
      type: z.enum(["Pricing Request", "Authorize T&M Work"]).optional().describe("Only this type."),
      ...jobArgs,
      due_from: dayArg("Due on or after."),
      due_until: dayArg("Due on or before."),
      submitted_from: dayArg("Sent by the GC on or after."),
      submitted_until: dayArg("Sent by the GC on or before."),
      ...listArgs,
    },
    async (a) => {
      const inbox = a.inbox ?? "Received";
      const due = dateRange(a, "due_from", "due_until");
      const sub = dateRange(a, "submitted_from", "submitted_until");
      const projectId = a.job !== undefined || a.job_id !== undefined ? await resolveJobId(cs, a) : undefined;
      const type = a.type && (Object.keys(TYPES) as (keyof typeof TYPES)[]).find((k) => TYPES[k] === a.type);
      const query = {
        inbox: inbox.toLowerCase(), // Clearstory returns an empty list when inbox is omitted
        types: type, projectIds: projectId,
        fromDueDate: due.from, untilDueDate: due.until, fromDateSubmitted: sub.from, untilDateSubmitted: sub.until,
        sortBy: "dueDate", sortDirection: "asc",
      };
      const p = await pullPage<Rec>(cs, { path: "/change-notifications", query }, { skip: a.skip, limit: a.limit });
      const now = Date.now();
      const shaped = p.records.map((r) => inbox === "Sent" ? shapeSent(r, now, a.detail) : shapeReceived(r, now, a.detail));
      const overdue = shaped.filter((c) => c.overdue === true).length;
      return reply({ inbox, overdue_count: overdue, ...listReply("change_notifications", { ...p, records: shaped }, (c) => c) });
    },
  );

  server.tool(
    "get_change_notification",
    "One Change Notification in full: type, GC, description, due date, whether Schreiber responded, overdue, and the linked COR. Received (default) needs the id and contract_id from list_change_notifications; Sent needs only the id and shows each sub's reply.",
    {
      id: z.number().int().positive().describe("Change Notification id (from list_change_notifications)."),
      contract_id: z.number().int().positive().optional().describe("contract_id from list_change_notifications; required for Received."),
      inbox: inboxArg.describe("Received (default) or Sent."),
    },
    async (a) => {
      const now = Date.now();
      if ((a.inbox ?? "Received") === "Sent") {
        return reply(shapeSent(await cs.get<Rec>(`/change-notifications/${a.id}`), now, true));
      }
      if (a.contract_id === undefined) throw new Error("contract_id is required for a Received Change Notification; take it from list_change_notifications.");
      return reply(shapeReceived(await cs.get<Rec>(`/change-notifications/${a.id}/${a.contract_id}`), now, true));
    },
  );
}
