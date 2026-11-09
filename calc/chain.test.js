/* node calc/chain.test.js — parser checks plus the baked NVDA 150 put vs low-IV Black-Scholes. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OC = require('./chain.js');

const parts = OC.occParts('NVDA261224P00150000');
assert.deepStrictEqual(
  { root: parts.root, expiry: parts.expiry, type: parts.type, strike: parts.strike },
  { root: 'NVDA', expiry: '2026-12-24', type: 'put', strike: 150 },
);
assert.strictEqual(OC.occParts('B1VDA261113C00160000').root, 'B1VDA');
assert.strictEqual(OC.occParts('not-an-option'), null);

const sample = {
  timestamp: '2026-11-09 15:40:07',
  data: {
    symbol: 'NVDA',
    current_price: 178.8,
    options: [
      { option: 'NVDA261224P00150000', bid: 4, ask: 4.2, iv: 0.6232, last_trade_price: 4.05 },
      { option: 'NVDA261224C00150000', bid: 30, ask: 31, iv: 0.5, last_trade_price: 30.5 },
      { option: 'B1VDA261224P00150000', bid: 1, ask: 1.1, iv: 0.9, last_trade_price: 1 },
      { option: 'NVDA261225P00150000', bid: 0, ask: 0, iv: 0, last_trade_price: 0 },
    ],
  },
};
const parsed = OC.chainsFromCboe(sample, 'NVDA');
assert.deepStrictEqual(parsed.expirations, ['2026-12-24']);
assert.strictEqual(parsed.chains['2026-12-24'].puts.length, 1);
const put = parsed.chains['2026-12-24'].puts[0];
assert.strictEqual(put.strike, 150);
assert.ok(Math.abs(put.mid - 4.1) < 1e-9, 'mid ' + put.mid);
assert.ok(Math.abs(put.iv - 0.6232) < 1e-9);
assert.strictEqual(parsed.chains['2026-12-24'].calls[0].strike, 150);

const again = OC.chainsFromCompact(OC.toCompact(parsed));
assert.ok(Math.abs(again.chains['2026-12-24'].puts[0].mid - 4.1) < 1e-9);
assert.strictEqual(again.via, 'baked');

const bakedPath = path.join(__dirname, 'data', 'chains', 'NVDA.json');
assert.ok(fs.existsSync(bakedPath), 'missing baked NVDA chain — run tools/refresh_option_chains.py');
const baked = OC.chainsFromCompact(JSON.parse(fs.readFileSync(bakedPath, 'utf8')));
assert.ok(baked.expirations.length >= 8, 'expected a real chain');
const dec24 = baked.chains['2026-12-24'];
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'optmath.js'), 'utf8'), sandbox);
const M = sandbox.OptMath;
const spot = 179.13;
const iv = 0.429;
const T = 46 / 365;
const bs = M.bs('put', spot, 150, T, 0.04, 0, iv);
const bsPrice = Math.round(bs.price * 10000) / 10000;
console.log('old low-IV BS put', { spot, strike: 150, dte: 46, iv, price: bsPrice });
if (dec24) {
  assert.ok(!baked.expirations.includes('2026-12-25'), 'Dec 25 2026 is not a listed NVDA expiry');
  const livePut = dec24.puts.find(r => r.strike === 150);
  assert.ok(livePut && livePut.bid > 0 && livePut.ask > 0, 'missing two-sided 150 put');
  console.log('NVDA 2026-12-24 150 put', {
    bid: livePut.bid, ask: livePut.ask, mid: livePut.mid, iv: livePut.iv, asOf: baked.asOf,
  });
  assert.ok(livePut.mid > bsPrice * 1.5, `chain mid ${livePut.mid} should not be the low-IV BS price ${bsPrice}`);
}

console.log('chain.test.js ok');
