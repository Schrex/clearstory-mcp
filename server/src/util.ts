// Shared tool helpers.
export type Rec = Record<string, unknown>;

/** Round non-integers to 4 dp in JSON output (float noise). */
export const noNoise = (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
/** MCP tool result with a JSON text body. */
export const reply = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, noNoise, 2) }] });
/** Copy the listed keys, dropping null/undefined/"". */
export const pick = (r: Rec, keys: string[]) => {
  const o: Rec = {};
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== "") o[k] = r[k];
  return o;
};
/** Drop null/undefined/"" values (keeps false and 0). */
export const compact = (r: Rec) => pick(r, Object.keys(r));

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
/** Dollars: 2 dp. Non-numbers → undefined (so pick/compact drops them). */
export const money = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Math.round(n * 100) / 100; };
/** Hours / quantities: 4 dp. */
export const hours = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Math.round(n * 1e4) / 1e4; };
/** Clearstory user/person → "First Last", else their email. */
export const personName = (p: unknown): string | undefined => {
  const r = p as Rec | null | undefined;
  return r ? [r.firstName, r.lastName].filter(Boolean).join(" ") || (r.email as string | undefined) : undefined;
};
/** ISO timestamp → YYYY-MM-DD (the date as Clearstory stored it, UTC). */
export const day = (v: unknown) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : undefined);
