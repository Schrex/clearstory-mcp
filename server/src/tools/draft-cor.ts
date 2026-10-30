// Draft COR preview (#14) and create (#15). The preview sends only GETs and stores the exact request body;
// create_draft_cor sends that body as the one POST /cors (ADR 0003).
import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { jobArgs, resolveJob } from "../jobs.js";
import { pullAll } from "../paging.js";
import { corStatus } from "../cors.js";
import { localDay } from "../dates.js";
import { WriteOutcomeUnknownError, WriteRefusedError, type ClearstoryClient, type CreatedCor } from "../clearstory.js";
import { compact, day, money, reply, usd, type Rec } from "../util.js";

export const PREVIEW_TTL_S = 15 * 60;
/** Audit records (cor-audit:<ISO time>:<preview_id>, plus :<evt> for create outcomes) kept ~13 months. */
export const AUDIT_TTL_S = 400 * 24 * 60 * 60;
/** Created-draft ledger entries kept 30 days. */
export const LEDGER_TTL_S = 30 * 24 * 60 * 60;
/** After an unknown outcome, a same-title COR created this recently counts as probably ours. */
const PROBABLY_OURS_MS = 10 * 60 * 1000;

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
export interface CreatedDraft { state?: "created" | "unknown"; cor_id?: number; cor_number?: string; email?: string; created_at?: string }

const overlaps = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

/** Audit log line + KV record. Callers never pass title, description or secrets. */
async function audit(kv: KVNamespace, rec: { evt: string; preview_id: string; at: string } & Rec) {
  const line = JSON.stringify(rec);
  console.log(line);
  const key = `cor-audit:${rec.at}:${rec.preview_id}${rec.evt === "cor_preview" ? "" : `:${rec.evt}`}`;
  await kv.put(key, line, { expirationTtl: AUDIT_TTL_S });
}

/**
 * After an unknown outcome: exactly one GET /cors (no retries) on the Job by title for a same-title COR created in the last few minutes.
 * Never throws (drafts may not be listed, and the lookup itself can fail).
 */
async function findJustCreated(cs: ClearstoryClient, projectId: number, title: string, at: Date): Promise<Rec | undefined> {
  try {
    const page = await cs.getOnce<{ records?: Rec[] }>("/cors", {
      inbox: "sent", projectIds: projectId, searchTitle: title, includeFromArchivedProjects: true,
      sortBy: "createdAt", sortDirection: "desc", limit: 25,
    });
    const want = normalizeTitle(title);
    return (page?.records ?? []).find((c) => normalizeTitle(String(c.title ?? "")) === want
      && at.getTime() - Date.parse(String(c.createdAt)) <= PROBABLY_OURS_MS);
  } catch {
    return undefined;
  }
}

export function registerDraftCorTools({ server, cs, cfg, session }: ToolContext) {
  const now = session.now ?? (() => new Date());
  server.tool(
    "preview_draft_cor",
    "Preview a draft COR before creating it in Clearstory. Sends nothing to Clearstory. Returns the Job, GC, contract(s), title, final description (with a 'Drafted via Claude by' footer), amount, warnings (e.g. possible duplicate CORs) and a preview_id. Default pricing: the HeavyBid bid price × quantity for the matching bid item; apply a markup, cost basis or actual HeavyJob hours only when the user asks. Put the math in the description (estimate, bid item, quantity, unit, unit price, any adjustment). Show the whole preview to the user; call create_draft_cor with the preview_id only after the user says yes. The preview expires after 15 minutes.",
    {
      ...jobArgs,
      title: z.string().describe("COR title (1-255 characters)."),
      description: z.string().describe("COR description with the pricing breakdown: estimate, bid item, quantity, unit, unit price, adjustments."),
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
      const contractGc = (c: Rec) => ((c.contractorProject as Rec | undefined)?.customer ?? job.customer) as string | undefined;
      if (contracts.length > 1) {
        const list = contracts.map((c) => `${`${c.id} ${c.name ?? ""}`.trim()}${contractGc(c) ? ` (GC ${contractGc(c)})` : ""}`).join("; ");
        warnings.push(`Job ${jobNumber} has ${contracts.length} contracts: ${list}. Clearstory picks which contract the draft COR goes on (it can't be chosen here); check it in Clearstory.`);
      }
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
        warnings.push(d.state === "unknown"
          ? `Possible duplicate: a create of a draft COR with this title via Claude on this Job had an unknown outcome${info ? ` (${info})` : ""}. Check Clearstory; it may not show in Clearstory's COR list until sent.`
          : `Possible duplicate: a draft COR with this title was already created via Claude on this Job${info ? ` (${info})` : ""}. It may not show in Clearstory's COR list until sent.`);
      }
      const t = now();
      const footer = [`Drafted via Claude by ${session.email} on ${localDay(t)}.`, a.source?.trim() ? `Source: ${a.source.trim()}` : ""].filter(Boolean).join("\n");
      const description = `${a.description.trim()}\n\n${footer}`;
      const previewId = crypto.randomUUID();
      // One contract: its GC. Several: the Job's GC (Clearstory picks the contract; see the warning).
      const gc = contracts.length === 1 ? contractGc(contracts[0]) : job.customer as string | undefined;
      const stored: StoredPreview = {
        body: { projectId, title, description, amount },
        job_number: jobNumber,
        email: session.email,
        exp: new Date(t.getTime() + PREVIEW_TTL_S * 1000).toISOString(),
      };
      await session.kv.put(previewKey(previewId), JSON.stringify(stored), { expirationTtl: PREVIEW_TTL_S });
      // Audit: never title, description or secrets.
      await audit(session.kv, { evt: "cor_preview", email: session.email, job: jobNumber, amount, preview_id: previewId, at: t.toISOString() });
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

  server.tool(
    "create_draft_cor",
    "Create the draft COR in Clearstory exactly as previewed by preview_draft_cor. Call only after the user has seen the preview and said yes. Single use: a preview_id works once.",
    { preview_id: z.string().describe("preview_id returned by preview_draft_cor.") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ preview_id }) => {
      const raw = await session.kv.get(previewKey(preview_id));
      let p: StoredPreview | undefined;
      try { p = raw === null ? undefined : JSON.parse(raw) as StoredPreview; } catch { /* treated as unknown */ }
      if (!p?.body || !(now().getTime() <= Date.parse(p.exp))) throw new Error("Unknown or expired preview_id (previews last 15 minutes and work once). Nothing was sent to Clearstory; call preview_draft_cor again.");
      if (p.email !== session.email) throw new Error("This preview was made by a different signed-in person. Nothing was sent to Clearstory; call preview_draft_cor again.");
      // Single use: delete before the POST. KV isn't atomic, so two simultaneous creates could both get here (accepted).
      await session.kv.delete(previewKey(preview_id));
      const t = now();
      const at = t.toISOString();
      const base = { email: session.email, job: p.job_number, amount: p.body.amount };
      /** Ledger entry for this Job and title (duplicate check in later previews). */
      const record = async (e: Pick<CreatedDraft, "state" | "cor_id" | "cor_number">) => {
        const entry: CreatedDraft = { ...e, email: session.email, created_at: at };
        await session.kv.put(createdKey(p.body.projectId, p.body.title), JSON.stringify(entry), { expirationTtl: LEDGER_TTL_S });
        return entry;
      };
      let cor: CreatedCor;
      try {
        cor = await cs.createDraftCor(p.body);
      } catch (e) {
        if (e instanceof WriteRefusedError) {
          await audit(session.kv, { evt: "cor_refused", ...base, reason: `http_${e.status}`, preview_id, at });
          throw new Error(`${e.message}\nThe draft COR was not created and this preview is used up; fix the problem, then call preview_draft_cor again.`);
        }
        if (!(e instanceof WriteOutcomeUnknownError)) throw e;
        // No retry (no idempotency key). One lookup, then the user checks Clearstory.
        const found = await findJustCreated(cs, p.body.projectId, p.body.title, t);
        const entry = await record({ state: "unknown", cor_id: found?.id as number | undefined, cor_number: found?.corNumber as string | undefined });
        await audit(session.kv, { evt: "cor_unknown", ...base, ...compact({ cor_id: entry.cor_id, cor_number: entry.cor_number }), preview_id, at });
        return reply(compact({
          state: "unknown",
          message: `${e.message} Do not retry: tell the user to check Clearstory for this draft COR on Job ${p.job_number} before previewing again.`,
          probably_created: found ? compact({ cor_id: found.id, cor_number: found.corNumber, status: corStatus(found.status) }) : undefined,
          job_number: p.job_number,
        }));
      }
      await record({ state: "created", cor_id: cor.id, cor_number: cor.corNumber });
      await audit(session.kv, { evt: "cor_created", ...base, cor_id: cor.id, cor_number: cor.corNumber, preview_id, at });
      return reply(compact({
        state: "created", cor_id: cor.id, cor_number: cor.corNumber, status: corStatus(cor.status),
        amount: money(cor.requestedAmount) ?? p.body.amount, job_number: p.job_number,
      }));
    },
  );
}
