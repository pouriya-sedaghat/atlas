import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertRuntimeEnvSafe, runtimeEnv, serializeEnv } from './compose.js';
import { DEFAULT_SETTINGS, layout, validateSettings, type Settings } from './layout.js';
import { parseLanCidr } from './net.js';
import { init } from './setup.js';

const s = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('access settings (review R1)', () => {
  it('rejects loopback mode with a wildcard bind and no allowlist (reviewed case)', () => {
    expect(() => validateSettings(s({ accessMode: 'loopback', bindAddr: '0.0.0.0', lanCidrs: '' }))).toThrow(/loopback access mode requires a loopback bind/);
  });

  it.each([
    ['loopback + LAN address bind', { accessMode: 'loopback', bindAddr: '10.20.0.15' }],
    ['loopback + allowlist (meaningless, refused)', { accessMode: 'loopback', bindAddr: '127.0.0.1', lanCidrs: '10.0.0.0/8' }],
    ['unknown access mode', { accessMode: 'public' as never, bindAddr: '0.0.0.0' }],
    ['lan without allowlist', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '' }],
    ['lan with blank allowlist', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '  ' }],
    ['lan with loopback bind', { accessMode: 'lan', bindAddr: '127.0.0.1', lanCidrs: '10.20.0.0/24' }],
    ['lan with allow-all CIDR', { accessMode: 'lan', bindAddr: '0.0.0.0', lanCidrs: '0.0.0.0/0' }],
    ['lan with too-broad CIDR', { accessMode: 'lan', bindAddr: '0.0.0.0', lanCidrs: '10.0.0.0/4' }],
    ['lan with octet > 255', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '300.1.1.0/24' }],
    ['lan with prefix > 32', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '10.20.0.0/33' }],
    ['lan with host bits set', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '10.20.0.5/24' }],
    ['lan with leading-zero octet', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '010.20.0.0/24' }],
    ['lan with empty list entry', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '10.20.0.0/24,' }],
    ['bind octet > 255', { accessMode: 'lan', bindAddr: '10.20.0.256', lanCidrs: '10.20.0.0/24' }],
    ['bind with leading zero', { accessMode: 'loopback', bindAddr: '127.0.0.01' }],
    ['port out of range', { httpsPort: 70000 }],
    ['non-integer port', { httpsPort: 84.43 }],
    ['server name injection', { serverNames: 'localhost; return 200' }],
    ['tile cache size syntax', { tileCacheMax: '2 g' }],
  ] as Array<[string, Partial<Settings>]>)('rejects %s', (_n, over) => {
    expect(() => validateSettings(s(over))).toThrow();
  });

  it.each([
    ['default loopback', {}],
    ['other loopback address', { bindAddr: '127.0.0.2' }],
    ['lan on one interface', { accessMode: 'lan', bindAddr: '10.20.0.15', lanCidrs: '10.20.0.0/24', serverNames: 'maps.internal 10.20.0.15' }],
    ['lan on all interfaces with allowlist', { accessMode: 'lan', bindAddr: '0.0.0.0', lanCidrs: '10.20.0.0/24, 192.168.7.0/24,172.16.0.0/12' }],
    ['lan single host', { accessMode: 'lan', bindAddr: '0.0.0.0', lanCidrs: '10.20.0.7/32' }],
  ] as Array<[string, Partial<Settings>]>)('accepts %s', (_n, over) => {
    expect(() => validateSettings(s(over))).not.toThrow();
  });

  it('parses canonical CIDRs exactly', () => {
    expect(parseLanCidr('10.20.0.0/24')).toEqual({ network: (10 * 256 ** 3) + 20 * 256 ** 2, prefix: 24 });
    expect(parseLanCidr('192.168.7.9/32').prefix).toBe(32);
  });
});

// This group exercises Linux SEYRA_HOME paths; the target VM remains Linux-only.
describe.skipIf(process.platform === 'win32')('runtime boundary (review R1)', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'seyra-access-'));
    process.env.SEYRA_HOME = home;
    process.env.SEYRA_INSTALL_DIR = join(home, 'install');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.SEYRA_HOME;
    delete process.env.SEYRA_INSTALL_DIR;
  });

  it('never generates a runtime configuration from unsafe settings', () => {
    expect(() => runtimeEnv(layout(), s({ bindAddr: '0.0.0.0' }), [], 'ds-x')).toThrow(/loopback/);
  });

  it('refuses to start from a hand-edited unsafe runtime.env, accepts a safe one', () => {
    const l = layout();
    mkdirSync(l.state, { recursive: true });
    const safe = runtimeEnv(l, s({}), [], 'ds-x');
    writeFileSync(l.runtimeEnv, serializeEnv(safe));
    expect(() => assertRuntimeEnvSafe(l)).not.toThrow();
    writeFileSync(l.runtimeEnv, serializeEnv({ ...safe, SEYRA_BIND_ADDR: '0.0.0.0' }));
    expect(() => assertRuntimeEnvSafe(l)).toThrow(/loopback access mode requires a loopback bind/);
    writeFileSync(l.runtimeEnv, serializeEnv({ ...safe, SEYRA_ACCESS_MODE: 'lan', SEYRA_BIND_ADDR: '0.0.0.0', SEYRA_LAN_ALLOW_CIDRS: '' }));
    expect(() => assertRuntimeEnvSafe(l)).toThrow(/allowlist/);
  });

  it('init rejects unsafe settings before creating or persisting anything', async () => {
    const l = layout();
    await expect(init({ bindAddr: '0.0.0.0' }, () => undefined)).rejects.toThrow(/loopback/);
    expect(existsSync(l.settingsFile)).toBe(false);
    expect(existsSync(l.secrets)).toBe(false);
    // An existing safe settings file is left byte-identical by a rejected change.
    mkdirSync(l.state, { recursive: true });
    const before = `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`;
    writeFileSync(l.settingsFile, before);
    await expect(init({ accessMode: 'lan', bindAddr: '0.0.0.0' }, () => undefined)).rejects.toThrow(/allowlist/);
    expect(readFileSync(l.settingsFile, 'utf8')).toBe(before);
  });
});
