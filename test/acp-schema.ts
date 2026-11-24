/**
 * The ACP v1 schema, as published, and a check of a message against it.
 *
 * The schema is vendored, not fetched: a test that reads the network can be told anything. It is
 * `schema/v1/schema.json` from agentclientprotocol/agent-client-protocol at commit
 * d3ac0e6d8b1132c9a749a4210f04bb788c9a75a4 (2026-11-24), byte for byte. Refresh it by replacing the file and the
 * commit above together.
 *
 * Strict where a client is lenient, on purpose: the schema marks plan entries
 * `x-deserialize-skip-invalid-items`, so a client built from it SILENTLY DROPS an entry with no `priority`. A
 * validator that skipped invalid items the same way would pass exactly the bug it is here to catch (G-362).
 */
import { readFileSync } from 'node:fs';
import { compile } from '@particle-academy/fancy-schema';

const schema = JSON.parse(readFileSync(new URL('./fixtures/acp-v1-schema.json', import.meta.url), 'utf8')) as {
  readonly $defs: Record<string, unknown>;
};

function checker(definition: string): (value: unknown) => readonly string[] {
  if (!(definition in schema.$defs)) throw new Error(`the ACP schema has no ${definition}`);
  const check = compile({ $defs: schema.$defs, $ref: `#/$defs/${definition}` });
  return (value) => {
    const result = check(value);
    return result.valid ? [] : result.errors.map((error) => `${error.instancePath || '/'} ${error.message}`);
  };
}

/** Problems with one `session/update` params object (`{sessionId, update}`); empty means valid. */
export const sessionNotificationProblems = checker('SessionNotification');

/** Problems with one bare `SessionUpdate` (what a driver hands `onUpdate`); empty means valid. */
export function sessionUpdateProblems(update: unknown): readonly string[] {
  return sessionNotificationProblems({ sessionId: 'schema-check', update });
}

/** Problems with one `session/request_permission` params object. */
export const permissionRequestProblems = checker('RequestPermissionRequest');
