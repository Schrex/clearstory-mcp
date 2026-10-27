// Job (Clearstory "project") lookup and shaping, shared by every tool that takes a Job.
import { z } from "zod";
import type { ClearstoryClient } from "./clearstory.js";
import { pullPage, type Source } from "./paging.js";
import { compact, day, money, type Rec } from "./util.js";

/** zod shape for tools that take one Job: job number (as in HeavyJob) or Clearstory Job id. */
export const jobArgs = {
  job: z.string().optional().describe("Job number (same as the HeavyJob job code), e.g. \"23104\"."),
  job_id: z.number().int().positive().optional().describe("Clearstory Job id (from search_jobs). Use instead of job."),
};

/** True when the args name a Job (job number or job_id). */
export const hasJob = (a: { job?: string; job_id?: number }) => a.job !== undefined || a.job_id !== undefined;

const listed = (jobNumber: string): Source[] => [
  { path: "/projects", query: { jobNumber } },
  { path: "/projects", query: { jobNumber, archived: true } },
];

/**
 * Resolve a Job number or Clearstory id to the Clearstory Job record (archived Jobs included).
 * Unknown job number → Error listing close matches. Later tools pass `record.id` as Clearstory's projectId.
 */
export async function resolveJob(cs: ClearstoryClient, a: { job?: string; job_id?: number }): Promise<Rec> {
  if (a.job_id !== undefined) return cs.get<Rec>(`/projects/${a.job_id}`);
  const num = (a.job ?? "").trim();
  if (!num) throw new Error("Give a job (job number) or job_id.");
  const hit = await pullPage<Rec>(cs, listed(num), { limit: 1 });
  if (hit.records[0]) return hit.records[0];
  throw new Error(`No Job with job number '${num}'.${await closeMatches(cs, num)}`);
}

/** Convenience: the Clearstory projectId for a Job number or id. */
export const resolveJobId = async (cs: ClearstoryClient, a: { job?: string; job_id?: number }) =>
  a.job_id ?? (await resolveJob(cs, a)).id as number;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** " Close matches: 23014 Route 30 Sewer; ..." from the unarchived Job list (best effort, ≤ 5). */
async function closeMatches(cs: ClearstoryClient, input: string): Promise<string> {
  let jobs: Rec[];
  try { jobs = (await pullPage<Rec>(cs, { path: "/projects" }, { limit: 500 })).records; } catch { return ""; }
  const x = input.toLowerCase();
  const scored = jobs.map((j) => {
    const n = String(j.jobNumber ?? "").toLowerCase();
    const t = String(j.projectTitle ?? "").toLowerCase();
    const s = n && (n.includes(x) || x.includes(n)) ? 0 : t.includes(x) ? 1 : n ? editDistance(n, x) : 99;
    return { j, s };
  }).filter((e) => e.s <= 2).sort((a, b) => a.s - b.s).slice(0, 5);
  return scored.length ? ` Close matches: ${scored.map(({ j }) => `${j.jobNumber} ${j.projectTitle}`.trim()).join("; ")}.` : " No close matches; try search_jobs with part of the name.";
}

/** Clearstory project → Job record in GLOSSARY terms. Compact by default. */
export function shapeJob(p: Rec, detail = false): Rec {
  const office = p.office as Rec | undefined;
  const base = compact({
    id: p.id,
    job_number: p.jobNumber,
    name: p.projectTitle,
    gc: p.customer,
    contract_value: money(p.contractValue),
    office: office?.name,
    division: p.division,
    start_date: day(p.startDate),
    end_date: day(p.endDate),
    archived: p.archived === true ? true : undefined,
  });
  if (!detail) return base;
  const addr = p.address as Rec | undefined;
  const gcContract = p.contractWithCustomer as Rec | undefined;
  return compact({
    ...base,
    gc_id: p.customerId,
    gc_job_number: p.customerJobNumber,
    gc_contract: gcContract?.name,
    office_id: p.officeId,
    address: addr?.projectAddress ?? [addr?.streetAddress, addr?.city, addr?.state].filter(Boolean).join(", "),
    origin: p.originType,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  });
}
