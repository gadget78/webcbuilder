// First-run admin setup for WebCBuilder.
// Added by TJ (Electro⚡Nickels), November 2026.
//
// There is no default admin password. Until one is set, the admin login is
// refused, and the only way in is the setup form, which needs a one-time
// setup code: a random code saved to setup-code.txt (mode 0600, owned by the
// service user).
//
// Where the tenant sees it: start.sh runs this file once at container start
// (`node first-run-setup.js`), so the code is printed to the container's own
// output, which is what the panel's "Docker Logs" button shows the logged-in
// tenant. It is printed only when first made; later starts never repeat it.
// The web server (index.js) reuses the same file and never prints the code.
//
// No environment-variable option on purpose: Evernode env values are set
// through the public image name, so they are not secret.
//
// The setup code is a one-time bearer key: whoever holds it can set the first
// admin password. Anyone who can read the container's first Docker Logs or
// setup-code.txt holds it.
// While an admin password exists the code is refused and the code file is
// removed. If password.hash is later deleted, setup opens again with a fresh
// random code.
//
// An old copy still on the shipped default hash (sha256 of "password") is
// treated as "no password set", so it goes back to setup mode instead of
// staying open.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// sha256("password"), the hash that older images shipped in password.hash
const OLD_DEFAULT_HASH = '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8';
const MIN_LENGTH = 12;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// One password rule for setup, add-user and change-password.
// Returns an error message, or null when the password is acceptable.
function passwordProblem(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (confirm !== undefined && password !== confirm) return 'Passwords do not match.';
  if (sha256(password) === OLD_DEFAULT_HASH) return 'Pick a different password.';
  return null;
}

// Same-origin check for the setup POST. WebCBuilder serves admin over HTTPS
// only, so the only accepted Origin is https://<this host>. Any other scheme
// (http:, chrome-extension:, ...), host, or "null" is refused. A request with
// no Origin (curl, scripts) is allowed, since the setup code is still required.
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    // Normalize the Host header through URL so a default port (:443) compares equal.
    return o.protocol === 'https:' && o.host === new URL('https://' + req.headers.host).host;
  } catch (e) { return false; }
}

function createSetup({ dir, log = console.log, printCode = false } = {}) {
  const hashFile = path.join(dir, 'password.hash');
  const codeFile = path.join(dir, 'setup-code.txt');
  let code = null;

  function readUsers() {
    const users = {};
    if (!fs.existsSync(hashFile)) return users;
    for (const line of fs.readFileSync(hashFile, 'utf-8').split('\n')) {
      const t = line.trim();
      const i = t.indexOf(':');
      if (i > 0) users[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return users;
  }

  function needsSetup() {
    const h = readUsers().admin;
    return !h || h === OLD_DEFAULT_HASH;
  }

  // Makes sure a setup code exists while setup is needed. Returns it, or null.
  function ensureCode() {
    if (!needsSetup()) { code = null; return null; }
    if (code) return code;
    try {
      const existing = readCodeFile();
      if (existing) {
        code = existing;
        log('[setup] No admin password is set. Find the setup code in your instance\'s Docker Logs (not repeated here).');
        return code;
      }
      const fresh = crypto.randomBytes(9).toString('base64url'); // 12 characters, 72 bits
      try {
        fs.writeFileSync(codeFile, fresh + '\n', { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Another process made it first: use theirs.
        code = readCodeFile();
        if (code) log('[setup] No admin password is set. Find the setup code in your instance\'s Docker Logs (not repeated here).');
        return code;
      }
      fs.chmodSync(codeFile, 0o600); // the mode above is reduced by umask, so set it exactly
      code = fresh;
      // Only the start.sh run (printCode) prints the code, because only its
      // output reaches Docker Logs. The web server never prints it.
      if (printCode) log(`[setup] No admin password is set. Setup code: ${code} (shown once). Open /admin/ on this instance to set a password.`);
      else log('[setup] No admin password is set. A setup code was made; it is in setup-code.txt next to index.js.');
      return code;
    } catch (e) {
      // Fail closed: with no usable code, setup is impossible and login stays refused.
      code = null;
      log(`[setup] Setup code unavailable (${e.message}). Admin stays locked until ${codeFile} is fixed.`);
      return null;
    }
  }

  // Reads setup-code.txt only if it is a plain file (never follows a symlink).
  // Returns the code, or null if there is no file. Throws if the path is
  // anything other than a regular file.
  function readCodeFile() {
    let st;
    try { st = fs.lstatSync(codeFile); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!st.isFile()) throw new Error('setup-code.txt is not a regular file');
    fs.chmodSync(codeFile, 0o600);
    const v = fs.readFileSync(codeFile, 'utf-8').trim();
    if (v) return v;
    fs.rmSync(codeFile, { force: true }); // empty file: drop it so a fresh code is made
    return null;
  }

  function codeMatches(input) {
    const want = ensureCode();
    if (!want || typeof input !== 'string') return false;
    return crypto.timingSafeEqual(Buffer.from(sha256(want), 'hex'), Buffer.from(sha256(input.trim()), 'hex'));
  }

  // Returns { status, body } so the route stays a one-liner.
  function complete(body) {
    const { code: input, password, passwordConfirm } = body || {};
    if (!needsSetup()) return { status: 409, body: { error: 'An admin password is already set. Log in instead.' } };
    if (!codeMatches(input)) return { status: 403, body: { error: 'Setup code is not right.' } };
    const bad = passwordProblem(password, passwordConfirm);
    if (bad) return { status: 400, body: { error: bad } };

    const users = readUsers();
    users.admin = sha256(password); // same format the rest of WebCBuilder reads
    const content = Object.entries(users).map(([u, h]) => `${u}:${h}`).join('\n') + '\n';
    const tmp = hashFile + '.tmp';
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, hashFile);

    try { fs.rmSync(codeFile, { force: true }); } catch (e) { /* not fatal */ }
    code = null;
    log('[setup] Admin password set. Setup code is no longer valid.');
    return { status: 200, body: { success: true, username: 'admin' } };
  }

  return { needsSetup, ensureCode, complete, OLD_DEFAULT_HASH };
}

module.exports = { createSetup, passwordProblem, sameOrigin, OLD_DEFAULT_HASH, MIN_LENGTH };

// Run directly by start.sh at container start: make the code if needed and
// print it once to the container output (Docker Logs). Never blocks startup.
if (require.main === module) {
  try { createSetup({ dir: __dirname, printCode: true }).ensureCode(); } catch (e) { console.log('[setup] ' + e.message); }
}
