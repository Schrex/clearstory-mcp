// Reference data for filtering other questions by name: offices and divisions, GCs, rates, labels,
// reason categories and users. Clearstory "customer" is a GC; "project" is a Job (GLOSSARY.md).
import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { listArgs, listReply, localPage, pullAll, pullPage } from "../paging.js";
import { hasJob, jobArgs, resolveJobId } from "../jobs.js";
import { compact, money, personName, reply, type Rec } from "../util.js";

const shapeOffice = (o: Rec, detail?: boolean): Rec => compact({
  id: o.id, name: o.name, code: o.customId, city: o.city, state: o.state,
  ...(detail ? { business_name: o.businessName, address: o.address, zip: o.zipCode, phone: o.phone, time_zone: o.tzName, updated_at: o.updatedAt } : {}),
});

/** Clearstory customer → GC. */
const shapeGc = (g: Rec, detail?: boolean): Rec => compact({
  id: g.id, name: g.name, internal_id: g.internalId, city: g.city, state: g.state,
  ...(detail ? { address: g.address, zip: g.zipCode, country: g.country, phone: g.phone, fax: g.fax, updated_at: g.updatedAt } : {}),
});

const RATE_TYPES = ["labor", "material", "equipment", "other"] as const;
type RateType = (typeof RATE_TYPES)[number];
/** Clearstory field holding the rate's name, per type (also its sortBy value). */
const NAME_FIELD: Record<RateType, string> = { labor: "laborClass", material: "material", equipment: "equipment", other: "other" };

/** Company rate (LaborRate / MaterialRate / …) or per-Job rate (ProjectLaborRate / …) → compact rate. */
const shapeRate = (type: RateType, r: Rec, detail?: boolean): Rec => {
  const perJob = r.projectRateId !== undefined;
  const amounts = type === "labor"
    ? { st: money(r.straightTimeRate), ot: money(r.overTimeRate), dt: money(r.doubleTimeRate), premium_ot: money(r.premiumOverTimeRate) || undefined, premium_dt: money(r.premiumDoubleTimeRate) || undefined }
    : { unit: r.unit, rate: money(r.rate) };
  return compact({
    id: perJob ? r.projectRateId : r.id,
    internal_id: r.internalId,
    name: r[NAME_FIELD[type]],
    ...amounts,
    rate_group: (r.rateGroup as Rec | undefined)?.name,
    company_rate_id: r.companyRateId,
    ...(detail ? {
      rate_group_id: r.rateGroupId,
      follows_company_rate: r.inheritCompanyRateChanges,
      standard_amount: type === "labor" ? undefined : money(r.standardAmount),
      updated_at: r.updatedAt,
    } : {}),
  });
};

export function registerReferenceTools({ server, cs }: ToolContext) {
  server.tool(
    "list_offices",
    "Schreiber's Clearstory offices (id, name, code, city) for filtering by office, plus the company's divisions. Page offices with skip/next_skip.",
    { ...listArgs },
    async (a) => {
      const p = await pullPage<Rec>(cs, { path: "/offices", query: { sortBy: "name", sortDirection: "asc" } }, { skip: a.skip, limit: a.limit });
      const d = await pullAll<Rec>(cs, { path: "/divisions" });
      return reply({
        ...listReply("offices", p, (o) => shapeOffice(o, a.detail)),
        divisions: d.records.map((r) => r.division).filter(Boolean),
        ...(d.scope === "partial" ? { divisions_scope: "partial" } : {}),
      });
    },
  );

  server.tool(
    "list_gcs",
    "GCs (general contractors / owners Schreiber contracts with): id, name, internal id, city. Filter by part of the name, office or internal id; or pass gc_id for one GC in full with its offices. Page with skip/next_skip.",
    {
      name: z.string().optional().describe("Part of the GC name."),
      office_id: z.number().int().positive().optional().describe("Only GCs of this office (id from list_offices)."),
      internal_id: z.string().optional().describe("Exact internal GC id, e.g. \"TURN\"."),
      gc_id: z.number().int().positive().optional().describe("Clearstory GC id: return just this GC, in full."),
      ...listArgs,
    },
    async (a) => {
      if (a.gc_id !== undefined) {
        const g = await cs.get<Rec>(`/customers/${a.gc_id}`);
        return reply({ gc: { ...shapeGc(g, true), offices: ((g.offices as Rec[] | undefined) ?? []).map((o) => shapeOffice(o)) } });
      }
      const query = { searchName: a.name?.trim(), officeId: a.office_id, internalId: a.internal_id?.trim(), sortBy: "name", sortDirection: "asc" };
      const p = await pullPage<Rec>(cs, { path: "/customers", query }, { skip: a.skip, limit: a.limit });
      return reply(listReply("gcs", p, (g) => shapeGc(g, a.detail)));
    },
  );

  server.tool(
    "list_rates",
    "Labor, material, equipment or other rates used to price CORs. Company-wide by default; give a job (job number) or job_id for that Job's own rates. Labor rates show ST/OT/DT; others show unit and rate. Page with skip/next_skip.",
    {
      type: z.enum(RATE_TYPES).describe("Which rates: labor, material, equipment or other."),
      ...jobArgs,
      rate_group_id: z.number().int().positive().optional().describe("Company rates only: just this rate group."),
      internal_id: z.string().optional().describe("Exact internal id of a rate."),
      ...listArgs,
    },
    async (a) => {
      const perJob = hasJob(a);
      const jobId = perJob ? await resolveJobId(cs, a) : undefined;
      const query = {
        internalId: a.internal_id?.trim(), rateGroupId: perJob ? undefined : a.rate_group_id,
        sortBy: NAME_FIELD[a.type], sortDirection: "asc",
      };
      const path = perJob ? `/rates/project/${jobId}/${a.type}` : `/rates/${a.type}`;
      const p = await pullPage<Rec>(cs, { path, query }, { skip: a.skip, limit: a.limit });
      return reply({
        type: a.type,
        level: perJob ? "job" : "company",
        ...(perJob ? { job_id: jobId } : {}),
        ...listReply("rates", p, (r) => shapeRate(a.type, r, a.detail)),
      });
    },
  );

  server.tool(
    "list_reference",
    "Ids and names to filter other tools by: labels, reason categories (COR reasons) or users (filter users by office, Job or email). Page with skip/next_skip.",
    {
      kind: z.enum(["labels", "reason_categories", "users"]).describe("Which list."),
      office_id: z.number().int().positive().optional().describe("Users only: just this office (id from list_offices)."),
      ...jobArgs,
      email: z.string().optional().describe("Users only: exact email."),
      ...listArgs,
    },
    async (a) => {
      const page = { skip: a.skip, limit: a.limit };
      if (a.kind === "labels") {
        const p = await pullPage<Rec>(cs, { path: "/labels", query: { sortBy: "name", sortDirection: "asc" } }, page);
        return reply(listReply("labels", p, (l) => compact({
          id: l.id, name: l.name, active: l.active,
          ...(a.detail ? { company_standard: l.companyStandard, updated_at: l.updatedAt } : {}),
        })));
      }
      if (a.kind === "reason_categories") {
        // Clearstory returns every reason category in one unpaged reply; page it here.
        const all = (await cs.get<{ records?: Rec[] }>("/reason-categories"))?.records ?? [];
        return reply(listReply("reason_categories", localPage(all, page), (c) => compact({
          id: c.id, name: c.name, group: (c.reasonCategoryGroup as Rec | undefined)?.name,
          archived: c.isArchived === true ? true : undefined,
          ...(a.detail ? { description: c.description, default: c.isDefault, sort_order: c.sortOrder, updated_at: c.updatedAt } : {}),
        })));
      }
      const query = {
        officeId: a.office_id, projectId: hasJob(a) ? await resolveJobId(cs, a) : undefined, email: a.email?.trim(),
        sortBy: "lastName", sortDirection: "asc",
      };
      const p = await pullPage<Rec>(cs, { path: "/users", query }, page);
      return reply(listReply("users", p, (u) => compact({
        id: u.id, name: personName({ firstName: u.firstName, lastName: u.lastName }), email: u.email, role: u.roleName,
        offices: ((u.offices as Rec[] | undefined) ?? []).map((o) => o.name),
        ...(a.detail ? { role_id: u.roleId, office_ids: ((u.offices as Rec[] | undefined) ?? []).map((o) => o.id), updated_at: u.updatedAt } : {}),
      })));
    },
  );
}
