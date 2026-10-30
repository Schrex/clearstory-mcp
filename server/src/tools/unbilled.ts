// list_unbilled_tm_tags (#22): the "Signed, not on a COR" stage of Unbilled T&M, Clearstory-only.
// The HeavyJob join (Untagged / Unsigned T&M Work) stays Claude-side (ADR 0002). Read-only: GETs and KV reads.
import type { ToolContext } from "../tools.js";
import { dateRange, dayArg, localDay } from "../dates.js";
import { hasJob, jobArgs, resolveJobId } from "../jobs.js";
import { pullAll } from "../paging.js";
import { NOT_VOID, tmTagIds } from "../cors.js";
import { compact, day, hours, reply, type Rec } from "../util.js";
import { workDates } from "./tags.js";
import { parseLedger, sourceKey } from "./draft-cor.js";

/** T&M Tag statuses that mean the GC signed. */
const SIGNED = ["signed", "signed_not_sent"];
export const DEFAULT_WINDOW_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const CAVEAT = "Clearstory's COR list leaves out draft CORs, so a T&M Tag on a draft COR shows here as unbilled. "
  + "T&M Tags this connector put on a draft COR are listed under on_draft_cor instead; check the Job's Draft COR Log in Clearstory for drafts made elsewhere.";

/** Days between two YYYY-MM-DD dates. */
const daysBetween = (from: string, until: string) => Math.round((Date.parse(until) - Date.parse(from)) / DAY_MS);

export function registerUnbilledTools({ server, cs, session }: ToolContext) {
  const now = session.now ?? (() => new Date());
  server.tool(
    "list_unbilled_tm_tags",
    `Signed T&M Tags on no COR (Unbilled T&M stage "Signed, not on a COR") for one Job or all Jobs: each with tag number, Job, work date, total hours, days since signed, hcss_timecard_id; totals per Job; oldest first. Default window: last ${DEFAULT_WINDOW_DAYS} days of work dates (main or additional). Tags on a non-Void COR are excluded. Draft CORs are not visible in Clearstory's COR list (see caveat). $ is not on Clearstory's tag list; use get_tm_tag for items.`,
    {
      ...jobArgs,
      work_date_from: dayArg(`Work performed on or after this day (default ${DEFAULT_WINDOW_DAYS} days ago).`),
      work_date_until: dayArg("Work performed on or before this day (default today)."),
    },
    async (a) => {
      const today = localDay(now());
      const range = dateRange(
        { work_date_from: a.work_date_from ?? new Date(Date.parse(today) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10), work_date_until: a.work_date_until ?? today },
        "work_date_from", "work_date_until",
      );
      const from = range.from!.slice(0, 10);
      const until = range.until!.slice(0, 10);
      const jobId = hasJob(a) ? await resolveJobId(cs, a) : undefined;

      // A T&M Tag is updated on/after its work date, so the window start narrows the pull by updatedAt.
      const tagSources = SIGNED.map((status) => ({ path: "/tags", query: { inbox: "sent", projectId: jobId, status, fromUpdatedAt: range.from } }));
      // CORs first (fewer rows): a budget stop then lands on the T&M Tags as scope partial, not an error.
      const cors = await pullAll<Rec>(cs, { path: "/cors", query: { inbox: "sent", projectIds: jobId, hasTags: 1, statuses: NOT_VOID.join(","), includeFromArchivedProjects: true } });
      const tags = await pullAll<Rec>(cs, tagSources);

      const onCor = new Set(cors.records.flatMap(tmTagIds));
      const incomplete = cors.records.filter((c) => typeof c.tmTagCount === "number" && c.tmTagCount > tmTagIds(c).length);
      const seen = new Set<number>();
      const candidates = tags.records.filter((t) => {
        const id = t.id as number;
        if (seen.has(id) || !SIGNED.includes(t.status as string) || onCor.has(id)) return false;
        seen.add(id);
        return workDates(t).some((d) => d >= from && d <= until);
      });

      const unbilled: Rec[] = [];
      const onDraft: Rec[] = [];
      const ledgerRaws = await Promise.all(candidates.map((t) => session.kv.get(sourceKey(t.projectId as number, { tm_tag_id: t.id as number }))));
      for (const [i, t] of candidates.entries()) {
        const signedMs = typeof t.signedAt === "string" ? Date.parse(t.signedAt) : NaN;
        const signed = Number.isFinite(signedMs) ? localDay(new Date(signedMs)) : undefined; // New York day, like `today`
        const row = {
          ...compact({
            id: t.id,
            tag_number: t.paddedTagNumber ?? t.number,
            job_id: t.projectId,
            status: t.status,
            work_date: day(t.dateOfWorkPerformed),
          }),
          hcss_timecard_id: (t.hcssTimecardId as string | null | undefined) ?? null,
          ...compact({
            total_hours: hours(t.totalHours),
            signed_on: signed,
            days_since_signed: signed ? daysBetween(signed, today) : undefined,
          }),
        };
        const raw = ledgerRaws[i];
        if (raw === null) { unbilled.push(row); continue; }
        const draft = parseLedger(raw); // unknown shape: still on a draft we created
        onDraft.push({ ...row, draft_cor: compact({ cor_id: draft.cor_id, cor_number: draft.cor_number, state: draft.state, created_at: day(draft.created_at) }) });
      }
      const oldestFirst = (x: Rec, y: Rec) => String(x.work_date ?? "").localeCompare(String(y.work_date ?? "")) || String(x.tag_number).localeCompare(String(y.tag_number));
      unbilled.sort(oldestFirst);
      onDraft.sort(oldestFirst);

      const byJob = new Map<unknown, { job_id: unknown; unbilled_tm_tags: number; total_hours: number }>();
      for (const r of unbilled) {
        const j = byJob.get(r.job_id) ?? { job_id: r.job_id, unbilled_tm_tags: 0, total_hours: 0 };
        j.unbilled_tm_tags++;
        j.total_hours += (r.total_hours as number | undefined) ?? 0;
        byJob.set(r.job_id, j);
      }

      const partial = tags.scope === "partial" || cors.scope === "partial";
      return reply({
        work_date_from: from,
        work_date_until: until,
        scope: partial ? "partial" : "complete",
        ...(partial ? { note: "Stopped early at the Clearstory request limit: T&M Tags or CORs were not all read, so this list may be incomplete or include T&M Tags that are on a COR. Narrow by Job or work dates." } : {}),
        caveat: CAVEAT,
        ...(incomplete.length ? { cor_tags_incomplete: incomplete.map((c) => c.corNumber ?? c.id), cor_tags_note: "Clearstory listed fewer T&M Tags than these CORs hold; check them before billing." } : {}),
        jobs: [...byJob.values()].map((j) => ({ ...j, total_hours: hours(j.total_hours) })),
        unbilled_tm_tags: unbilled,
        on_draft_cor: onDraft,
      });
    },
  );
}
