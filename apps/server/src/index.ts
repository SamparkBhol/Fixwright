// Fixwright Worker entry: MCP at /mcp, demo routes, /assistant/route, /health, and the host simulator's
// static files for everything else. Households live in HouseholdDO, rate limits in RateLimitDO.

import { warmUp } from '@fixwright/engine';
import { createApp } from './app.ts';
import { config, type Env } from './env.ts';
import { warmTemplate } from './household/template.ts';
import { primeSchemas } from './mcp/server.ts';

export { HouseholdDO } from './household/do.ts';
export { RateLimitDO } from './ratelimit.ts';

// Module scope counts against the startup limit, not a request's CPU: convert every tool schema once, run
// each engine path on a tiny house so V8 and the Intl time zone data are warm, and rebase the demo house
// template once (HOUSEHOLD_CPU.json).
primeSchemas();
await warmUp();
warmTemplate();

let app: ((request: Request) => Promise<Response>) | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    app ??= createApp(
      {
        tool: (household, name, input) => env.HOUSEHOLD.getByName(household).tool(household, name, input),
        demo: (household, op) => env.HOUSEHOLD.getByName(household).demo(household, op),
        take: (ip, bucket, perMinute, cost) => env.RATE_LIMIT.getByName(ip).take(bucket, perMinute, cost ?? 1),
        assets: (r) => env.ASSETS.fetch(r),
      },
      () => config(env),
    );
    return app(request);
  },
} satisfies ExportedHandler<Env>;
