// Per IP token buckets. One RateLimitDO per client address keeps a bucket per route class:
// generous for /mcp (a conversation makes several calls a turn), tight for /demo/* (each may build a house).
// Buckets live in memory: an evicted object starts full again, which only ever errs towards letting
// someone through, and a hot object (the only kind that can be abused) stays resident.

import { DurableObject } from 'cloudflare:workers';
import { takeToken, type Bucket, type TakeResult } from './bucket.ts';

export class RateLimitDO extends DurableObject {
  private buckets = new Map<string, Bucket>();

  take(name: string, perMinute: number, cost = 1, nowMs: number = Date.now()): TakeResult {
    const { bucket, result } = takeToken(this.buckets.get(name), nowMs, perMinute, cost);
    this.buckets.set(name, bucket);
    return result;
  }
}
