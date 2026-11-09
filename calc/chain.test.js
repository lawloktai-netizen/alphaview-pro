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
assert.strictEqual(again.source, 'CBOE delayed');

assert.strictEqual(OC.expiryFromContractId('112026'), '2026-11-27');
assert.strictEqual(OC.expiryFromContractId('122026'), '2026-12-30');
assert.strictEqual(OC.expiryFromContractId('012026'), '2026-01-29');
const hk = OC.chainsFromHkex({
  symbol: '0700.HK',
  ats: 'TCH',
  asOf: '2026-11-09 15:59 HKT',
  spot: 418.4,
  months: [{
    id: '112026',
    optionlist: [
      { strike: '410.000', p: { bd: '9.02', as: '12.00', ls: '9.62', iv: '36.3' }, c: { bd: '', as: '', ls: '', iv: '' } },
      { strike: '1,000.000', p: { bd: '580.00', as: '600.00', ls: '590', iv: '40.0' }, c: { bd: '', as: '', ls: '', iv: '' } },
    ],
  }],
});
assert.strictEqual(hk.source, 'HKEX delayed');
assert.strictEqual(hk.ats, 'TCH');
assert.deepStrictEqual(hk.expirations, ['2026-11-27']);
const hkPut = hk.chains['2026-11-27'].puts.find(r => r.strike === 410);
assert.ok(Math.abs(hkPut.mid - 10.51) < 1e-9, 'hk mid ' + hkPut.mid);
assert.ok(Math.abs(hkPut.iv - 0.363) < 1e-9, 'hk iv ' + hkPut.iv);
assert.strictEqual(hk.chains['2026-11-27'].calls.length, 0);
assert.strictEqual(hk.chains['2026-11-27'].puts.find(r => r.strike === 1000).bid, 580);
const hkAgain = OC.chainsFromCompact(OC.toCompact(hk));
assert.strictEqual(hkAgain.source, 'HKEX delayed');
assert.ok(Math.abs(hkAgain.chains['2026-11-27'].puts.find(r => r.strike === 410).mid - 10.51) < 1e-9);

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

const hkPath = path.join(__dirname, 'data', 'chains', '0700.HK.json');
assert.ok(fs.existsSync(hkPath), 'missing baked 0700.HK chain — run tools/refresh_option_chains.py');
const tencent = OC.chainsFromCompact(JSON.parse(fs.readFileSync(hkPath, 'utf8')));
assert.strictEqual(tencent.source, 'HKEX delayed');
assert.ok(tencent.expirations.includes('2026-11-27'), 'Nov 2026 stock-option expiry missing');
assert.ok(tencent.expirations.includes('2026-12-30'), 'Dec 2026 stock-option expiry missing');
const nov = tencent.chains['2026-11-27'];
const tSpot = tencent.spot;
const twoSided = nov.puts.filter(r => r.bid > 0 && r.ask > 0);
assert.ok(twoSided.length, 'missing two-sided Nov put');
const near = twoSided.reduce((a, b) => (Math.abs(b.strike - tSpot) < Math.abs(a.strike - tSpot) ? b : a));
const asOfDay = String(tencent.asOf || '2026-11-09').slice(0, 10);
const dte = Math.max(1, Math.round((Date.parse('2026-11-27T00:00:00Z') - Date.parse(asOfDay + 'T00:00:00Z')) / 86400000));
const lowIv = 0.15;
const bsLow = M.bs('put', tSpot, near.strike, dte / 365, 0.04, 0, lowIv);
console.log('0700.HK 2026-11-27 put near spot', {
  spot: tSpot, strike: near.strike, bid: near.bid, ask: near.ask, mid: near.mid, iv: near.iv, asOf: tencent.asOf,
});
console.log('old low-IV BS Tencent put', { iv: lowIv, dte, price: Math.round(bsLow.price * 10000) / 10000 });
assert.ok(near.mid > 1, 'market mid should be a real premium, not a dust quote');
assert.ok(near.iv > 0.2, 'HKEX IV should be present');
assert.ok(near.mid > bsLow.price * 1.25, `chain mid ${near.mid} should not be the low-IV BS price ${bsLow.price}`);

console.log('chain.test.js ok');
