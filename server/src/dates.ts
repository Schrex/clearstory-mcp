// Date inputs: tools take strict YYYY-MM-DD and send Clearstory ISO-8601 UTC
// (start of day for from*, end of day for until*).
import { z } from "zod";

export const DATE_HELP = "Date as YYYY-MM-DD.";
/** zod field for a YYYY-MM-DD input. Validation (with the field name in the error) happens in dateRange. */
export const dayArg = (what: string) => z.string().optional().describe(`${what} ${DATE_HELP}`);

/** Validate one YYYY-MM-DD value (real calendar date); the error names the field. */
export function parseDay(field: string, v: string): string {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00.000Z`) : NaN;
  const ok = Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  if (!ok) throw new Error(`${field} must be a date as YYYY-MM-DD (got '${v}').`);
  return v;
}

/**
 * Read args[fromField] / args[untilField] (either may be absent) → { from: "<d>T00:00:00.000Z", until: "<d>T23:59:59.999Z" }.
 * Errors name the bad field; from after until is an error.
 */
export function dateRange(args: Record<string, unknown>, fromField: string, untilField: string): { from?: string; until?: string } {
  const get = (f: string) => {
    const v = args[f];
    if (v === undefined || v === null) return undefined;
    return parseDay(f, String(v));
  };
  const from = get(fromField);
  const until = get(untilField);
  if (from && until && from > until) throw new Error(`${fromField} (${from}) is after ${untilField} (${until}).`);
  const out: { from?: string; until?: string } = {};
  if (from) out.from = `${from}T00:00:00.000Z`;
  if (until) out.until = `${until}T23:59:59.999Z`;
  return out;
}
