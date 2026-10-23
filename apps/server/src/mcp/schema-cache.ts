// createMcpHandler builds a fresh McpServer per request, and registerTool converts
// every input AND output schema to JSON Schema at registration (SEP-2243 scan +
// outputSchemaJson), then tools/list converts them all again. With 11 tools that is
// 22 to 44 zod to JSON conversions per request. This wrapper computes each JSON Schema
// once per isolate and hands back the frozen cached object afterwards.
// It implements the public StandardSchemaWithJSON interface (Standard Schema V1 +
// StandardJSONSchemaV1); validation still runs through zod's own ~standard.validate.
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

type JsonOpts = Parameters<StandardSchemaWithJSON['~standard']['jsonSchema']['input']>[0];
import type * as z from 'zod/v4';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export function cachedJson<S extends z.ZodType>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const std = schema['~standard'] as unknown as StandardSchemaWithJSON<z.input<S>, z.output<S>>['~standard'];
  if (!std.jsonSchema) throw new Error('zod >= 4.2 required (~standard.jsonSchema missing)');
  const memo = new Map<string, Record<string, unknown>>();
  const conv =
    (io: 'input' | 'output') =>
    (opts: JsonOpts) => {
      const key = `${io}|${opts.target}`;
      let v = memo.get(key);
      if (!v) {
        v = deepFreeze(std.jsonSchema[io](opts));
        memo.set(key, v);
      }
      return v;
    };
  return {
    '~standard': {
      version: 1,
      vendor: std.vendor,
      validate: std.validate,
      ...(std.types ? { types: std.types } : {}),
      jsonSchema: { input: conv('input'), output: conv('output') }
    }
  };
}
