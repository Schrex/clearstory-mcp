import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { jobArgs, resolveJob, shapeJob } from "../jobs.js";
import { listArgs, listReply, pullAll, pullPage, type Source } from "../paging.js";
import { compact, day, money, reply, type Rec } from "../util.js";

const isHeavyJob = (p: string) => /hcss|heavy\s*job/i.test(p);
const isProcore = (p: string) => /procore/i.test(p);

export function registerJobTools({ server, cs }: ToolContext) {
  server.tool(
    "search_jobs",
    "Find Jobs by job number (exact, same as HeavyJob) or part of the name. Archived Jobs are left out unless include_archived. Returns compact Jobs (id, job number, name, GC, contract value, office, dates); page with skip/next_skip.",
    {
      job_number: z.string().optional().describe("Exact job number, e.g. \"23104\"."),
      name: z.string().optional().describe("Part of the Job name."),
      include_archived: z.boolean().optional().describe("Also return archived Jobs (listed after active ones)."),
      ...listArgs,
    },
    async (a) => {
      const query = { jobNumber: a.job_number?.trim(), searchTitle: a.name?.trim(), sortBy: "title", sortDirection: "asc" };
      const sources: Source[] = [{ path: "/projects", query }];
      if (a.include_archived) sources.push({ path: "/projects", query: { ...query, archived: true } });
      const p = await pullPage<Rec>(cs, sources, { skip: a.skip, limit: a.limit });
      return reply(listReply("jobs", p, (r) => shapeJob(r, a.detail)));
    },
  );

  server.tool(
    "get_job",
    "One Job by job number or Clearstory Job id: GC, contract value, office, dates, its contracts, and whether the HeavyJob and Procore integrations are on (HeavyJob on = its T&M Tags carry time card links). Unknown job number → close matches.",
    { ...jobArgs, detail: z.boolean().optional().describe("true = full Job and contract records.") },
    async (a) => {
      const job = await resolveJob(cs, a);
      const id = job.id as number;
      const contracts = await pullAll<Rec>(cs, { path: "/contracts", query: { projectId: id } });
      const ints = ((await cs.get<{ integrations?: Rec[] }>(`/projects/${id}/integrations`))?.integrations ?? []);
      const providers = ints.map((i) => String(i.provider ?? ""));
      return reply({
        ...shapeJob(job, a.detail),
        contracts: contracts.records.map((c) => compact({
          id: c.id, name: c.name, contract_value: money(c.contractValue),
          ...(a.detail ? { created_at: c.createdAt, updated_at: c.updatedAt } : {}),
        })),
        ...(contracts.scope === "partial" ? { contracts_scope: "partial" } : {}),
        integrations: {
          heavyjob: providers.some(isHeavyJob),
          procore: providers.some(isProcore),
          links: ints.map((i) => compact({
            system: i.provider, external_job_id: i.externalProjectId, external_job_name: i.externalProjectName,
            ...(a.detail ? { linked_on: day(i.createdAt) } : {}),
          })),
        },
      });
    },
  );
}
