// Draft COR preview (#14). Sends only GETs to Clearstory; stores the exact request body create_draft_cor (#15) will send.
import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { jobArgs, resolveJob } from "../jobs.js";
import { pullAll } from "../paging.js";
import { corStatus } from "../cors.js";
import { compact, day, money, reply, type Rec } from "../util.js";

export const PREVIEW_TTL_S = 15 * 60;
/** Audit records (cor-audit:<ISO time>:<preview_id>) kept ~13 months. */
export const AUDIT_TTL_S = 400 * 24 * 60 * 60;

/** KV key of a stored preview. */
export const previewKey = (previewId: string) => `cor-preview:${previewId}`;

/** What preview_draft_cor stores under previewKey; create_draft_cor sends `body` as-is. */
export interface StoredPreview {
  body: { projectId: number; title: string; description: string; amount: number };
  job_number: string;
  email: string;
  exp: string; // ISO; KV also expires the entry
}

/** Title for duplicate checks: lowercase, whitespace collapsed and trimmed. */
export const normalizeTitle = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

/** KV key of the created-draft ledger entry create_draft_cor (#15) writes per Job and title. */
export const createdKey = (jobId: number, title: string) => `cor-created:${jobId}:${normalizeTitle(title)}`;

/** Ledger value under createdKey (written by create_draft_cor; every field optional when read). */
export interface CreatedDraft { cor_id?: number; cor_number?: string; email?: string; created_at?: string }

const overlaps = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function registerDraftCorTools({ server, cs, cfg, session }: ToolContext) {
  const now = session.now ?? (() => new Date());
  server.tool(
    "preview_draft_cor",
    "Preview a draft COR before creating it in Clearstory. Sends nothing to Clearstory. Returns the Job, GC, contract(s), title, final description (with a 'Drafted via Claude by' footer), amount, warnings (e.g. possible duplicate CORs) and a preview_id. Show the whole preview to the user; call create_draft_cor with the preview_id only after the user says yes. The preview expires after 15 minutes.",
    {
      ...jobArgs,
      title: z.string().describe("COR title (1-255 characters)."),
      description: z.string().describe("COR description, e.g. the pricing breakdown."),
      amount: z.number().describe("COR amount in dollars (> 0)."),
      source: z.string().optional().describe("Where the numbers came from, e.g. \"HeavyBid B26055 bid items 2575, 2555\"."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (a) => {
      const title = a.title.trim();
      if (title.length < 1 || title.length > 255) throw new Error(`title must be 1-255 characters (got ${title.length}).`);
      const amount = money(a.amount)!;
      if (amount < 0) throw new Error("Credit (negative) CORs are not supported yet; amount must be more than 0.");
      if (amount <= 0) throw new Error("amount must be more than 0 (rounded to cents).");
      if (amount > cfg.maxDraftCorAmount) throw new Error(`amount ${usd(amount)} is above the ${usd(cfg.maxDraftCorAmount)} limit per draft COR.`);
      const job = await resolveJob(cs, a);
      const projectId = job.id as number;
      const jobNumber = String(job.jobNumber ?? projectId);
      const warnings: string[] = [];
      // No contractId on create: Clearstory picks the contract itself.
      const contracts = (await pullAll<Rec>(cs, { path: "/contracts", query: { projectId, withProjects: true } })).records;
      if (!contracts.length) throw new Error(`Job ${jobNumber} has no contract in Clearstory, so a COR can't be drafted on it. Add the contract in Clearstory first.`);
      if (contracts.length > 1) warnings.push(`Job ${jobNumber} has ${contracts.length} contracts (${contracts.map((c) => `${c.id} ${c.name ?? ""}`.trim()).join("; ")}). Clearstory chooses which one the draft COR goes on; check it in Clearstory.`);
      // Duplicates (warnings): every COR on the Job, all statuses incl. Void, then our own ledger (drafts may not be listed).
      const want = normalizeTitle(title);
      const cors = await pullAll<Rec>(cs, { path: "/cors", query: { inbox: "sent", projectIds: projectId, includeFromArchivedProjects: true } });
      for (const c of cors.records) {
        if (!overlaps(want, normalizeTitle(String(c.title ?? "")))) continue;
        const status = corStatus(c.status);
        warnings.push(`Possible duplicate: ${c.corNumber || "COR"} "${c.title}" (id ${c.id}${status ? `, ${status}` : ""}) on this Job has the same or an overlapping title.`);
      }
      if (cors.scope === "partial") warnings.push("Duplicate check incomplete: Clearstory request limit reached before every COR on the Job was read.");
      const ledger = await session.kv.get(createdKey(projectId, title));
      if (ledger !== null) {
        let d: CreatedDraft = {};
        try { d = JSON.parse(ledger) as CreatedDraft; } catch { /* unknown shape: still warn */ }
        const info = [d.cor_id !== undefined ? `COR id ${d.cor_id}` : d.cor_number, d.email ? `by ${d.email}` : "", day(d.created_at)].filter(Boolean).join(", ");
        warnings.push(`Possible duplicate: a draft COR with this title was already created via Claude on this Job${info ? ` (${info})` : ""}. It may not show in Clearstory's COR list until sent.`);
      }
      const t = now();
      const footer = [`Drafted via Claude by ${session.email} on ${t.toISOString().slice(0, 10)}.`, a.source?.trim() ? `Source: ${a.source.trim()}` : ""].filter(Boolean).join("\n");
      const description = `${a.description.trim()}\n\n${footer}`;
      const previewId = crypto.randomUUID();
      const gc = ((contracts[0]?.contractorProject as Rec | undefined)?.customer ?? job.customer) as string | undefined;
      const stored: StoredPreview = {
        body: { projectId, title, description, amount },
        job_number: jobNumber,
        email: session.email,
        exp: new Date(t.getTime() + PREVIEW_TTL_S * 1000).toISOString(),
      };
      await session.kv.put(previewKey(previewId), JSON.stringify(stored), { expirationTtl: PREVIEW_TTL_S });
      // Audit: never title, description or secrets.
      const at = t.toISOString();
      const audit = JSON.stringify({ evt: "cor_preview", email: session.email, job: jobNumber, amount, preview_id: previewId, at });
      console.log(audit);
      await session.kv.put(`cor-audit:${at}:${previewId}`, audit, { expirationTtl: AUDIT_TTL_S });
      return reply({
        ...compact({ job_number: job.jobNumber, job_name: job.projectTitle, gc }),
        contracts: contracts.map((c) => compact({ id: c.id, name: c.name })),
        title, description, amount,
        recorded_as: session.email,
        warnings,
        preview_id: previewId,
      });
    },
  );
}
