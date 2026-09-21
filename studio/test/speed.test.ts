import { describe, expect, it } from 'vitest';

import type { RoadProperties } from '../src/api/types.js';
import {
  CONDITIONAL_STATES,
  SPEED_DIRECTIONS,
  SPEED_LIMIT_KINDS,
  SPEED_UNITS,
  VARIABLE_STATES,
  indeterminateFact,
  limitLabel,
  parseConditional,
  parseDirectionalSpeeds,
  parseSpeedFact,
  parseSpeedLimit,
  parseVariable,
  readFeatureSpeeds,
  readSpeeds,
  speedEntries,
  speedLabel,
  speedsFor,
} from '../src/map/speed.js';

const HOSTILE = '<img src=x onerror="globalThis.hacked = true">';

function properties(traversal?: RoadProperties['traversal']): RoadProperties {
  return traversal === undefined
    ? { kind: 'road', roadClass: 'residential' }
    : { kind: 'road', roadClass: 'residential', traversal };
}

describe('the speed vocabularies', () => {
  it('lists every wire value the API can send, in the API order', () => {
    expect(SPEED_LIMIT_KINDS).toEqual([
      'unspecified',
      'numeric',
      'no-fixed-limit',
      'walking-pace',
      'implicit',
      'indeterminate',
    ]);
    expect(SPEED_UNITS).toEqual(['km/h', 'mph', 'knots']);
    expect(VARIABLE_STATES).toEqual(['not-tagged', 'fixed', 'variable', 'indeterminate']);
    expect(SPEED_DIRECTIONS).toEqual(['forward', 'backward']);
  });

  it('gives the conditional flag a third state the wire does not have', () => {
    // The server sends a boolean; Studio needs to tell a `false` apart from a
    // server that never sent one.
    expect(CONDITIONAL_STATES).toEqual(['not-tagged', 'present', 'indeterminate']);
  });
});

describe('parseSpeedLimit', () => {
  it('reads every documented shape', () => {
    expect(parseSpeedLimit({ kind: 'unspecified' })).toEqual({ kind: 'unspecified' });
    expect(parseSpeedLimit({ kind: 'numeric', value: '50.5', unit: 'km/h' })).toEqual({
      kind: 'numeric',
      value: '50.5',
      unit: 'km/h',
    });
    expect(parseSpeedLimit({ kind: 'no-fixed-limit' })).toEqual({ kind: 'no-fixed-limit' });
    expect(parseSpeedLimit({ kind: 'walking-pace' })).toEqual({ kind: 'walking-pace' });
    expect(parseSpeedLimit({ kind: 'implicit', code: 'GB-WLS:nsl_restricted' })).toEqual({
      kind: 'implicit',
      code: 'GB-WLS:nsl_restricted',
    });
    expect(parseSpeedLimit({ kind: 'indeterminate' })).toEqual({ kind: 'indeterminate' });
  });

  it('keeps every unit exactly as it arrived', () => {
    for (const unit of SPEED_UNITS) {
      expect(parseSpeedLimit({ kind: 'numeric', value: '30', unit })).toEqual({
        kind: 'numeric',
        value: '30',
        unit,
      });
    }
  });

  it('degrades a missing limit to indeterminate, never to unspecified', () => {
    // A server that never sent a limit has not established that the source
    // lacked speed tags; it has only failed to say. `unspecified` is a claim
    // about a source and Studio must not make it on a server's behalf.
    for (const value of [undefined, null, 'numeric', 42, [], {}]) {
      expect(parseSpeedLimit(value)).toEqual({ kind: 'indeterminate' });
    }
  });

  it('degrades an unknown future kind to indeterminate', () => {
    expect(parseSpeedLimit({ kind: 'advisory', value: '40', unit: 'km/h' })).toEqual({
      kind: 'indeterminate',
    });
  });

  it('refuses a magnitude that is not exact decimal text', () => {
    for (const value of [
      '',
      ' 50',
      '50 ',
      '-50',
      '+50',
      '5e1',
      '50,5',
      '1,000',
      '050',
      '50.50',
      '50.',
      '.5',
      'fifty',
      '50 km/h',
      'Infinity',
      'NaN',
      HOSTILE,
      50,
      null,
    ]) {
      expect(parseSpeedLimit({ kind: 'numeric', value, unit: 'km/h' })).toEqual({
        kind: 'indeterminate',
      });
    }
    // The canonical forms the server actually promises do pass.
    for (const value of ['0', '5', '50', '100', '50.5', '0.125', '1000000.000001']) {
      expect(parseSpeedLimit({ kind: 'numeric', value, unit: 'km/h' })).toEqual({
        kind: 'numeric',
        value,
        unit: 'km/h',
      });
    }
  });

  it('refuses a unit it does not know rather than showing it', () => {
    for (const unit of ['furlongs', 'KM/H', 'kph', '', HOSTILE, 5, undefined]) {
      expect(parseSpeedLimit({ kind: 'numeric', value: '50', unit })).toEqual({
        kind: 'indeterminate',
      });
    }
  });

  it('refuses an implicit code that is not shaped like one', () => {
    for (const code of [
      'urban',
      'RO:',
      ':urban',
      'R:urban',
      'ROU:urban',
      'ro:urban',
      'RO:URBAN',
      // `RO:urban:extra` is a valid multi-segment code and is asserted below;
      // an empty component is the malformed shape that belongs here.
      'RO::urban',
      'RO:urban:',
      'RO:urban::extra',
      'XX:<script>',
      'RO:urban:<script>',
      HOSTILE,
      '',
      7,
      undefined,
    ]) {
      expect(parseSpeedLimit({ kind: 'implicit', code })).toEqual({ kind: 'indeterminate' });
    }
    for (const code of ['RO:urban', 'GB:nsl_single', 'GB-WLS:nsl_restricted', 'DE:zone30']) {
      expect(parseSpeedLimit({ kind: 'implicit', code })).toEqual({ kind: 'implicit', code });
    }
  });

  it('accepts an implicit code whose context narrows more than once', () => {
    // The server canonicalises these before they reach the wire, so Studio
    // sees an upper-case jurisdiction and lower-case context components. It
    // must pass them through whole — jurisdiction, every component and the
    // colon structure between them.
    for (const code of [
      'AR:urban:primary',
      'DE:zone:30',
      'GB-WLS:nsl_restricted:single',
      'AT:urban:motorway:tunnel',
      'US-MD:zone:25',
    ]) {
      expect(parseSpeedLimit({ kind: 'implicit', code })).toEqual({ kind: 'implicit', code });
    }
  });

  it('formats a multi-segment implicit code without altering it', () => {
    expect(limitLabel({ kind: 'implicit', code: 'AR:urban:primary' })).toBe(
      'Implicit · AR:urban:primary',
    );
    expect(limitLabel({ kind: 'implicit', code: 'DE:zone:30' })).toBe('Implicit · DE:zone:30');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'implicit', code: 'DE:zone:30' },
          conditional: true,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('Implicit · DE:zone:30 · conditional');
  });
});

describe('parseConditional and parseVariable', () => {
  it('reads a boolean and nothing else', () => {
    expect(parseConditional(true)).toBe('present');
    expect(parseConditional(false)).toBe('not-tagged');
    for (const value of [undefined, null, 'true', 'false', 0, 1, HOSTILE, {}]) {
      expect(parseConditional(value)).toBe('indeterminate');
    }
  });

  it('reads every variability value and degrades the rest', () => {
    for (const value of VARIABLE_STATES) {
      expect(parseVariable(value)).toBe(value);
    }
    for (const value of [undefined, null, 'signals', 'yes', true, HOSTILE]) {
      expect(parseVariable(value)).toBe('indeterminate');
    }
  });
});

describe('parseSpeedFact', () => {
  it('reads the three members independently', () => {
    expect(
      parseSpeedFact({
        limit: { kind: 'numeric', value: '80', unit: 'km/h' },
        conditional: true,
        variable: 'fixed',
      }),
    ).toEqual({
      limit: { kind: 'numeric', value: '80', unit: 'km/h' },
      conditional: 'present',
      variable: 'fixed',
    });
  });

  it('never lets a broken modifier take the ordinary limit down with it', () => {
    expect(
      parseSpeedFact({
        limit: { kind: 'numeric', value: '80', unit: 'km/h' },
        conditional: HOSTILE,
        variable: HOSTILE,
      }),
    ).toEqual({
      limit: { kind: 'numeric', value: '80', unit: 'km/h' },
      conditional: 'indeterminate',
      variable: 'indeterminate',
    });
  });

  it('degrades a missing fact entirely to indeterminate', () => {
    for (const value of [undefined, null, 'forward', 5, []]) {
      expect(parseSpeedFact(value)).toEqual(indeterminateFact());
    }
    expect(indeterminateFact()).toEqual({
      limit: { kind: 'indeterminate' },
      conditional: 'indeterminate',
      variable: 'indeterminate',
    });
  });
});

describe('reading a whole road', () => {
  const road = properties({
    motorcar: {
      direction: 'reverse',
      access: 'private',
      speedLimits: {
        forward: {
          limit: { kind: 'numeric', value: '70', unit: 'km/h' },
          conditional: false,
          variable: 'not-tagged',
        },
        backward: {
          limit: { kind: 'numeric', value: '30', unit: 'km/h' },
          conditional: false,
          variable: 'not-tagged',
        },
      },
    },
    bicycle: {
      direction: 'both',
      access: 'permissive',
      speedLimits: {
        forward: { limit: { kind: 'walking-pace' }, conditional: true, variable: 'variable' },
        backward: { limit: { kind: 'unspecified' }, conditional: false, variable: 'not-tagged' },
      },
    },
    foot: { direction: 'both', access: 'allowed' },
  });

  it('keeps the two directions apart', () => {
    const speeds = readFeatureSpeeds(road);
    expect(speeds.motorcar.forward.limit).toEqual({
      kind: 'numeric',
      value: '70',
      unit: 'km/h',
    });
    expect(speeds.motorcar.backward.limit).toEqual({
      kind: 'numeric',
      value: '30',
      unit: 'km/h',
    });
  });

  it('returns all three profiles in a stable order', () => {
    const entries = speedEntries(road);
    expect(entries.map((entry) => entry.profile)).toEqual(['motorcar', 'bicycle', 'foot']);
    expect(speedEntries(road).map((entry) => entry.profile)).toEqual(
      entries.map((entry) => entry.profile),
    );
  });

  it('answers for one profile the same way it answers for all of them', () => {
    for (const entry of speedEntries(road)) {
      expect(speedsFor(road, entry.profile)).toEqual(entry.speeds);
    }
  });

  it('degrades a mode with no speed block to indeterminate', () => {
    const speeds = readFeatureSpeeds(road);
    expect(speeds.foot.forward).toEqual(indeterminateFact());
    expect(speeds.foot.backward).toEqual(indeterminateFact());
  });

  it('degrades a road with no traversal at all to indeterminate', () => {
    const speeds = readSpeeds(undefined);
    for (const profile of ['motorcar', 'bicycle', 'foot'] as const) {
      for (const direction of SPEED_DIRECTIONS) {
        expect(speeds[profile][direction]).toEqual(indeterminateFact());
      }
    }
  });

  it('fills in a half-sent directional block', () => {
    expect(parseDirectionalSpeeds({ forward: { limit: { kind: 'walking-pace' } } })).toEqual({
      forward: {
        limit: { kind: 'walking-pace' },
        conditional: 'indeterminate',
        variable: 'indeterminate',
      },
      backward: indeterminateFact(),
    });
  });

  it('never reads a direction or an access', () => {
    // Speed is not direction and not access. The same speed block read off a
    // one-way private road and off an open two-way one gives the same answer.
    const motorcarSpeeds = road.traversal?.motorcar?.speedLimits;
    if (motorcarSpeeds === undefined) {
      throw new Error('the fixture road must carry motorcar speed limits');
    }
    const other = properties({
      motorcar: { direction: 'both', access: 'allowed', speedLimits: motorcarSpeeds },
      bicycle: { direction: 'reverse', access: 'prohibited' },
      foot: { direction: 'both', access: 'allowed' },
    });
    expect(readFeatureSpeeds(other).motorcar).toEqual(readFeatureSpeeds(road).motorcar);
  });
});

describe('labels', () => {
  it('names every limit kind without showing a raw value', () => {
    expect(limitLabel({ kind: 'numeric', value: '50', unit: 'km/h' })).toBe('50 km/h');
    expect(limitLabel({ kind: 'numeric', value: '30', unit: 'mph' })).toBe('30 mph');
    expect(limitLabel({ kind: 'numeric', value: '10', unit: 'knots' })).toBe('10 knots');
    expect(limitLabel({ kind: 'no-fixed-limit' })).toBe('No fixed limit');
    expect(limitLabel({ kind: 'walking-pace' })).toBe('Walking pace');
    expect(limitLabel({ kind: 'implicit', code: 'RO:urban' })).toBe('Implicit · RO:urban');
    expect(limitLabel({ kind: 'unspecified' })).toBe('Not stated');
    expect(limitLabel({ kind: 'indeterminate' })).toBe('Indeterminate · not derived');
  });

  it('appends a modifier only when it says something', () => {
    const fact = (
      conditional: 'not-tagged' | 'present' | 'indeterminate',
      variable: 'not-tagged' | 'fixed' | 'variable' | 'indeterminate',
    ) =>
      speedLabel({ limit: { kind: 'numeric', value: '80', unit: 'km/h' }, conditional, variable });

    expect(fact('not-tagged', 'not-tagged')).toBe('80 km/h');
    expect(fact('present', 'not-tagged')).toBe('80 km/h · conditional');
    expect(fact('not-tagged', 'variable')).toBe('80 km/h · variable');
    expect(fact('not-tagged', 'fixed')).toBe('80 km/h · explicitly fixed');
    expect(fact('indeterminate', 'not-tagged')).toBe('80 km/h · conditional not derived');
    expect(fact('not-tagged', 'indeterminate')).toBe('80 km/h · variability not derived');
    expect(fact('present', 'variable')).toBe('80 km/h · conditional · variable');
  });

  it('matches the documented label examples', () => {
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'numeric', value: '50', unit: 'km/h' },
          conditional: false,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('50 km/h');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'numeric', value: '30', unit: 'mph' },
          conditional: true,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('30 mph · conditional');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'numeric', value: '100', unit: 'km/h' },
          conditional: false,
          variable: 'variable',
        }),
      ),
    ).toBe('100 km/h · variable');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'numeric', value: '80', unit: 'km/h' },
          conditional: false,
          variable: 'fixed',
        }),
      ),
    ).toBe('80 km/h · explicitly fixed');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'no-fixed-limit' },
          conditional: false,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('No fixed limit');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'walking-pace' },
          conditional: false,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('Walking pace');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'implicit', code: 'RO:urban' },
          conditional: false,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('Implicit · RO:urban');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'unspecified' },
          conditional: false,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('Not stated');
    expect(
      speedLabel(
        parseSpeedFact({
          limit: { kind: 'indeterminate' },
          conditional: false,
          variable: 'not-tagged',
        }),
      ),
    ).toBe('Indeterminate · not derived');
  });

  it('says nothing twice about an old server that derived nothing', () => {
    // A missing block is already "not derived" in the limit; repeating it for
    // both modifiers would bury the rows where a modifier genuinely failed.
    expect(speedLabel(indeterminateFact())).toBe('Indeterminate · not derived');
  });

  it('never contains markup, whatever arrives', () => {
    const label = speedLabel(
      parseSpeedFact({
        limit: { kind: HOSTILE, value: HOSTILE, unit: HOSTILE, code: HOSTILE },
        conditional: HOSTILE,
        variable: HOSTILE,
      }),
    );
    expect(label).toBe('Indeterminate · not derived');
    expect(label).not.toContain('<');
    expect(label).not.toContain('onerror');
  });
});
