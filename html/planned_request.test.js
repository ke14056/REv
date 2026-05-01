// Minimal sanity tests for the Pre-planned Power Request planner.
// Run with: node html/planned_request.test.js

function planPowerRequest({ targetDemandKW, nonGenSupplyKW, maxGeneratorKW, supplyMarginKW = 0.1, allowWait = true, hasGenerator = true }) {
  const demand = Number(targetDemandKW);
  if (!Number.isFinite(demand) || demand <= 0) {
    return { status: 'reject' };
  }
  if (!hasGenerator) {
    return { status: 'reject' };
  }

  const supply = Number(nonGenSupplyKW) || 0;
  const needGen = Math.max(0, demand - supply + (Number(supplyMarginKW) || 0));

  const cap = Number(maxGeneratorKW);
  if (Number.isFinite(cap) && needGen > cap + 1e-9) {
    return { status: 'reject', needGen };
  }

  if (allowWait && supply <= 0) {
    return { status: 'wait', needGen };
  }

  return { status: 'ok', needGen };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// - reject invalid
assert(planPowerRequest({ targetDemandKW: 0, nonGenSupplyKW: 1, maxGeneratorKW: 3 }).status === 'reject', 'invalid demand should reject');

// - reject missing generator
assert(planPowerRequest({ targetDemandKW: 1, nonGenSupplyKW: 1, maxGeneratorKW: 3, hasGenerator: false }).status === 'reject', 'missing generator should reject');

// - wait when no supply and allowWait
assert(planPowerRequest({ targetDemandKW: 1, nonGenSupplyKW: 0, maxGeneratorKW: 3, allowWait: true }).status === 'wait', 'no supply should wait');

// - ok when supply exists and under cap
{
  const r = planPowerRequest({ targetDemandKW: 2.0, nonGenSupplyKW: 1.5, maxGeneratorKW: 3.0, supplyMarginKW: 0.1, allowWait: true });
  assert(r.status === 'ok', 'should be ok');
  assert(r.needGen > 0 && r.needGen < 1.0, 'needGen should be small');
}

// - reject when needGen exceeds cap
{
  const r = planPowerRequest({ targetDemandKW: 5.0, nonGenSupplyKW: 0.5, maxGeneratorKW: 2.0, supplyMarginKW: 0.1, allowWait: false });
  assert(r.status === 'reject', 'should reject when exceeding cap');
}

console.log('planned_request.test.js: PASS');
