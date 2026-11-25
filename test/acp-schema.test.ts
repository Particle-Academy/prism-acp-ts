/*
 * The schema check is only worth something if it cannot pass what it does not understand. These pin that it fails
 * closed, that it reaches every keyword the checked definitions use, and that it catches the G-362 shapes a lenient
 * client would silently drop. prism-acp's AcpSchemaTest pins the same rows for the PHP validator.
 */
import { describe, expect, it } from 'vitest';
import {
  acpDefs, ANNOTATIONS, IMPLEMENTED, permissionRequestProblems, sessionNotificationProblems, sessionUpdateProblems, validate,
} from './acp-schema.js';

const MAP = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);
const ONE = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems']);
const LIST = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** Every keyword reachable from `roots` through `$ref`, and every `$ref` seen, walking schema positions only. */
function reachable(roots: readonly string[]): { keywords: Set<string>; refs: Set<string> } {
  const keywords = new Set<string>();
  const refs = new Set<string>();
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    for (const [keyword, argument] of Object.entries(node)) {
      keywords.add(keyword);
      if (keyword === '$ref') {
        refs.add(String(argument));
        const name = String(argument).replace('#/$defs/', '');
        if (!seen.has(name)) {
          seen.add(name);
          walk(acpDefs[name]);
        }
      } else if (MAP.has(keyword)) {
        for (const sub of Object.values(argument as object)) walk(sub);
      } else if (ONE.has(keyword)) {
        walk(argument);
      } else if (LIST.has(keyword)) {
        for (const sub of argument as unknown[]) walk(sub);
      }
    }
  };
  for (const root of roots) {
    seen.add(root);
    walk(acpDefs[root]);
  }
  return { keywords, refs };
}

describe('the Prism ACP schema validator', () => {
  it('implements or annotates every keyword the checked definitions reach, and every $ref stays in the document', () => {
    const { keywords, refs } = reachable(['SessionNotification', 'RequestPermissionRequest']);
    const unknown = [...keywords].filter((k) => !IMPLEMENTED.has(k) && !ANNOTATIONS.has(k) && !k.startsWith('x-'));
    expect(unknown).toEqual([]);
    const outside = [...refs].filter((ref) => !ref.startsWith('#/$defs/') || !Object.hasOwn(acpDefs, ref.slice('#/$defs/'.length)));
    expect(outside).toEqual([]);
    // The walk itself reached something: an empty walk would pass the two lines above vacuously.
    expect(keywords.has('oneOf') && keywords.has('additionalProperties') && keywords.has('const') && refs.size > 50).toBe(true);
  });

  it('accepts a plan with every required field', () => {
    expect(sessionUpdateProblems({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'medium', status: 'pending' }] })).toEqual([]);
  });

  it('catches a plan entry with no priority (G-362 bug A)', () => {
    expect(sessionUpdateProblems({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] })).not.toEqual([]);
  });

  it('catches a plan entry with no priority beside valid ones: invalid items are never skipped', () => {
    const good = { content: 'a', priority: 'medium', status: 'pending' };
    expect(sessionUpdateProblems({ sessionUpdate: 'plan', entries: [good, { content: 'b', status: 'pending' }, good] })).not.toEqual([]);
  });

  it('catches a plan_update carrying a delta (G-362 bug B)', () => {
    expect(sessionUpdateProblems({ sessionUpdate: 'plan_update', delta: 'progress' })).not.toEqual([]);
  });

  it('catches an array where the wire needs an object', () => {
    expect(sessionUpdateProblems({ sessionUpdate: 'plan', entries: [], _meta: [] })).not.toEqual([]);
  });

  it('catches a notification with no sessionId, and an unknown update kind', () => {
    expect(sessionNotificationProblems({ update: { sessionUpdate: 'plan', entries: [] } })).not.toEqual([]);
    expect(sessionUpdateProblems({ sessionUpdate: 'no_such_kind' })).not.toEqual([]);
  });

  it('checks a permission request', () => {
    expect(permissionRequestProblems({})).not.toEqual([]);
  });

  it('throws on an unresolvable or out-of-document $ref rather than passing', () => {
    expect(() => validate({ $ref: '#/$defs/NoSuchThing' }, 1)).toThrow(/unresolvable/);
    expect(() => validate({ $ref: 'https://example.invalid/schema.json' }, 1)).toThrow(/unresolvable/);
    expect(() => validate({ $ref: '#/properties/a' }, 1)).toThrow(/unresolvable/);
    // An inherited name is not a definition.
    expect(() => validate({ $ref: '#/$defs/constructor' }, 1)).toThrow(/unresolvable/);
  });

  it('throws on an assertion keyword it does not implement rather than passing', () => {
    expect(() => validate({ type: 'object', unevaluatedProperties: false }, {})).toThrow(/unsupported/);
    expect(() => validate({ patternProperties: { '^a': true } }, {})).toThrow(/unsupported/);
    expect(() => validate({ additionalProperties: false, patternProperties: { '^a': true } }, {})).toThrow(/patternProperties/);
    expect(() => validate({ maxLength: 1 }, 'abc')).toThrow(/unsupported/);
    expect(() => validate({ pattern: '^a$' }, 'b')).toThrow(/unsupported/);
    expect(() => validate({ type: 'decimal' }, 1)).toThrow(/unknown type/);
  });

  it('treats x-*, format, discriminator, title and description as annotations', () => {
    const node = { 'x-anything': 1, format: 'int64', discriminator: { propertyName: 'k' }, title: 't', description: 'd' };
    expect(validate(node, 'x')).toEqual([]);
  });

  it('reports oneOf matching more than one alternative, and anyOf matching none', () => {
    expect(validate({ oneOf: [{ type: 'string' }, { type: 'string' }] }, 'x')).not.toEqual([]);
    expect(validate({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 1)).not.toEqual([]);
  });

  it('asserts each implemented keyword from both sides', () => {
    const rows: [unknown, unknown, unknown][] = [
      [{ type: 'integer' }, 2, 2.5],
      [{ type: ['string', 'null'] }, null, 1],
      [{ required: ['a'] }, { a: 1 }, { b: 1 }],
      [{ properties: { a: { type: 'string' } } }, { a: 'x' }, { a: 1 }],
      [{ properties: { a: true }, additionalProperties: false }, { a: 1 }, { a: 1, b: 2 }],
      [{ items: { type: 'string' } }, ['x'], ['x', 1]],
      [{ allOf: [{ type: 'number' }, { minimum: 0 }] }, 0, -1],
      [{ not: { const: 'x' } }, 'y', 'x'],
      [{ const: { a: 1, b: 2 } }, { b: 2, a: 1 }, { a: 1 }],
      [{ enum: ['a', 'b'] }, 'b', 'c'],
      [{ maximum: 3 }, 3, 4],
      [{ minLength: 2 }, '\u{1F600}\u{1F600}', '\u{1F600}'],
      [false, undefined, 1],
    ];
    for (const [node, good, bad] of rows) {
      if (good !== undefined) expect(validate(node, good), JSON.stringify(node)).toEqual([]);
      expect(validate(node, bad), JSON.stringify(node)).not.toEqual([]);
    }
  });

  it('checks the wire value: a property JSON drops is absent', () => {
    expect(validate({ required: ['a'] }, { a: undefined })).not.toEqual([]);
    expect(() => validate(true, undefined)).toThrow(/no JSON encoding/);
  });
});
