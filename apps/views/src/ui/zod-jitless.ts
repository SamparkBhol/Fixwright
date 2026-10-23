// Must be the first import of every view entry. Setting jitless before zod and the MCP schemas load stops
// zod's new Function("") probe, which raises one CSP unsafe-eval violation per load.
// ext-apps sets jitless too, but only in the App constructor, after the schemas exist.
const g = globalThis as { __zod_globalConfig?: Record<string, unknown> };
g.__zod_globalConfig = { ...(g.__zod_globalConfig ?? {}), jitless: true };

export {};
