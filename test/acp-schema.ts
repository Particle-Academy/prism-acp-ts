/**
 * The ACP v1 schema, as published, and a check of a message against it.
 *
 * The schema is vendored, not fetched: a test that reads the network can be told anything. It is
 * `schema/v1/schema.json` from agentclientprotocol/agent-client-protocol at commit
 * d3ac0e6d8b1132c9a749a4210f04bb788c9a75a4 (2026-11-24), byte for byte; prism-acp vendors the same file. Refresh both
 * together, with the commit above. vendor.test.ts pins its bytes by hash.
 *
 * The validator is Prism's own, the same one prism-acp has in `tests/Support/AcpSchema.php` (Wish ruling 2026-11-25:
 * Prism owns its validators). It is the subset of JSON Schema 2020-12 that the definitions checked here actually
 * reach, and it FAILS CLOSED: a `$ref` outside this one document's `$defs`, or an assertion keyword it does not
 * implement, throws rather than passing. A validator that skipped what it did not understand would report every
 * message valid. acp-schema.test.ts proves both refusals, and walks the schema to prove nothing reachable is skipped.
 *
 * Strict where a client is lenient, on purpose: the schema marks plan entries
 * `x-deserialize-skip-invalid-items`, so a client built from it SILENTLY DROPS an entry with no `priority`. A
 * validator that skipped invalid items the same way would pass exactly the bug it is here to catch (G-362).
 *
 * The value is checked as the wire carries it (encoded, then decoded), so a value JSON cannot carry is caught.
 */
import { readFileSync } from 'node:fs';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const schema = JSON.parse(readFileSync(new URL('./fixtures/acp-v1-schema.json', import.meta.url), 'utf8')) as {
  readonly $defs: JsonObject;
};

/** Keywords that only describe; they assert nothing. Any `x-*` keyword is an annotation too. */
export const ANNOTATIONS: ReadonlySet<string> = new Set([
  'description', 'title', 'default', 'examples', 'format', 'discriminator', '$schema', '$comment', 'deprecated',
  'readOnly', 'writeOnly',
]);

/** The assertion and applicator keywords implemented here. Anything else that is not an annotation throws. */
export const IMPLEMENTED: ReadonlySet<string> = new Set([
  '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items', 'allOf', 'anyOf', 'oneOf', 'not', 'const',
  'enum', 'minimum', 'maximum', 'minLength',
]);

const DEFS_PREFIX = '#/$defs/';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(path: string): string {
  return path === '' ? '/' : path;
}

/** One JSON encode-then-decode, so the check sees the wire's value. `undefined` (nothing on the wire) throws. */
function wire(value: unknown): Json {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('the value has no JSON encoding');
  return JSON.parse(text) as Json;
}

function resolve(defs: JsonObject, reference: Json): Json {
  if (typeof reference !== 'string' || !reference.startsWith(DEFS_PREFIX)) {
    throw new Error(`unresolvable $ref ${JSON.stringify(reference)}`);
  }
  const name = reference.slice(DEFS_PREFIX.length);
  if (!Object.hasOwn(defs, name)) throw new Error(`unresolvable $ref ${reference}`);
  return defs[name] as Json;
}

function typeMatches(type: Json, value: Json): boolean {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: throw new Error(`unknown type ${JSON.stringify(type)}`);
  }
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key] as Json);
    return out;
  }
  return value;
}

function same(a: Json, b: Json): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function list(argument: Json, keyword: string, path: string): Json[] {
  if (!Array.isArray(argument)) throw new Error(`${keyword} at ${at(path)} is not an array`);
  return argument;
}

function check(defs: JsonObject, node: Json, value: Json, path: string, errors: string[]): void {
  if (node === true) return;
  if (node === false) {
    errors.push(`${at(path)} is not allowed`);
    return;
  }
  if (!isObject(node)) throw new Error(`schema at ${at(path)} is not an object or boolean`);

  for (const [keyword, argument] of Object.entries(node)) {
    if (ANNOTATIONS.has(keyword) || keyword.startsWith('x-')) continue;
    switch (keyword) {
      case '$ref':
        check(defs, resolve(defs, argument), value, path, errors);
        break;
      case 'type': {
        const types = Array.isArray(argument) ? argument : [argument];
        if (!types.some((type) => typeMatches(type, value))) errors.push(`${at(path)} must be ${types.join(' or ')}`);
        break;
      }
      case 'properties':
        if (!isObject(argument)) throw new Error(`properties at ${at(path)} is not an object`);
        if (!isObject(value)) break;
        for (const [name, sub] of Object.entries(argument)) {
          if (Object.hasOwn(value, name)) check(defs, sub, value[name] as Json, `${path}/${name}`, errors);
        }
        break;
      case 'required':
        if (!isObject(value)) break;
        for (const name of list(argument, keyword, path)) {
          if (typeof name !== 'string') throw new Error(`required at ${at(path)} names a non-string`);
          if (!Object.hasOwn(value, name)) errors.push(`${at(path)} is missing required property ${name}`);
        }
        break;
      case 'additionalProperties': {
        if (Object.hasOwn(node, 'patternProperties')) throw new Error(`unsupported schema keyword patternProperties at ${at(path)}`);
        if (!isObject(value)) break;
        const known = isObject(node.properties) ? node.properties : {};
        for (const [name, entry] of Object.entries(value)) {
          if (!Object.hasOwn(known, name)) check(defs, argument, entry, `${path}/${name}`, errors);
        }
        break;
      }
      case 'items':
        // Strict: the schema's x-deserialize-skip-invalid-items is how a CLIENT silently drops a bad plan entry. A
        // validator that did the same would pass the very bug it is here for.
        if (!Array.isArray(value)) break;
        value.forEach((entry, index) => check(defs, argument, entry, `${path}/${index}`, errors));
        break;
      case 'allOf':
        for (const sub of list(argument, keyword, path)) check(defs, sub, value, path, errors);
        break;
      case 'anyOf':
      case 'oneOf': {
        const alternatives = list(argument, keyword, path);
        let matched = 0;
        for (const alternative of alternatives) {
          const inner: string[] = [];
          check(defs, alternative, value, path, inner);
          if (inner.length === 0) matched += 1;
        }
        if (keyword === 'oneOf' ? matched !== 1 : matched === 0) {
          errors.push(`${at(path)} matched ${matched} of the ${alternatives.length} alternatives`);
        }
        break;
      }
      case 'not': {
        const inner: string[] = [];
        check(defs, argument, value, path, inner);
        if (inner.length === 0) errors.push(`${at(path)} matched a schema it must not`);
        break;
      }
      case 'const':
        if (!same(argument, value)) errors.push(`${at(path)} must be ${JSON.stringify(argument)}`);
        break;
      case 'enum':
        if (!list(argument, keyword, path).some((option) => same(option, value))) errors.push(`${at(path)} is not one of the allowed values`);
        break;
      case 'minimum':
        if (typeof argument !== 'number') throw new Error(`minimum at ${at(path)} is not a number`);
        if (typeof value === 'number' && value < argument) errors.push(`${at(path)} must be >= ${argument}`);
        break;
      case 'maximum':
        if (typeof argument !== 'number') throw new Error(`maximum at ${at(path)} is not a number`);
        if (typeof value === 'number' && value > argument) errors.push(`${at(path)} must be <= ${argument}`);
        break;
      case 'minLength':
        if (typeof argument !== 'number') throw new Error(`minLength at ${at(path)} is not a number`);
        // Code points, as JSON Schema counts them, not UTF-16 units.
        if (typeof value === 'string' && [...value].length < argument) errors.push(`${at(path)} is shorter than ${argument}`);
        break;
      default:
        // Fail closed: a keyword that asserts something and is not implemented here must not pass silently.
        throw new Error(`unsupported schema keyword ${keyword} at ${at(path)}`);
    }
  }
}

/**
 * Problems with `value` against a schema whose `$ref`s point into `defs` (the ACP schema's by default); empty means
 * valid. Throws, rather than passing, on a schema it cannot fully evaluate.
 */
export function validate(node: unknown, value: unknown, defs: JsonObject = schema.$defs): readonly string[] {
  const errors: string[] = [];
  check(defs, wire(node), wire(value), '', errors);
  return errors;
}

/** The vendored schema's `$defs`, for the tests that walk it. */
export const acpDefs: Readonly<JsonObject> = schema.$defs;

function checker(definition: string): (value: unknown) => readonly string[] {
  if (!Object.hasOwn(schema.$defs, definition)) throw new Error(`the ACP schema has no ${definition}`);
  return (value) => validate({ $ref: `${DEFS_PREFIX}${definition}` }, value);
}

/** Problems with one `session/update` params object (`{sessionId, update}`); empty means valid. */
export const sessionNotificationProblems = checker('SessionNotification');

/** Problems with one bare `SessionUpdate` (what a driver hands `onUpdate`); empty means valid. */
export function sessionUpdateProblems(update: unknown): readonly string[] {
  return sessionNotificationProblems({ sessionId: 'schema-check', update });
}

/** Problems with one `session/request_permission` params object. */
export const permissionRequestProblems = checker('RequestPermissionRequest');
