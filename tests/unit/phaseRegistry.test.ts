import { describe, expect, it } from 'vitest';
import { PhaseRegistry, isPhaseImplemented, IMPLEMENTED_PHASES } from '../../src/core/PhaseRegistry';
import { EvidenceLeg, PhaseState, Verdict } from '../../src/core/types';
import type { TestResult, TestSpec } from '../../src/core/types';

function spec(id: string, required: boolean): TestSpec {
  return {
    id,
    title: id,
    required,
    input: 'x',
    expected: 'y',
    passCriteria: 'z',
    failureCondition: 'w',
  };
}

function result(id: string, verdict: Verdict, required = true): TestResult {
  return {
    spec: spec(id, required),
    verdict,
    observed: 'observed',
    reason: 'reason',
    metrics: {},
    timestamp: 1,
  };
}

describe('PhaseRegistry — Phase Lock (Rule 005)', () => {
  it('starts with only Phase 0 enterable and everything else BLOCKED', () => {
    const r = new PhaseRegistry();
    expect(r.canEnter(0)).toBe(true);
    expect(r.get(0).state).toBe(PhaseState.NOT_STARTED);
    for (let i = 1; i < r.all().length; i++) {
      expect(r.canEnter(i)).toBe(false);
      expect(r.get(i).state).toBe(PhaseState.BLOCKED);
    }
  });

  it('refuses entry to phase N+1 until phase N is PASSED, not merely TESTING', () => {
    const r = new PhaseRegistry();
    r.setState(0, PhaseState.TESTING, 'testing');
    expect(r.canEnter(1)).toBe(false);
    r.setState(0, PhaseState.FAILED, 'failed');
    expect(r.canEnter(1)).toBe(false);
    r.setState(0, PhaseState.PASSED, 'passed');
    expect(r.canEnter(1)).toBe(true);
  });

  it('unlocks exactly one phase on PASSED', () => {
    const r = new PhaseRegistry();
    r.setState(0, PhaseState.PASSED, 'passed');
    expect(r.get(1).state).toBe(PhaseState.NOT_STARTED);
    expect(r.get(2).state).toBe(PhaseState.BLOCKED);
    expect(r.canEnter(2)).toBe(false);
  });

  it('re-locks downstream phases when an earlier phase regresses', () => {
    const r = new PhaseRegistry();
    r.setState(0, PhaseState.PASSED, 'passed');
    r.setState(1, PhaseState.PASSED, 'passed');
    expect(r.canEnter(2)).toBe(true);
    r.setState(0, PhaseState.FAILED, 'regression found');
    expect(r.get(1).state).toBe(PhaseState.BLOCKED);
    expect(r.canEnter(1)).toBe(false);
    expect(r.canEnter(2)).toBe(false);
  });

  it('records every transition with a reason', () => {
    const r = new PhaseRegistry();
    r.setState(0, PhaseState.IMPLEMENTING, 'starting');
    r.setState(0, PhaseState.TESTING, 'running tests');
    const t = r.getTransitions();
    expect(t).toHaveLength(2);
    expect(t[0]?.from).toBe(PhaseState.NOT_STARTED);
    expect(t[0]?.to).toBe(PhaseState.IMPLEMENTING);
    expect(t[1]?.reason).toBe('running tests');
  });

  it('exposes a blocked reason naming the phase that holds the lock', () => {
    const r = new PhaseRegistry();
    expect(r.blockedReason(1)).toMatch(/Phase 0 .*NOT_STARTED.*Rule 005/);
    r.setState(0, PhaseState.PASSED, 'ok');
    expect(r.blockedReason(1)).toBe('');
  });
});

describe('PhaseRegistry.evaluate — verdict algebra (fail closed)', () => {
  it('PENDING never rounds up to PASS, even when everything else passes', () => {
    const e = PhaseRegistry.evaluate(
      [result('A', Verdict.PASS), result('B', Verdict.PENDING)],
      EvidenceLeg.REAL_DEVICE,
    );
    expect(e.state).toBe(PhaseState.TESTING);
    expect(e.reason).toContain('PENDING: B');
  });

  it('a single FAIL outranks any number of passes', () => {
    const e = PhaseRegistry.evaluate(
      [result('A', Verdict.PASS), result('B', Verdict.PASS), result('C', Verdict.FAIL)],
      EvidenceLeg.REAL_DEVICE,
    );
    expect(e.state).toBe(PhaseState.FAILED);
    expect(e.reason).toContain('C');
  });

  it('FAIL outranks PENDING', () => {
    const e = PhaseRegistry.evaluate(
      [result('A', Verdict.PENDING), result('B', Verdict.FAIL)],
      EvidenceLeg.REAL_DEVICE,
    );
    expect(e.state).toBe(PhaseState.FAILED);
  });

  it('the desktop leg cannot pass a phase however green it is (Rule 004)', () => {
    const e = PhaseRegistry.evaluate(
      [result('A', Verdict.PASS), result('B', Verdict.PASS)],
      EvidenceLeg.DESKTOP_DEV,
    );
    expect(e.state).toBe(PhaseState.TESTING);
    expect(e.reason).toMatch(/iPhone Safari over HTTPS/);
  });

  it('passes only with all required green on a real device', () => {
    const e = PhaseRegistry.evaluate(
      [result('A', Verdict.PASS), result('B', Verdict.PASS), result('C', Verdict.FAIL, false)],
      EvidenceLeg.REAL_DEVICE,
    );
    expect(e.state).toBe(PhaseState.PASSED);
    expect(e.passCount).toBe(2);
  });

  it('advisory failures do not fail the phase but are still counted', () => {
    const e = PhaseRegistry.evaluate(
      [result('A', Verdict.PASS), result('ADV', Verdict.FAIL, false)],
      EvidenceLeg.REAL_DEVICE,
    );
    expect(e.state).toBe(PhaseState.PASSED);
    expect(e.failCount).toBe(0);
  });

  it('an empty required set does not pass', () => {
    const e = PhaseRegistry.evaluate([result('ADV', Verdict.PASS, false)], EvidenceLeg.REAL_DEVICE);
    expect(e.state).toBe(PhaseState.TESTING);
  });
});

describe('implemented phases', () => {
  it('claims only what has actually been written', () => {
    expect(isPhaseImplemented(0)).toBe(true);
    expect(isPhaseImplemented(1)).toBe(false);
    expect([...IMPLEMENTED_PHASES]).toEqual([0]);
  });
});
