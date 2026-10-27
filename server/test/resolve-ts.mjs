import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The OAuth library imports the Workers runtime module; Node only needs the class to exist.
const CLOUDFLARE_WORKERS_STUB = "data:text/javascript,export class WorkerEntrypoint {}";

// Source files import "./x.js" so wrangler can bundle the .ts. Node's test runner needs the .ts file.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: CLOUDFLARE_WORKERS_STUB, shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
    const tsUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsUrl.href, context);
  }
  return nextResolve(specifier, context);
}
