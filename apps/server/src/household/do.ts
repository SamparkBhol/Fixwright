// HouseholdDO: one SQLite backed Durable Object per household (getByName(token)). Thin: the logic lives in
// household.ts so it runs the same way under node:sqlite in tests and the CPU harness.

import { DurableObject } from 'cloudflare:workers';
import type { ToolInputMap, ToolName } from '@fixwright/protocol';
import { config, type Env } from '../env.ts';
import type { Db, Row, Sql, SqlValue } from './db.ts';
import { createHousehold, type DemoOp, type DemoReply, type Household } from './household.ts';
import type { ToolReply } from './tools.ts';
import type { Push } from './due.ts';

export class HouseholdDO extends DurableObject<Env> {
  private household: Household | undefined;
  private householdId: string | undefined;

  private open(householdId: string): Household {
    if (this.household && this.householdId === householdId) return this.household;
    const cfg = config(this.env);
    if (!cfg.secret) throw new Error('CONFIRM_SECRET is not set');
    const storage = this.ctx.storage;
    const sql: Sql = {
      exec: <T extends Row>(query: string, ...bindings: SqlValue[]) => storage.sql.exec<T>(query, ...bindings),
    };
    const db: Db = { sql, transaction: (fn) => storage.transactionSync(fn) };
    this.household = createHousehold(db, householdId, {
      secret: cfg.secret,
      tokenKey: cfg.tokenKey ?? cfg.secret,
      ntfyBase: cfg.ntfyBase,
      demoStart: cfg.demoStart,
      allowHaLink: cfg.allowHaLink,
      wipeAll: async () => {
        await storage.deleteAll();
        await storage.put('household_id', householdId);
      },
      setAlarm: async (at) => {
        if (at === null) await storage.deleteAlarm();
        else await storage.setAlarm(at);
      },
    });
    this.householdId = householdId;
    void storage.put('household_id', householdId);
    return this.household;
  }

  /** Household id for an alarm wake up, which arrives without a request. */
  private async remembered(): Promise<Household | undefined> {
    if (this.household) return this.household;
    const id = await this.ctx.storage.get<string>('household_id');
    return id ? this.open(id) : undefined;
  }

  async tool<N extends ToolName>(householdId: string, name: N, input: ToolInputMap[N]): Promise<ToolReply> {
    return this.open(householdId).tool(name, input);
  }

  async demo(householdId: string, op: DemoOp): Promise<DemoReply> {
    return this.open(householdId).demo(op);
  }

  override async alarm(): Promise<void> {
    const h = await this.remembered();
    if (!h) return;
    const out: { ran: number; pushes: Push[] } = await h.alarm();
    if (out.ran > 0) console.log(`[alarm] ran ${out.ran} due items, ${out.pushes.length} pushes`);
  }
}
