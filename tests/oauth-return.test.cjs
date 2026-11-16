const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync('index.html', 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/m, '');
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
function page({ pending = 'fixture-request', session = true, collision = false, recoveryEvent = false, sessionError = null, holdInitialRead = false, hash = '' } = {}) {
  let callback, calls = 0, releaseInitialRead;
  const redirects = [], storage = new Map(pending ? [['openbrain_pending_authorization_id', pending]] : []), elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {}, innerHTML: '' });
    return elements.get(id);
  };
  const auth = {
    getSession: async () => {
      calls++;
      const currentSession = session;
      if (collision && calls === 1) queueMicrotask(() => callback('SIGNED_IN', { user: { id: 'fixture-user' } }));
      if (recoveryEvent && calls === 1) queueMicrotask(() => callback('PASSWORD_RECOVERY', null));
      if (holdInitialRead && calls === 1) await new Promise(resolve => { releaseInitialRead = resolve; });
      return { data: { session: currentSession ? { user: { id: 'fixture-user' } } : null }, error: sessionError };
    },
    onAuthStateChange: fn => { callback = fn; },
    updateUser: async () => ({ error: null }),
  };
  const context = vm.createContext({
    createClient: () => ({ auth }),
    document: { getElementById: element, createElement: () => ({}) },
    localStorage: { getItem: key => storage.get(key) || null, removeItem: key => storage.delete(key) },
    location: { hash, replace: target => redirects.push(target) },
    URLSearchParams, setTimeout, clearTimeout,
  });
  vm.runInContext(code, context);
  return { redirects, storage, elements, event: event => callback(event, null), signIn: () => { session = true; callback('SIGNED_IN', null); }, clearError: () => { sessionError = null; }, releaseInitialRead: () => releaseInitialRead() };
}

test('simultaneous initial-session and SIGNED_IN callbacks resume consent exactly once', async () => {
  const p = page({ collision: true }); await settle();
  assert.deepEqual(p.redirects, ['/openbrain-oauth-ui/oauth/consent/?authorization_id=fixture-request']);
  assert.equal(p.storage.has('openbrain_pending_authorization_id'), false);
});
test('repeated SIGNED_IN events cannot override an already selected consent destination', async () => {
  const p = page(); await settle(); p.event('SIGNED_IN'); p.event('SIGNED_IN'); await settle();
  assert.deepEqual(p.redirects, ['/openbrain-oauth-ui/oauth/consent/?authorization_id=fixture-request']);
});
test('ordinary signed-in dashboard visits still redirect once', async () => {
  const p = page({ pending: null }); await settle(); p.event('SIGNED_IN'); await settle();
  assert.deepEqual(p.redirects, ['/openbrain-oauth-ui/dashboard/']);
});
test('signed-out visits preserve the pending request for a later sign-in', async () => {
  const p = page({ session: false }); await settle();
  assert.deepEqual(p.redirects, []); assert.equal(p.storage.get('openbrain_pending_authorization_id'), 'fixture-request');
  p.signIn(); await settle();
  assert.deepEqual(p.redirects, ['/openbrain-oauth-ui/oauth/consent/?authorization_id=fixture-request']);
});
test('a recovery event during initial session loading also prevents automatic navigation', async () => {
  const p = page({ recoveryEvent: true }); await settle();
  assert.deepEqual(p.redirects, []); assert.equal(p.storage.get('openbrain_pending_authorization_id'), 'fixture-request');
});
test('sign-in during an older in-flight signed-out read is resumed after that read finishes', async () => {
  const p = page({ session: false, holdInitialRead: true });
  p.signIn(); await settle(); p.releaseInitialRead(); await settle(); await settle();
  assert.deepEqual(p.redirects, ['/openbrain-oauth-ui/oauth/consent/?authorization_id=fixture-request']);
});
test('session read failures preserve the request and permit a later successful retry', async () => {
  const p = page({ sessionError: { message: 'Fixture session error' } }); await settle();
  assert.deepEqual(p.redirects, []); assert.equal(p.storage.get('openbrain_pending_authorization_id'), 'fixture-request');
  assert.equal(p.elements.get('signinStatus').textContent, 'Fixture session error');
  p.clearError(); p.event('SIGNED_IN'); await settle();
  assert.deepEqual(p.redirects, ['/openbrain-oauth-ui/oauth/consent/?authorization_id=fixture-request']);
});
test('password recovery stays on its form and preserves any unrelated pending connection', async () => {
  const p = page({ hash: '#type=recovery&access_token=fixture' }); await settle(); p.event('SIGNED_IN'); await settle();
  assert.deepEqual(p.redirects, []); assert.equal(p.storage.get('openbrain_pending_authorization_id'), 'fixture-request');
});
