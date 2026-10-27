// Test-only worker for lock-race.test.ts: runs the real lifecycle-lock module in its own OS process,
// so lock contention is a genuine interprocess race. One point of the lock algorithm can be paused
// (the whole process blocks, exactly like a descheduled process) to make a valid interleaving
// deterministic; the algorithm itself is not changed.
//
//   node --experimental-transform-types lock-worker.mjs DIR ROLE OP PAUSE [WAIT_MS]
//   PAUSE: none | before-unlink (just before unlinking the lock file)
//              | after-stale-read (just after reading a record of the crashed owner "crashed-owner")
//
// stdout lines: PAUSED | HOLDING <token> | BUSY <message> | ERROR <message>
// stdin: one byte resumes a pause; a line ends the hold.
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [dir, role, op, pause = 'none', waitMs = '0'] = process.argv.slice(2);
const lockPath = join(dir, 'lifecycle.lock');
const say = (line) => fs.writeSync(1, `${line}\n`);
const block = () => {
  say('PAUSED');
  fs.readSync(0, Buffer.alloc(1), 0, 1, null);
};

// The sources import './x.js'; resolve those to the TypeScript files next to them.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(ts)) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});

if (pause === 'before-unlink') {
  for (const name of ['rmSync', 'unlinkSync']) {
    const original = fs[name];
    fs[name] = function (path, ...rest) {
      if (String(path) === lockPath) block();
      return original.call(this, path, ...rest);
    };
  }
} else if (pause === 'after-stale-read') {
  const original = fs.readFileSync;
  let paused = false;
  fs.readFileSync = function (path, ...rest) {
    const value = original.call(this, path, ...rest);
    if (!paused && String(path) === lockPath && String(value).includes('crashed-owner')) {
      paused = true;
      block();
    }
    return value;
  };
}
syncBuiltinESMExports();

const { lifecycleLockHeld, withLifecycleLock } = await import(new URL('../src/lifecycle-lock.ts', import.meta.url).href);
const layout = { lifecycleLock: lockPath, transitionFile: join(dir, 'transition.json') };
try {
  await withLifecycleLock(
    layout,
    op,
    null,
    async () => {
      const token = lifecycleLockHeld().token;
      fs.writeFileSync(join(dir, `inside-${role}`), token);
      say(`HOLDING ${token}`);
      await new Promise((res) => process.stdin.once('data', res));
      fs.rmSync(join(dir, `inside-${role}`));
    },
    { waitMs: Number(waitMs), pollMs: 50 },
  );
  process.exit(0);
} catch (err) {
  const message = String(err?.message ?? err).replace(/\n/g, ' ');
  say(/another lifecycle operation is running/.test(message) ? `BUSY ${message}` : `ERROR ${message}`);
  process.exit(/another lifecycle operation is running/.test(message) ? 3 : 1);
}
