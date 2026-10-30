import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { dateRange, dayArg, parseDay } from "../dates.js";
import { hasJob, jobArgs, resolveJobId } from "../jobs.js";
import { listArgs, listReply, pullFiltered, pullPage } from "../paging.js";
import { compact, day, hours, personName, reply, type Rec } from "../util.js";

/** Clearstory's T&M Tag statuses (GET /tags status filter). */
const TAG_STATUSES = ["awaiting_signature", "draft", "signed", "signed_not_sent", "rejected", "revise_and_resubmit", "open"] as const;

/**
 * Clearstory tag → T&M Tag record. hcss_timecard_id is always set (null when absent) because Claude
 * joins on it with HeavyJob time cards for Unbilled T&M; cost code, work date and status likewise.
 */
function shapeTag(t: Rec, detail = false): Rec {
  const base = {
    ...compact({
      id: t.id,
      tag_number: t.paddedTagNumber ?? t.number,
      title: t.title,
      job_id: t.projectId,
      status: t.status,
      work_date: day(t.dateOfWorkPerformed),
      cost_code: typeof t.costCode === "string" ? t.costCode.trim() : t.costCode,
    }),
    hcss_timecard_id: (t.hcssTimecardId as string | null | undefined) ?? null,
    ...compact({
      total_hours: hours(t.totalHours),
      gc_signer: t.customerSignerName,
      signed_on: day(t.signedAt),
    }),
  };
  if (!detail) return base;
  return { ...base, ...detailFields(t) };
}

/** Every work date on a T&M Tag (main plus additional), as YYYY-MM-DD. */
export const workDates = (t: Rec): string[] =>
  [t.dateOfWorkPerformed, ...((t.dateOfWorkPerformedAdditional as unknown[] | null | undefined) ?? [])].map(day).filter((d): d is string => !!d);

function detailFields(t: Rec): Rec {
  const extra = (t.dateOfWorkPerformedAdditional as unknown[] | undefined)?.map(day).filter(Boolean);
  return compact({
    work_description: t.workDescription,
    more_work_dates: extra?.length ? extra : undefined,
    hours_st: hours(t.totalHoursST),
    hours_ot: hours(t.totalHoursOT),
    hours_dt: hours(t.totalHoursDT),
    hours_premium_ot: hours(t.totalHoursPOT),
    hours_premium_dt: hours(t.totalHoursPDT),
    gc_reference_number: t.customerReferenceNumber,
    date_submitted: day(t.dateSubmitted),
    gc_signed_at: t.signedAt,
    our_signer: t.subcontractorPrintedName,
    our_signed_at: t.contractorSignedAt,
    signed_document: t.attachmentSignedUrl,
    change_notification_id: t.changeNotificationId,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  });
}

export function registerTagTools({ server, cs }: ToolContext) {
  server.tool(
    "list_tm_tags",
    "List T&M Tags for one Job or all Jobs (Sent inbox by default), filtered by status, work date or last update. Every T&M Tag includes hcss_timecard_id (HeavyJob time card id, null when not from HeavyJob), cost code, work date, status and total hours, for joining with HeavyJob T&M Work. For Unbilled T&M, pass the same work_date_from / work_date_until window as the HeavyJob T&M Work pull (matches a T&M Tag's main or any additional work date). Page with skip/next_skip.",
    {
      ...jobArgs,
      inbox: z.enum(["sent", "received"]).optional().describe("sent (default) = Schreiber's T&M Tags to GCs; received = T&M Tags sent to Schreiber."),
      status: z.enum(TAG_STATUSES).optional().describe("T&M Tag status, e.g. awaiting_signature (unsigned, waiting on the GC) or signed."),
      work_date: dayArg("Only T&M Tags for work performed on this day (main or additional work date)."),
      work_date_from: dayArg("Only T&M Tags with work performed on or after this day (main or additional work date)."),
      work_date_until: dayArg("Only T&M Tags with work performed on or before this day (main or additional work date)."),
      updated_from: dayArg("Only T&M Tags updated on or after this day."),
      updated_until: dayArg("Only T&M Tags updated on or before this day."),
      ...listArgs,
    },
    async (a) => {
      const workDate = a.work_date === undefined ? undefined : parseDay("work_date", a.work_date);
      const range = dateRange(a, "work_date_from", "work_date_until");
      if (workDate && (range.from || range.until)) throw new Error("Give work_date or work_date_from/work_date_until, not both.");
      const updated = dateRange(a, "updated_from", "updated_until");
      // Work window as YYYY-MM-DD bounds (inclusive).
      const from = workDate ?? range.from?.slice(0, 10);
      const until = workDate ?? range.until?.slice(0, 10);
      // A T&M Tag is updated on/after its work date, so the window start narrows the pull by updatedAt.
      const fromUpdated = [updated.from, from && `${from}T00:00:00.000Z`].filter(Boolean).sort().pop();
      const query = {
        inbox: a.inbox ?? "sent",
        projectId: hasJob(a) ? await resolveJobId(cs, a) : undefined,
        status: a.status,
        fromUpdatedAt: fromUpdated,
        untilUpdatedAt: updated.until,
      };
      const source = { path: "/tags", query };
      const page = { skip: a.skip, limit: a.limit };
      const p = from || until
        ? await pullFiltered<Rec>(cs, source, (t) => workDates(t).some((d) => (!from || d >= from) && (!until || d <= until)), page)
        : await pullPage<Rec>(cs, source, page);
      return reply(listReply("tm_tags", p, (r) => shapeTag(r, a.detail)));
    },
  );

  server.tool(
    "get_tm_tag",
    "One T&M Tag in full: Job and GC, hcss_timecard_id, cost code, work date, status, hours by ST/OT/DT, labor / material / equipment / other items, GC signer and signed time, and the signed document link.",
    {
      id: z.number().int().positive().describe("Clearstory T&M Tag id (from list_tm_tags)."),
      detail: z.boolean().optional().describe("true = add rate ids, internal ids, recipients and creator."),
    },
    async (a) => {
      const t = await cs.get<Rec>(`/tags/${a.id}`);
      const job = t.project as Rec | undefined;
        const items = (key: string, shape: (i: Rec) => Rec) =>
        ((t[key] as Rec[] | undefined) ?? []).map((i) => compact({
          date: day(i.date),
          ...shape(i),
          ...(a.detail ? { rate_id: i.projectRateId, internal_id: i.internalId } : {}),
        }));
      return reply({
        ...shapeTag(t, true),
        job: job ? compact({ id: job.id, job_number: job.jobNumber, name: job.projectTitle, gc: job.customer }) : undefined,
        labor: items("labor", (i) => ({ labor_class: i.laborClass, workers: hours(i.workersQuantity), hours: hours(i.unitQuantity), unit: i.unit })),
        material: items("material", (i) => ({ material: i.material, quantity: hours(i.quantity), unit: i.unit })),
        equipment: items("equipment", (i) => ({ equipment: i.equipment, quantity: hours(i.quantity), unit_quantity: hours(i.unitQuantity), unit: i.unit })),
        other: items("other", (i) => ({ item: i.other, quantity: hours(i.quantity), unit_quantity: hours(i.unitQuantity), unit: i.unit })),
        ...(a.detail ? compact({
          email_to: t.emailTo,
          email_cc: t.emailCC,
          created_by: personName(t.creator),
        }) : {}),
      });
    },
  );
}
