/**
 * =============================================================================
 * THE CONTROL LEASE — UNIT TESTS
 * =============================================================================
 * The lease is this package's actual contribution: the live-view tools it
 * borrows its transport from have no notion of who holds control, and these
 * tests are where that notion is pinned down.
 *
 * Time is injected rather than waited on. Every interesting property of a lease
 * is about expiry, and a test suite that slept through fifteen-minute TTLs would
 * be a test suite nobody runs.
 *
 *   npm test --workspace @cua/handoff
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LeaseRegistry, LeaseError, DEFAULT_LEASE_MS } from '../dist/index.js';

const SESSION = 'session-1';

/** A registry whose clock the test moves by hand. */
function at(startMs = 1_700_000_000_000, ttlMs = DEFAULT_LEASE_MS) {
  let now = startMs;
  const leases = new LeaseRegistry({ ttlMs, now: () => new Date(now) });
  return { leases, advance: (ms) => (now += ms) };
}

describe('who holds control', () => {
  test('automation holds a session nobody has touched', () => {
    const { leases } = at();
    assert.equal(leases.of(SESSION).holder, 'automation');
    assert.equal(leases.holds(SESSION, 'automation'), true);
  });

  test('ceding releases control without giving it to anyone', () => {
    // The gap is deliberate. Control passes through `none` rather than straight
    // from automation to a person, so there is never a moment when both could
    // act — which is the whole difference between this and a live-view debugger.
    const { leases } = at();
    const lease = leases.cede(SESSION, 'locator_unresolved');
    assert.equal(lease.holder, 'none');
    assert.equal(lease.reason, 'locator_unresolved');
  });

  test('an operator claims a ceded session', () => {
    const { leases } = at();
    leases.cede(SESSION, 'stuck');
    const lease = leases.claim(SESSION, 'operator-1');
    assert.equal(lease.holder, 'operator');
    assert.equal(lease.holderId, 'operator-1');
  });

  test('handing back returns control to automation', () => {
    const { leases } = at();
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');
    assert.equal(leases.handBack(SESSION, 'operator-1', true).holder, 'automation');
  });
});

describe('what cannot happen', () => {
  const refuses = (fn, fragment) => {
    assert.throws(fn, (error) => {
      assert.ok(error instanceof LeaseError, `expected a LeaseError, got ${error}`);
      assert.match(error.message, fragment);
      assert.ok(error.current, 'a refusal should say who does hold it');
      return true;
    });
  };

  test('an operator cannot take control the automation still holds', () => {
    // Load-bearing rather than defensive: it means someone opening the console
    // URL during a healthy run gets a view and an error, not a keyboard into a
    // step that is mid-flight.
    const { leases } = at();
    refuses(() => leases.claim(SESSION, 'operator-1'), /automation still holds/);
  });

  test('a second operator cannot take it from the first', () => {
    const { leases } = at();
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');
    refuses(() => leases.claim(SESSION, 'operator-2'), /already held by operator operator-1/);
  });

  test('automation cannot cede a session an operator is using', () => {
    const { leases } = at();
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');
    refuses(() => leases.cede(SESSION, 'stuck again'), /an operator already holds/);
  });

  test('somebody who does not hold it cannot hand it back', () => {
    const { leases } = at();
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');
    refuses(() => leases.handBack(SESSION, 'operator-2', true), /does not hold this session/);
  });

  test('there is no way to take a lease, only to be given one', () => {
    // Stated as a test because it is a claim about the API surface, and an API
    // surface grows. A `takeControl` added later should fail here.
    const methods = Object.getOwnPropertyNames(LeaseRegistry.prototype);
    assert.deepEqual(methods.sort(), ['cede', 'claim', 'constructor', 'handBack', 'holds', 'of'].sort());
  });
});

describe('expiry', () => {
  test('a lease lapses on its own', () => {
    const { leases, advance } = at(0, 60_000);
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');

    advance(59_000);
    assert.equal(leases.of(SESSION).holder, 'operator');
    advance(2_000);
    assert.equal(leases.of(SESSION).holder, 'none');
  });

  test('an expired operator lease lands on nobody, never back on automation', () => {
    // The single most important rule in the file. An operator who shut their
    // laptop mid-takeover left the session in a state nobody has looked at, and
    // resuming automation into it is exactly how an unattended irreversible
    // action happens. The run is abandoned and a person is told instead.
    const { leases, advance } = at(0, 1_000);
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');

    advance(2_000);
    const lapsed = leases.of(SESSION);
    assert.equal(lapsed.holder, 'none');
    assert.notEqual(lapsed.holder, 'automation');
    assert.match(lapsed.reason, /expired/);
  });

  test('expiry is decided on read, so there is one source of truth', () => {
    // No timer, and that is the point: a timer is a second answer to "who holds
    // this", and it can be missed, paused by a debugger, or fire after the
    // process has moved on. Reading is the only way anyone learns the answer.
    const { leases, advance } = at(0, 1_000);
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');
    advance(5_000);
    assert.equal(leases.holds(SESSION, 'operator'), false);
    assert.equal(leases.holds(SESSION, 'none'), true);
  });

  test('a finished run does not hand the lease back', () => {
    // `completed_manually` and `abort` leave it on `none`: there is no
    // automation left to resume, and handing the lease back would invite some.
    const { leases } = at();
    leases.cede(SESSION, 'stuck');
    leases.claim(SESSION, 'operator-1');
    const lease = leases.handBack(SESSION, 'operator-1', false);
    assert.equal(lease.holder, 'none');
    assert.match(lease.reason, /run is over/);
  });
});
