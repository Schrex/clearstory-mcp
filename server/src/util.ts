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
