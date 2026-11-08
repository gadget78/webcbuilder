// Tests for first-run-setup.js (TJ / Electro⚡Nickels). No packages needed.
// Run: node test/first-run-setup.test.js
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { createSetup, passwordProblem, sameOrigin, OLD_DEFAULT_HASH } = require('../first-run-setup.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wcb-'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const logs = []; const log = (m) => logs.push(m);
const P = 'abcdefghijkl';

// 1. Fresh copy: random code, printed once by the start.sh run (Docker Logs)
let d = mk(); logs.length = 0;
let s = createSetup({ dir: d, log, printCode: true });
ok(s.needsSetup(), 'no password.hash means setup needed');
let c = s.ensureCode();
ok(c && c.length === 12 && fs.existsSync(path.join(d, 'setup-code.txt')), 'random code made and saved');
ok(logs.length === 1 && logs[0].includes(c), 'start.sh run prints the code when first made');
logs.length = 0;
const s2 = createSetup({ dir: d, log, printCode: true });
ok(s2.ensureCode() === c, 'restart reuses the saved code');
ok(logs.length === 1 && !logs[0].includes(c), 'restart does not repeat the code in the log');
if (process.platform !== 'win32') ok((fs.statSync(path.join(d, 'setup-code.txt')).mode & 0o777) === 0o600, 'code file is mode 0600');

// 2. Setup checks
ok(s.complete({ code: 'wrong', password: P, passwordConfirm: P }).status === 403, 'wrong code refused');
ok(s.complete({ code: c, password: 'short', passwordConfirm: 'short' }).status === 400, 'short password refused');
ok(s.complete({ code: c, password: P, passwordConfirm: P + 'x' }).status === 400, 'mismatch refused');
const r = s.complete({ code: ' ' + c + ' ', password: P, passwordConfirm: P });
ok(r.status === 200, 'right code sets the password');
ok(fs.readFileSync(path.join(d, 'password.hash'), 'utf8') === 'admin:' + sha(P) + '\n', 'hash written in the existing user:sha256 format');
ok(!fs.existsSync(path.join(d, 'setup-code.txt')), 'code file removed after setup');
ok(!s.needsSetup() && s.ensureCode() === null, 'setup mode off');
ok(s.complete({ code: c, password: 'zzzzzzzzzzzz', passwordConfirm: 'zzzzzzzzzzzz' }).status === 409, 'second setup refused while a password exists');

// 3. Deleting password.hash reopens setup with a fresh code, never an open login
fs.rmSync(path.join(d, 'password.hash'));
const c2 = s.ensureCode();
ok(s.needsSetup() && c2 && c2 !== c, 'deleted hash means setup again with a fresh code');

// 4. Old default hash goes back to setup; well-formed other users kept
d = mk(); fs.writeFileSync(path.join(d, 'password.hash'), 'admin:' + OLD_DEFAULT_HASH + '\nbob:' + sha('bobpass') + '\n');
s = createSetup({ dir: d, log });
ok(s.needsSetup(), 'old default "password" hash counts as no password');
c = s.ensureCode(); s.complete({ code: c, password: 'newpassword12', passwordConfirm: 'newpassword12' });
ok(/^bob:/m.test(fs.readFileSync(path.join(d, 'password.hash'), 'utf8')), 'other well-formed users kept');

// 5. The web server (no printCode) never prints the code, even when it makes one
d = mk(); logs.length = 0;
s = createSetup({ dir: d, log });
const webCode = s.ensureCode();
ok(webCode && logs.length === 1 && !logs[0].includes(webCode), 'web server never prints the code');
ok(s.complete({ code: webCode, password: 'password', passwordConfirm: 'password' }).status === 400, '"password" refused');
// No environment option: WEBCB_SETUP_CODE in the environment is ignored
process.env.WEBCB_SETUP_CODE = 'public-env-code';
d = mk(); s = createSetup({ dir: d, log });
ok(s.ensureCode() !== 'public-env-code', 'environment code ignored (env values are public on Evernode)');
delete process.env.WEBCB_SETUP_CODE;

// 6. A copy with a real password never makes a code
d = mk(); fs.writeFileSync(path.join(d, 'password.hash'), 'admin:' + sha('realpass12345') + '\n');
s = createSetup({ dir: d, log });
ok(!s.needsSetup() && s.ensureCode() === null && !fs.existsSync(path.join(d, 'setup-code.txt')), 'set copy never makes a code');
ok(s.complete({ code: 'x', password: P, passwordConfirm: P }).status === 409, 'setup refused on a set copy');

// 7. Shared password rule and origin check
ok(passwordProblem('short') && passwordProblem('password') && passwordProblem(P) === null, 'shared password rule');
ok(sameOrigin({ headers: { host: 'h.example:443' } }), 'no Origin allowed (code still required)');
ok(sameOrigin({ headers: { host: 'h.example:443', origin: 'https://h.example:443' } }), 'same Origin allowed');
ok(!sameOrigin({ headers: { host: 'h.example:443', origin: 'https://evil.example' } }), 'other Origin refused');
ok(!sameOrigin({ headers: { host: 'h.example:443', origin: 'null' } }), '"null" Origin refused');

ok(!sameOrigin({ headers: { host: 'h.example:443', origin: 'http://h.example:443' } }), 'same host over http refused');
ok(!sameOrigin({ headers: { host: 'h.example', origin: 'http://h.example' } }), 'same host, http, default ports refused');
ok(!sameOrigin({ headers: { host: 'h.example', origin: 'chrome-extension://h.example' } }), 'other scheme refused');
ok(sameOrigin({ headers: { host: 'h.example', origin: 'https://h.example:443' } }), 'https default port matches bare host');

// 8. Two processes start at once: the loser uses the winner's code, no crash
d = mk(); logs.length = 0;
const realWrite = fs.writeFileSync;
fs.writeFileSync = function (f, data, opts) {
  if (String(f).endsWith('setup-code.txt') && opts && opts.flag === 'wx') {
    realWrite(f, 'winner-code\n');      // the other process wins the race
  }
  return realWrite.apply(fs, arguments); // now throws EEXIST
};
let raced;
try { raced = createSetup({ dir: d, log }).ensureCode(); } catch (e) { raced = 'THREW ' + e.code; }
fs.writeFileSync = realWrite;
ok(raced === 'winner-code', 'EEXIST race: uses the other process code, no crash');
ok(logs.every((m) => !m.includes('winner-code')), 'EEXIST race: code not logged by the loser');

// 9. setup-code.txt that is not a plain file: fail closed
d = mk(); fs.mkdirSync(path.join(d, 'setup-code.txt')); logs.length = 0;
s = createSetup({ dir: d, log });
let threw = false, got;
try { got = s.ensureCode(); } catch (e) { threw = true; }
ok(!threw && got === null, 'non-regular code path: no crash, no code');
ok(s.complete({ code: '', password: P, passwordConfirm: P }).status === 403 && s.needsSetup(), 'non-regular code path: setup refused, still locked');
d = mk(); const target = path.join(d, 'elsewhere.txt'); fs.writeFileSync(target, 'planted-code\n');
let linked = true;
try { fs.symlinkSync(target, path.join(d, 'setup-code.txt')); } catch (e) { linked = false; }
if (linked) {
  s = createSetup({ dir: d, log });
  ok(s.ensureCode() === null && s.complete({ code: 'planted-code', password: P, passwordConfirm: P }).status === 403, 'symlinked code file refused');
} else {
  console.log('SKIP symlinked code file (this OS user cannot make symlinks)');
}

console.log(pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
