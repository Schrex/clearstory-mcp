// COR shaping in GLOSSARY terms, shared by the COR tools (list_cors, get_cor, and the summary/aging tools).
import { compact, day, hours, money, type Rec } from "./util.js";

/** GLOSSARY COR status → Clearstory status value. Void includes Waived (a Void stage). */
export const COR_STATUS = {
  "In Review": "in_review",
  "Approved to Proceed": "approved_to_proceed",
  "Approved CO Issued": "approved_co_issued",
  Void: "rejected",
} as const;
export type CorStatus = keyof typeof COR_STATUS;

/** Clearstory's Placeholder status (counted, shown only when present). */
export const PLACEHOLDER = "placeholder";

/** Clearstory statuses sent when Void is not asked for (everything but "rejected"). */
export const NOT_VOID: string[] = [COR_STATUS["In Review"], COR_STATUS["Approved to Proceed"], COR_STATUS["Approved CO Issued"], PLACEHOLDER];
/** Stages that mean Void. */
export const VOID_STAGES = ["void", "waived"];

const STATUS_NAME: Record<string, string> = {
  in_review: "In Review", approved_to_proceed: "Approved to Proceed", approved_co_issued: "Approved CO Issued",
  rejected: "Void", void: "Void", placeholder: "Placeholder", draft: "Draft",
};
/** Clearstory status → GLOSSARY name (unknown values pass through). */
export const corStatus = (s: unknown) => (typeof s === "string" ? STATUS_NAME[s] ?? s : undefined);

const BALL: Record<string, string | undefined> = {
  company: "Schreiber", customer: "GC", contractor: "Subcontractor", owner: "Owner", na: undefined,
};
/** Clearstory ballInCourt (relative to the viewing inbox) → who must act next; "na" → undefined. */
export const ballInCourt = (b: unknown) => (typeof b === "string" ? (b in BALL ? BALL[b] : b) : undefined);

/** Linked T&M Tag ids (always an array: the Unbilled T&M join needs "none" to be explicit). */
export const tmTagIds = (c: Rec) => ((c.tmTags as Rec[] | undefined) ?? []).map((t) => t.id as number);

/** Days in Review, amounts by status, Ball in Court: compact COR; detail adds labels, reason, dates, tags. */
export function shapeCor(c: Rec, detail = false): Rec {
  const gc = c.customer as Rec | undefined;
  const ids = tmTagIds(c);
  const count = typeof c.tmTagCount === "number" ? c.tmTagCount : ids.length;
  const base = compact({
    id: c.id,
    cor_number: c.corNumber,
    title: c.title,
    job_id: c.projectId,
    job_number: c.jobNumber,
    job_name: c.projectName,
    gc: gc?.name ?? c.customerName,
    gc_id: gc?.id,
    status: corStatus(c.status),
    stage: c.stage,
    ball_in_court: ballInCourt(c.ballInCourt),
    requested_amount: money(c.requestedAmount),
    in_review_amount: money(c.inReviewAmount),
    approved_to_proceed_amount: money(c.approvedToProceedAmount),
    approved_co_issued_amount: money(c.approvedCoIssuedAmount),
    void_amount: money(c.voidAmount),
    date_submitted: day(c.dateSubmitted),
    days_in_review: c.daysInReview,
    revision: c.version,
    tm_tag_count: count,
  });
  base.tm_tag_ids = ids;
  if (count > ids.length) base.tm_tags_incomplete = true;
  if (!detail) return base;
  const reason = c.reasonCategory as Rec | null | undefined;
  const group = (reason?.reasonCategoryGroup ?? c.reasonCategoryGroup) as Rec | null | undefined;
  const responsible = c.responsibleParty as Rec | null | undefined;
  return {
    ...base,
    ...compact({
      labels: ((c.labels as Rec[] | undefined) ?? []).map((l) => l.name),
      reason_category: reason?.name,
      reason_category_group: group?.name,
      responsible_party: responsible?.name,
      approved_to_proceed_date: day(c.approvedToProceedDate),
      co_issue_date: day(c.coIssueDate),
      void_date: day(c.voidDate),
      gc_co_number: c.customerCoNumber,
      gc_reference_number: c.customerReferenceNumber,
      gc_job_number: c.customerJobNumber,
      contract_id: c.contractId,
      change_notification_id: c.changeNotificationId,
      original_cor_id: c.originalCorId,
      status_changed_at: c.statusChangedAt,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    }),
    tm_tags: ((c.tmTags as Rec[] | undefined) ?? []).map((t) => compact({
      id: t.id,
      tag_number: t.paddedTagNumber ?? t.number,
      title: t.title,
      status: t.status,
      work_date: day(t.dateOfWorkPerformed),
      signed_on: day(t.signedAt),
      total_hours: hours(t.totalHours),
    })),
  };
}

/**
 * A COR embedded in a Change Notification (definitions.ChangeNotificationCorContract): the COR it was
 * answered with, in shapeCor's field names. undefined when there is none.
 */
export function shapeLinkedCor(c: unknown, detail = false): Rec | undefined {
  const r = c as Rec | null | undefined;
  if (!r || (!r.number && !r.uuid && !r.title)) return undefined;
  return compact({
    cor_number: r.number, title: r.title, status: corStatus(r.status),
    ...(r.stage === "waived" ? { void_kind: "Waived" } : {}),
    total: money(r.total), date_submitted: day(r.dateSubmitted),
    ...(detail ? {
      uuid: r.uuid, gc_co_number: r.customerCoNumber, approved_to_proceed_date: day(r.approvedToProceedDate),
      co_issue_date: day(r.coIssueDate), void_date: day(r.voidDate), updated_at: r.updatedAt,
    } : {}),
  });
}

const line = (l: Rec) => compact({
  description: l.description, internal_id: l.internalId, quantity: hours(l.quantity), unit: l.unit, rate: money(l.rate), total: money(l.total),
});

/** CORLineItems → LMEO lines (plus subcontractor and markup lines). */
export function shapeLineItems(li: Rec): Rec {
  const arr = (k: string) => ((li[k] as Rec[] | undefined) ?? []);
  return {
    labor: arr("labor").map(line),
    materials: arr("materials").map(line),
    equipment: arr("equipment").map(line),
    other: arr("others").map(line),
    subcontractors: arr("subcontractors").map((s) => compact({ ...line(s), subcontractor: s.companyName, contract: s.contractName })),
    markups: arr("markups").map((m) => compact({
      description: m.description, applies_to: m.markedUpSection, rate: hours(m.rate), rate_type: m.rateType, total: money(m.total),
    })),
  };
}
