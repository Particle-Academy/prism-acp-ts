import { describe, expect, it } from 'vitest';
import { BASE_ALLOW, OUTRANKING_CREDENTIALS, childEnv } from '../src/env.js';

const SECRET = 'sk-ant-api03-THIS-MUST-NOT-REACH-THE-CHILD';

describe('the credential strip', () => {
  it('withholds an inherited ANTHROPIC_API_KEY', () => {
    const { env, withheld } = childEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: SECRET });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(withheld).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('reports the NAME it withheld and never the value', () => {
    const { env, withheld } = childEnv({ ANTHROPIC_API_KEY: SECRET });
    expect(JSON.stringify({ env, withheld })).not.toContain(SECRET);
    expect(JSON.stringify({ env, withheld })).not.toContain('sk-ant');
  });

  it('withholds a LOWERCASE spelling, because Windows env names are case-insensitive', () => {
    // The trap: `anthropic_api_key` reaches the child exactly as the uppercase
    // name does, while sailing past any case-sensitive comparison. Same shape
    // as the trailing space that defeated prism-human-plus's tool-name
    // reservation in three languages at once.
    const { env, withheld } = childEnv({ anthropic_api_key: SECRET });
    expect(Object.values(env)).not.toContain(SECRET);
    expect(withheld).toEqual(['anthropic_api_key']);
  });

  it('withholds a MixedCase spelling', () => {
    const { env } = childEnv({ Anthropic_Api_Key: SECRET });
    expect(Object.values(env)).not.toContain(SECRET);
  });

  it('withholds every name in the outranking list', () => {
    const parent = Object.fromEntries(OUTRANKING_CREDENTIALS.map((n) => [n, SECRET]));
    const { env, withheld } = childEnv(parent);
    expect(Object.keys(env)).toEqual([]);
    expect(withheld.sort()).toEqual([...OUTRANKING_CREDENTIALS].sort());
  });

  it('refuses an outranking credential EVEN when the caller allow-lists it', () => {
    // The whole point of allow-list-first: adding the name to `allow` must not
    // be a route to a per-token bill. Getting past this requires the
    // explicitly-named option below, which nobody reaches for by accident.
    const { env, withheld } = childEnv(
      { ANTHROPIC_API_KEY: SECRET },
      { allow: ['ANTHROPIC_API_KEY'] },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(withheld).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('passes one through only under the explicitly-named option', () => {
    // The positive control. Without it, an env builder that returned {} for
    // everything would pass every test above -- which is the failure this
    // estate keeps finding in guards nobody tried from the other side.
    const { env, withheld } = childEnv(
      { ANTHROPIC_API_KEY: SECRET },
      { allowSubscriptionOverridingCredentials: true },
    );
    expect(env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(withheld).toEqual([]);
  });
});

describe('the allow-list', () => {
  it('passes through what a CLI needs to run', () => {
    const { env } = childEnv({ PATH: '/usr/bin', HOME: '/home/u', SYSTEMROOT: 'C:\\Windows' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', SYSTEMROOT: 'C:\\Windows' });
  });

  it('drops an unlisted variable rather than passing it on', () => {
    // Not hostile, just not ours to forward: the child gets what it needs and
    // nothing it merely happened to inherit.
    const { env } = childEnv({ PATH: '/usr/bin', MY_COMPANY_INTERNAL_TOKEN: 'x' });
    expect(env.MY_COMPANY_INTERNAL_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('passes an extra the caller asked for', () => {
    const { env } = childEnv({ CLAUDE_CONFIG_DIR: '/c' }, { allow: ['CLAUDE_CONFIG_DIR'] });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
  });

  it('matches allow-list names case-insensitively too', () => {
    // Otherwise `Path` on Windows is dropped and the child cannot find its own
    // interpreter -- which presents as a hang, not as a missing variable.
    const { env } = childEnv({ Path: 'C:\\bin' });
    expect(env.Path).toBe('C:\\bin');
  });

  it('skips a variable whose value is undefined', () => {
    const { env } = childEnv({ PATH: undefined, HOME: '/home/u' });
    expect('PATH' in env).toBe(false);
    expect(env.HOME).toBe('/home/u');
  });

  it('lets `set` win over the parent', () => {
    const { env } = childEnv({ PATH: '/usr/bin' }, { set: { PATH: '/opt/bin' } });
    expect(env.PATH).toBe('/opt/bin');
  });
});

describe('it never touches the ambient environment', () => {
  it('leaves process.env alone', () => {
    // The workspace may hold an API key on purpose -- other consumers beside
    // this one legitimately bill per token. Cleaning the ambient environment
    // would fix our call and silently break theirs.
    process.env.PRISM_ACP_AMBIENT_PROBE = 'present';
    try {
      childEnv({ ...process.env, ANTHROPIC_API_KEY: SECRET });
      expect(process.env.PRISM_ACP_AMBIENT_PROBE).toBe('present');
    } finally {
      delete process.env.PRISM_ACP_AMBIENT_PROBE;
    }
  });
});

describe('the lists themselves', () => {
  it('has no name in both lists', () => {
    // A name in both would be permanently unreachable and the conflict would be
    // silent -- the allow-list would read as if it worked.
    const allow = new Set(BASE_ALLOW.map((n) => n.toUpperCase()));
    const both = OUTRANKING_CREDENTIALS.filter((n) => allow.has(n.toUpperCase()));
    expect(both).toEqual([]);
  });

  it('is non-empty in both directions, so neither list can go vacuous', () => {
    expect(OUTRANKING_CREDENTIALS.length).toBeGreaterThan(4);
    expect(BASE_ALLOW.length).toBeGreaterThan(10);
  });
});
