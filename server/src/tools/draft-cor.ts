// Draft COR preview (#14) and create (#15). The preview sends only GETs and stores the exact request body;
// create_draft_cor sends that body as the one POST /cors (ADR 0003).
import { z } from "zod";
import type { ToolContext } from "../tools.js";
import { jobArgs, resolveJob } from "../jobs.js";
import { pullAll } from "../paging.js";
import { VOID_STAGES, corStatus, shapeLineItems, tmTagIds } from "../cors.js";
import { localDay } from "../dates.js";
import { WriteOutcomeUnknownError, WriteRefusedError, type ClearstoryClient, type CreatedCor } from "../clearstory.js";
import { compact, day, money, reply, usd, type Rec } from "../util.js";

export const PREVIEW_TTL_S = 15 * 60;
/** Audit records (cor-audit:<ISO time>:<preview_id>, plus :<evt> for create outcomes) kept ~13 months. */
export const AUDIT_TTL_S = 400 * 24 * 60 * 60;
/** Created-draft ledger entries kept 30 days. */
export const LEDGER_TTL_S = 30 * 24 * 60 * 60;

/** KV key of a stored preview. */
export const previewKey = (previewId: string) => `cor-preview:${previewId}`;

/** What preview_draft_cor stores under previewKey; create_draft_cor sends `body` as-is. */
export interface StoredPreview {
  body: { projectId: number; title: string; description: string; amount: number };
  job_number: string;
  email: string;
  exp: string; // ISO; KV also expires the entry
  /** Structured sources (#20); create_draft_cor writes a source ledger entry for each. */
  sources?: CorSource[];
}

/** Title for duplicate checks: lowercase, whitespace collapsed and trimmed. */
export const normalizeTitle = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

/** KV key of the created-draft ledger entry create_draft_cor (#15) writes per Job and title. */
export const createdKey = (jobId: number, title: string) => `cor-created:${jobId}:${normalizeTitle(title)}`;

/** Ledger value under createdKey (written by create_draft_cor; every field optional when read). */
export interface CreatedDraft { state?: "created" | "unknown"; cor_id?: number; cor_number?: string; email?: string; created_at?: string }

/** Source-ledger entries kept 365 days. */
export const SOURCE_TTL_S = 365 * 24 * 60 * 60;

/** Where a draft COR's numbers came from: one HeavyBid bid item or one T&M Tag (Clearstory tag id). */
export type CorSource = { heavybid: { estimate_code: string; bid_item: string } } | { tm_tag_id: number };

/** Normalized key part; '%' and ':' escaped so estimate code and bid item can't collide (other keys unchanged). */
const part = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase().replace(/%/g, "%25").replace(/:/g, "%3A");

/** KV key of the source ledger entry (a CreatedDraft) create_draft_cor writes per Job and source, e.g. `cor-source:7001:tag:5101`. */
export const sourceKey = (jobId: number, src: CorSource) => "heavybid" in src
  ? `cor-source:${jobId}:hb:${part(src.heavybid.estimate_code)}:${part(src.heavybid.bid_item)}`
  : `cor-source:${jobId}:tag:${src.tm_tag_id}`;

/** Human label of a source, e.g. "HeavyBid B26055 bid item 2575" or "T&M Tag id 5101". */
export const sourceLabel = (src: CorSource) => "heavybid" in src
  ? `HeavyBid ${src.heavybid.estimate_code.trim()} bid item ${src.heavybid.bid_item.trim()}`
  : `T&M Tag id ${src.tm_tag_id}`;

/** Parse a ledger value; unknown shape gives {}. */
export const parseLedger = (raw: string): CreatedDraft => { try { return JSON.parse(raw) as CreatedDraft; } catch { return {}; } };

const overlaps = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

/** Pricing choices passed to preview_draft_cor (#21). */
export interface PricingInput { estimate_code?: string; markup_pct?: number; tax_pct?: number; rounding?: "up" | "nearest" }

/** Checks the PM confirms in the preview: estimate, markup basis, tax, rounding; "not stated" when missing. */
export function pricingChecks(p: PricingInput): string[] {
  const ns = "not stated";
  return [
    `Estimate used: ${p.estimate_code?.trim() || ns}`,
    `Markup: ${p.markup_pct === undefined ? ns : p.markup_pct === 0 ? "none on top of the bid price" : `${p.markup_pct}% on top of the bid price`}`,
    `Tax: ${p.tax_pct === undefined ? ns : `${p.tax_pct}%`}`,
    `Rounding: ${p.rounding === undefined ? ns : p.rounding === "up" ? "unit prices rounded up to the cent" : "unit prices rounded to the nearest cent"}`,
  ];
}

/** A HeavyBid bid item as passed to preview_draft_cor; description and unit drive the #24 check. */
type BidItemInput = { estimate_code: string; bid_item: string; description?: string; unit?: string };

/** Line-item GETs in flight at once for the bid item check. */
export const LINE_ITEM_CONCURRENCY = 4;

const isVoid = (c: Rec) => corStatus(c.status) === "Void" || VOID_STAGES.includes(String(c.stage ?? "").toLowerCase());
const unitOf = (u: unknown) => (typeof u === "string" ? u.trim().toUpperCase() : "");

/**
 * Double billing by bid item description (#24): sent CORs carry no bid item number, only titles and line descriptions.
 * Title match: description equals/overlaps a non-Void COR title (no requests). Line match: description (and unit when
 * both given) equals a line on a non-Void COR; line items read newest COR first, LINE_ITEM_CONCURRENCY at a time,
 * until the subrequest budget runs out (then a coverage warning). GETs only.
 */
async function bidItemWarnings(cs: ClearstoryClient, projectId: number, items: BidItemInput[], cors: Rec[]): Promise<string[]> {
  const seen = new Set<string>();
  const described = items
    .map((it) => ({ it, desc: normalizeTitle(it.description ?? ""), unit: unitOf(it.unit) }))
    .filter(({ it, desc }) => {
      const k = sourceKey(projectId, { heavybid: it });
      if (!desc || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  if (!described.length) return [];
  const label = (it: BidItemInput) => `${sourceLabel({ heavybid: it })} "${it.description!.trim()}"`;
  const corRef = (c: Rec) => `${c.corNumber || "COR"} "${c.title}" (id ${c.id}${corStatus(c.status) ? `, ${corStatus(c.status)}` : ""})`;
  const live = cors.filter((c) => !isVoid(c)).sort((x, y) => Number(y.id) - Number(x.id));
  const out: string[] = [];
  const warned = new Set<string>(); // `${corId}:${index in described}`
  for (const c of live) {
    const t = normalizeTitle(String(c.title ?? ""));
    described.forEach((d, i) => {
      if (!overlaps(d.desc, t)) return;
      warned.add(`${c.id}:${i}`);
      out.push(`Possible double billing: ${label(d.it)} matches the title of ${corRef(c)} on this Job.`);
    });
  }
  const todo = live.filter((c) => described.some((_, i) => !warned.has(`${c.id}:${i}`)));
  let read = live.length - todo.length;
  const lineWarnings = new Map<number, string[]>(); // by position in todo, so output stays newest first
  for (let start = 0; start < todo.length; start += LINE_ITEM_CONCURRENCY) {
    const batch = todo.slice(start, start + LINE_ITEM_CONCURRENCY);
    const got = await Promise.all(batch.map((c) =>
      cs.get<Rec>(`/cors/${encodeURIComponent(String(c.id))}/line-items`).then((li) => li ?? {}, () => undefined)));
    batch.forEach((c, j) => {
      const li = got[j];
      if (!li) return;
      read++;
      const s = shapeLineItems(li);
      const lines = [s.labor, s.materials, s.equipment, s.other, s.subcontractors].flat() as Rec[];
      const ws: string[] = [];
      described.forEach((d, i) => {
        if (warned.has(`${c.id}:${i}`)) return;
        const hit = lines.some((l) => normalizeTitle(String(l.description ?? "")) === d.desc && (!d.unit || !unitOf(l.unit) || unitOf(l.unit) === d.unit));
        if (hit) ws.push(`Possible double billing: ${label(d.it)} matches a line on ${corRef(c)} on this Job.`);
      });
      lineWarnings.set(start + j, ws);
    });
    if (got.some((g) => g === undefined)) break; // budget (or Clearstory) stopped us: don't start more
  }
  for (let i = 0; i < todo.length; i++) out.push(...(lineWarnings.get(i) ?? []));
  if (read < live.length) out.push(`Bid item check covered ${read} of ${live.length} CORs on this Job (Clearstory request limit reached or line items unreadable); check the rest in Clearstory.`);
  return out;
}

/** Audit log line + KV record. Callers never pass title, description or secrets. */
async function audit(kv: KVNamespace, rec: { evt: string; preview_id: string; at: string } & Rec) {
  const line = JSON.stringify(rec);
  console.log(line);
  const key = `cor-audit:${rec.at}:${rec.preview_id}${rec.evt === "cor_preview" ? "" : `:${rec.evt}`}`;
  await kv.put(key, line, { expirationTtl: AUDIT_TTL_S });
}

export function registerDraftCorTools({ server, cs, cfg, session }: ToolContext) {
  const now = session.now ?? (() => new Date());
  server.tool(
    "preview_draft_cor",
    "Preview a draft COR before creating it in Clearstory. Sends nothing to Clearstory. Returns the Job, GC, contract(s), title, final description (with a 'Drafted via Claude by' footer), amount, warnings (e.g. possible duplicate CORs) and a preview_id. Default pricing: the HeavyBid bid price × quantity for the matching bid item; apply a markup, cost basis or actual HeavyJob hours only when the user asks. Pricing rules: (1) Use the HeavyBid estimate whose estimate code starts with the job number and whose GC/owner matches the Clearstory Job (search results can list other jobs' estimates first); prefer the Job's -PM estimate for change bid items; say which estimate you used. (2) Round each unit price up to the cent before multiplying by quantity. (3) Before pricing, read the Job's most recent CORs (get_cor) and copy their markup %, tax and rounding (e.g. tax on materials, markup on the pre-tax subtotal); state them in the description. (4) T&M: rates differ by Job, so use list_rates for the Job and match by rate_id (equipment names don't match HeavyJob). (5) Bid prices already include markup: add markup only when the PM asks, and say it is on top of the bid price. Always pass pricing (estimate_code, markup_pct, tax_pct, rounding) so the preview shows them as checks for the PM to confirm. Put the math in the description (estimate, bid item, quantity, unit, unit price, any adjustment). Always pass sources when you priced from HeavyBid bid items or T&M Tags, so double billing of the same bid item or tag is caught. Show the whole preview to the user; call create_draft_cor with the preview_id only after the user says yes. The preview expires after 15 minutes.",
    {
      ...jobArgs,
      title: z.string().describe("COR title (1-255 characters)."),
      description: z.string().describe("COR description with the pricing breakdown: estimate, bid item, quantity, unit, unit price, adjustments."),
      amount: z.number().describe("COR amount in dollars (> 0)."),
      source: z.string().optional().describe("Where the numbers came from, e.g. \"HeavyBid B26055 bid items 2575, 2555\"."),
      sources: z.object({
        heavybid: z.array(z.object({
          estimate_code: z.string().min(1),
          bid_item: z.string().min(1),
          description: z.string().optional().describe("The HeavyBid bid item description, as in HeavyBid."),
          unit: z.string().optional().describe("The bid item's unit, e.g. CY."),
        })).optional()
          .describe("HeavyBid bid items priced, e.g. [{estimate_code: \"B26055\", bid_item: \"2575\", description: \"Pond clay liner\", unit: \"CY\"}]. Always pass description and unit: they are matched against sent COR titles and lines."),
        tm_tag_ids: z.array(z.number().int()).optional().describe("Clearstory T&M Tag ids (not tag numbers) billed on this COR."),
      }).optional().describe("Structured sources for the double-billing check; always pass when priced from HeavyBid or T&M Tags."),
      pricing: z.object({
        estimate_code: z.string().optional().describe("HeavyBid estimate used, e.g. \"J2608-PM\"."),
        markup_pct: z.number().min(0).optional().describe("Markup % added on top of the bid price (0 = none; bid prices already include markup)."),
        tax_pct: z.number().min(0).optional().describe("Tax % applied, as on the Job's recent CORs."),
        rounding: z.enum(["up", "nearest"]).optional().describe("How unit prices were rounded to the cent (CORs usually round up)."),
      }).optional().describe("Pricing choices, echoed as checks in the preview for the PM to confirm."),
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
      // Deduped by ledger key (same normalized bid item / tag id once).
      const seenSrc = new Set<string>();
      const sources = ([
        ...(a.sources?.heavybid ?? []).map(({ estimate_code, bid_item }) => ({ heavybid: { estimate_code, bid_item } })),
        ...(a.sources?.tm_tag_ids ?? []).map((tm_tag_id) => ({ tm_tag_id })),
      ] as CorSource[]).filter((s) => {
        const k = sourceKey(projectId, s);
        if (seenSrc.has(k)) return false;
        seenSrc.add(k);
        return true;
      });
      // Double billing (#20): T&M Tags already on a non-Void COR on the Job, then the source ledger (drafts aren't listed).
      const onCor = new Set<string>();
      for (const src of sources) {
        if (!("tm_tag_id" in src)) continue;
        for (const c of cors.records) {
          const status = corStatus(c.status);
          if (status === "Void" || !tmTagIds(c).includes(src.tm_tag_id)) continue;
          onCor.add(`${src.tm_tag_id}:${c.id}`);
          warnings.push(`Possible double billing: ${sourceLabel(src)} is already on ${c.corNumber || "COR"} "${c.title}" (id ${c.id}${status ? `, ${status}` : ""}) on this Job.`);
        }
      }
      warnings.push(...await bidItemWarnings(cs, projectId, a.sources?.heavybid ?? [], cors.records));
      const ledgerRaws = await Promise.all(sources.map((src) => session.kv.get(sourceKey(projectId, src))));
      for (const [i, src] of sources.entries()) {
        const raw = ledgerRaws[i];
        if (raw === null) continue;
        const d = parseLedger(raw);
        if ("tm_tag_id" in src && onCor.has(`${src.tm_tag_id}:${d.cor_id}`)) continue;
        const by = [d.email ? `by ${d.email}` : "", day(d.created_at)].filter(Boolean).join(", ");
        warnings.push(d.state === "unknown"
          ? `Possible double billing: ${sourceLabel(src)} was in a create of a draft COR via Claude on this Job with an unknown outcome${by ? ` (${by})` : ""}. Check Clearstory; it may not show in Clearstory's COR list until sent.`
          : `Possible double billing: ${sourceLabel(src)} is already on ${d.cor_number ?? "a draft COR"} (${[d.cor_id !== undefined ? `COR id ${d.cor_id}` : "", by].filter(Boolean).join(", ")}), created via Claude on this Job. It may not show in Clearstory's COR list until sent.`);
      }
      if (cors.scope === "partial") warnings.push("Duplicate check incomplete: Clearstory request limit reached before every COR on the Job was read.");
      const ledger = await session.kv.get(createdKey(projectId, title));
      if (ledger !== null) {
        const d = parseLedger(ledger); // unknown shape: still warn
        const info = [d.cor_id !== undefined ? `COR id ${d.cor_id}` : d.cor_number, d.email ? `by ${d.email}` : "", day(d.created_at)].filter(Boolean).join(", ");
        warnings.push(d.state === "unknown"
          ? `Possible duplicate: a create of a draft COR with this title via Claude on this Job had an unknown outcome${info ? ` (${info})` : ""}. Check Clearstory; it may not show in Clearstory's COR list until sent.`
          : `Possible duplicate: a draft COR with this title was already created via Claude on this Job${info ? ` (${info})` : ""}. It may not show in Clearstory's COR list until sent.`);
      }
      const t = now();
      const footer = [`Drafted via Claude by ${session.email} on ${localDay(t)}.`, a.source?.trim() ? `Source: ${a.source.trim()}` : "",
        sources.length ? `Sources: ${sources.map(sourceLabel).join("; ")}` : ""].filter(Boolean).join("\n");
      const description = `${a.description.trim()}\n\n${footer}`;
      const previewId = crypto.randomUUID();
      // One contract: its GC. Several: the Job's GC (Clearstory picks the contract; see the warning).
      const gc = contracts.length === 1 ? contractGc(contracts[0]) : job.customer as string | undefined;
      const stored: StoredPreview = {
        body: { projectId, title, description, amount },
        job_number: jobNumber,
        email: session.email,
        exp: new Date(t.getTime() + PREVIEW_TTL_S * 1000).toISOString(),
        ...(sources.length ? { sources } : {}),
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
        ...(a.pricing ? { checks: pricingChecks(a.pricing) } : {}),
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
      const at = now().toISOString();
      const base = { email: session.email, job: p.job_number, amount: p.body.amount };
      /** Ledger entry for this Job and title (duplicate check in later previews). */
      const record = async (e: Pick<CreatedDraft, "state" | "cor_id" | "cor_number">) => {
        const entry: CreatedDraft = { ...e, email: session.email, created_at: at };
        await session.kv.put(createdKey(p.body.projectId, p.body.title), JSON.stringify(entry), { expirationTtl: LEDGER_TTL_S });
        for (const src of p.sources ?? []) await session.kv.put(sourceKey(p.body.projectId, src), JSON.stringify(entry), { expirationTtl: SOURCE_TTL_S });
        return entry;
      };
      /** Post-POST ledger + audit; a KV failure must never turn a created/unknown COR into an error (the user would recreate it). */
      const bookkeep = async (e: Pick<CreatedDraft, "state" | "cor_id" | "cor_number">, evt: Rec & { evt: string }) => {
        try {
          await record(e);
          await audit(session.kv, { ...evt, preview_id, at });
          return {};
        } catch (err) {
          console.error(JSON.stringify({ evt: "cor_bookkeeping_failed", state: e.state, cor_id: e.cor_id, preview_id, error: String(err) }));
          return { note: "The duplicate-check ledger for this draft COR was not fully saved, so a later preview may not warn about it. Do not create it again." };
        }
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
        // No retry (no idempotency key) and no lookup: GET /cors does not list drafts. The user checks the Draft COR Log.
        const note = await bookkeep({ state: "unknown" }, { evt: "cor_unknown", ...base });
        return reply({
          state: "unknown",
          message: `${e.message} Do not retry: tell the user to check the Draft COR Log for Job ${p.job_number} in Clearstory before previewing again.`,
          job_number: p.job_number,
          ...note,
        });
      }
      const note = await bookkeep({ state: "created", cor_id: cor.id, cor_number: cor.corNumber },
        { evt: "cor_created", ...base, cor_id: cor.id, cor_number: cor.corNumber });
      return reply(compact({
        state: "created", cor_id: cor.id, cor_number: cor.corNumber, status: corStatus(cor.status),
        amount: money(cor.requestedAmount) ?? p.body.amount, job_number: p.job_number, ...note,
      }));
    },
  );
}
