const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('oauth/consent/index.html', 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/m, '');
const settle = () => new Promise(resolve => setTimeout(resolve, 8));
function page(options = {}) {
  const nodes = new Map(), redirects = [], passwords = [], emails = [];
  let signedIn = false, callback, releasePassword, details = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', children: [], textContent: '', disabled: false, events: {}, classes: new Set(), get innerHTML() { return ''; }, set innerHTML(value) { this.children = []; }, classList: { add(value) { node(id).classes.add(value); }, remove(value) { node(id).classes.delete(value); } }, appendChild(child) { this.children.push(child); }, reportValidity: () => true, addEventListener(name, fn) { this.events[name] = fn; } });
    return nodes.get(id);
  };
  const session = () => signedIn ? { user: { id: 'fixture-user', email: 'fixture@example.test' } } : null;
  const auth = {
    getSession: async () => ({ data: { session: session() }, error: options.sessionError || null }),
    onAuthStateChange: fn => { callback = fn; },
    signInWithPassword: async payload => {
      passwords.push(payload);
      if (options.holdPassword) await new Promise(resolve => { releasePassword = resolve; });
      if (options.passwordThrow) throw Error('Fixture transport failure');
      if (options.passwordError) return { error: { message: 'Invalid login credentials' } };
      signedIn = true; queueMicrotask(() => callback('SIGNED_IN', session())); return { data: { session: session() }, error: null };
    },
    signInWithOtp: async payload => { emails.push(payload); return { error: options.emailError || null }; },
    oauth: {
      getAuthorizationDetails: async () => { details++; return { data: options.priorConsent ? { redirect_url: 'https://chatgpt.com/fixture-callback' } : { authorization_id: 'fixture-request', client: { name: 'Fixture ChatGPT' }, scope: 'openid email' }, error: null }; },
      approveAuthorization: async () => ({ data: { redirect_url: 'https://chatgpt.com/fixture-callback' } }),
      denyAuthorization: async () => ({ data: { redirect_url: 'https://chatgpt.com/fixture-denied' } }),
    }, signOut: async () => {},
  };
  vm.runInNewContext(code, {
    createClient: () => ({ auth, from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { display_name: 'Fixture', role: options.nonAdmin ? 'child' : 'admin' } }) }) }),
    document: { getElementById: node, createElement: () => ({}) },
    location: { search: '?authorization_id=fixture-request', assign: url => redirects.push(url), reload() {} },
    localStorage: { setItem() {} }, URL, URLSearchParams, setTimeout, clearTimeout,
  });
  const password = async () => { node('email').value = 'fixture@example.test'; node('password').value = 'fixture-only-password'; await node('loginForm').events.submit({ preventDefault() {} }); await settle(); };
  return { node, redirects, passwords, emails, password, releasePassword: () => releasePassword(), details: () => details, email: () => node('emailSignIn').events.click(), messages: () => node('message').children.map(c => c.textContent).join('\n') };
}

test('password login stays in place for deliberate consent and sends no email', async () => {
  const p = page(); await settle(); await p.password();
  assert.equal(p.passwords.length, 1); assert.equal(p.emails.length, 0); assert.equal(p.node('password').value, '');
  assert.equal(p.node('clientName').textContent, 'Fixture ChatGPT'); assert.deepEqual(p.redirects, []);
  await p.node('approve').events.click(); assert.deepEqual(p.redirects, ['https://chatgpt.com/fixture-callback']);
});
test('existing consent and concurrent sign-in callbacks navigate exactly once', async () => {
  const p = page({ priorConsent: true }); await settle(); await p.password(); await settle();
  assert.deepEqual(p.redirects, ['https://chatgpt.com/fixture-callback']); assert.equal(p.details(), 1); assert.equal(p.emails.length, 0);
});
test('wrong passwords show an error, clear the password and restore sign-in controls', async () => {
  const p = page({ passwordError: true }); await settle(); await p.password();
  assert.match(p.messages(), /Invalid login credentials/); assert.equal(p.node('password').value, '');
  assert.equal(p.node('passwordSignIn').disabled, false); assert.equal(p.node('emailSignIn').disabled, false); assert.deepEqual(p.redirects, []); assert.equal(p.details(), 0);
});
test('password transport exceptions also clear secrets and restore controls', async () => {
  const p = page({ passwordThrow: true }); await settle(); await p.password();
  assert.match(p.messages(), /transport failure/); assert.equal(p.node('password').value, ''); assert.equal(p.node('passwordSignIn').disabled, false);
});
test('duplicate password submits and email clicks cannot race an active sign-in', async () => {
  const p = page({ holdPassword: true }); await settle(); const pending = p.password(); await settle();
  assert.equal(p.node('passwordSignIn').disabled, true); assert.equal(p.node('emailSignIn').disabled, true);
  await p.node('loginForm').events.submit({ preventDefault() {} }); await p.email();
  assert.equal(p.passwords.length, 1); assert.equal(p.emails.length, 0); p.releasePassword(); await pending;
});
test('password sign-in preserves the household-admin approval restriction', async () => {
  const p = page({ nonAdmin: true }); await settle(); await p.password();
  assert.match(p.messages(), /not authorized/); assert.equal(p.details(), 0); assert.deepEqual(p.redirects, []);
});
test('email limits are actionable and do not disable the password route', async () => {
  const p = page({ emailError: { status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' } }); await settle(); await p.email();
  assert.match(p.messages(), /Sign in with password/); assert.equal(p.node('passwordSignIn').disabled, false); assert.equal(p.node('emailSignIn').disabled, true); assert.equal(p.emails.length, 1);
  await p.email(); assert.equal(p.emails.length, 1);
  await p.password(); assert.equal(p.passwords.length, 1); assert.equal(p.node('clientName').textContent, 'Fixture ChatGPT');
});
test('session-read errors are visible and do not create an approval', async () => {
  const p = page({ sessionError: { message: 'Fixture session error' } }); await settle();
  assert.match(p.messages(), /Fixture session error/); assert.equal(p.details(), 0); assert.deepEqual(p.redirects, []);
});
