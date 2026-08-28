/**
 * Isolation & security tests for the Alesa session manager.
 *
 * Run: node tests/isolation.test.js
 */

const assert = require('assert');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const { getUserByChatId, USERS } = require('../users');
const { SessionManager } = require('../sessions');
const { AuthManager } = require('../auth');

const mockBot = { sendMessage: () => Promise.resolve() };
const mockAuth = new AuthManager({
  bot: mockBot,
  chatId: USERS[0].id,
  apiKey: 'test-key',
  onAuthRestored: () => {},
});

// Two real users from the registry
const userA = USERS[0]; // Vladimir
const userB = USERS[1]; // Mariam

// ── Suite 1: User Registry ─────────────────────────────────────────────────

console.log('\n[1] User Registry');

test('known user A resolves by chatId', () => {
  const u = getUserByChatId(userA.id);
  assert.ok(u, 'should resolve');
  assert.strictEqual(u.id, userA.id);
});

test('known user B resolves by chatId', () => {
  const u = getUserByChatId(userB.id);
  assert.ok(u, 'should resolve');
  assert.strictEqual(u.id, userB.id);
});

test('unknown chatId returns null (access blocked)', () => {
  assert.strictEqual(getUserByChatId(99999999), null);
  assert.strictEqual(getUserByChatId(0), null);
  assert.strictEqual(getUserByChatId(-1), null);
});

test('users A and B have different workDirs', () => {
  assert.notStrictEqual(userA.workDir, userB.workDir);
});

test('workDirs do not overlap (no path traversal via shared prefix)', () => {
  const a = userA.workDir;
  const b = userB.workDir;
  assert.ok(!a.startsWith(b + '/'), 'A is not under B');
  assert.ok(!b.startsWith(a + '/'), 'B is not under A');
});

// ── Suite 2: Session Isolation ────────────────────────────────────────────────

console.log('\n[2] Session Isolation');

const sm = new SessionManager({ authManager: mockAuth, bot: mockBot });

// Inject sessions manually (bypassing tmux)
const sessA = `s${userA.id}-1000`;
const sessB = `s${userB.id}-2000`;

sm._sessions.set(userA.id, new Map([[sessA, {
  taskDescription: 'User A task',
  summary: 'User A',
  createdAt: Date.now(),
  lastMessageAt: Date.now(),
}]]));
sm._sessions.set(userB.id, new Map([[sessB, {
  taskDescription: 'User B task',
  summary: 'User B',
  createdAt: Date.now(),
  lastMessageAt: Date.now(),
}]]));

test('list(A) does not include B sessions', () => {
  const list = sm.list(userA.id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0][0], sessA);
});

test('list(B) does not include A sessions', () => {
  const list = sm.list(userB.id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0][0], sessB);
});

test('getRecent(A) does not include B sessions', () => {
  const recent = sm.getRecent(userA.id, 24 * 60 * 60 * 1000);
  assert.ok(recent.every(([n]) => n === sessA), 'only A sessions');
});

test('getRecent(B) does not include A sessions', () => {
  const recent = sm.getRecent(userB.id, 24 * 60 * 60 * 1000);
  assert.ok(recent.every(([n]) => n === sessB), 'only B sessions');
});

// ── Suite 3: Cross-User Attack Simulation ─────────────────────────────────────

console.log('\n[3] Attack Simulation');

test('ATTACK: User B tries to archive User A session → no-op', () => {
  // Simulate: User B crafts `sess:arch:{sessA}` callback
  const result = sm.archive(userB.id, sessA);
  assert.strictEqual(result, false, 'archive must return false for foreign session');
  // A's session must still exist
  assert.strictEqual(sm.list(userA.id).length, 1, 'User A session intact');
});

test('ATTACK: User A tries to archive User B session → no-op', () => {
  const result = sm.archive(userA.id, sessB);
  assert.strictEqual(result, false);
  assert.strictEqual(sm.list(userB.id).length, 1, 'User B session intact');
});

test('ATTACK: route:continue with foreign session name → sessData resolves to undefined', () => {
  // Simulate the handler: sessions.list(userB.id).find(([n]) => n === sessA)
  const sessData = sm.list(userB.id).find(([n]) => n === sessA)?.[1];
  assert.strictEqual(sessData, undefined, 'foreign session name returns no data');
});

test('ATTACK: route:continue with foreign session name → sess:cont callback → pinned but no context', () => {
  // After pinning a foreign session name, context lookup must return undefined
  const fakePinnedName = sessA; // User B pins User A's session
  const sessData = sm.list(userB.id).find(([n]) => n === fakePinnedName)?.[1];
  assert.strictEqual(sessData, undefined, 'context for foreign session is undefined');
  // Consequence: Claude runs without session context (no leak, no crash)
});

test('ATTACK: session names include userId — collision not possible', () => {
  // Even if timestamps collide, userId prefix guarantees uniqueness
  const fakeCollision = `s${userA.id}-9999`;
  const inB = sm.list(userB.id).some(([n]) => n === fakeCollision);
  assert.strictEqual(inB, false, 'A-prefixed name never appears in B list');
});

test('ATTACK: listAll() leaks all sessions to admin — intentional, not a bug', () => {
  // listAll() is admin-only (called from admin commands)
  // Verify it does return cross-user data (expected behavior)
  const all = sm.listAll();
  assert.ok(all.length >= 2, 'admin sees all sessions — expected');
  // This is intentional — mark as documented behavior
  assert.ok(true, 'cross-user visibility in listAll() is admin-only, documented');
});

// ── Suite 4: User Registry Brute-force ───────────────────────────────────────

console.log('\n[4] Registry Brute-force');

test('sequential scan of IDs near known user does not resolve unknown IDs', () => {
  // Attacker increments/decrements known ID hoping to hit another user
  const knownId = userA.id;
  const offsets = [-1, 1, -100, 100, -1000, 1000];
  for (const offset of offsets) {
    const result = getUserByChatId(knownId + offset);
    if (result) {
      // Only OK if it's a registered user
      assert.ok(USERS.some(u => u.id === knownId + offset),
        `ID ${knownId + offset} resolved but not in USERS`);
    }
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
if (failed === 0) {
  console.log(`✅ All ${passed} tests passed`);
} else {
  console.error(`❌ ${failed} failed, ${passed} passed`);
  process.exit(1);
}
