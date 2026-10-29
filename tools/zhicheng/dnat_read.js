#!/usr/bin/env node
/* Read the FULL DNAT rule list of an EIP.
 *
 * Why the dance: the console UI appends filter=creator_name='260010182', which
 * hides every rule CCI created under its own service account (that is why the
 * page says 暂无数据 while the EIP reports 60 rules). Direct fetch() from the
 * page is blocked by CSP, so instead we let the console issue the request and
 * rewrite its URL on the way out. */
const path = require('path');
const pcPath = process.env.PLAYWRIGHT_CORE_PATH;
const { chromium } = require(pcPath ? path.resolve(pcPath) : 'playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EIP = process.env.EIP || 'eip-zhicheng-cd005511';
const CONSOLE = 'https://console.sensecore.cn/cn-sh-01';
const WANT = (process.env.WANT || '11182,10182,10081').split(',');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + (process.env.CDP_PORT || 9222));
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page =
    pages.find((p) => /sensecore\.cn/.test(p.url()) && !/\/timeout/.test(p.url())) ||
    pages.find((p) => /sensecore\.cn/.test(p.url())) ||
    pages[0];

  let best = null;
  await page.route(/dnatRules/, async (route) => {
    const orig = route.request().url();
    let u;
    try {
      u = new URL(orig);
    } catch (e) {
      return route.continue();
    }
    u.searchParams.delete('filter');
    u.searchParams.delete('page_token');
    u.searchParams.set('page_size', '500');
    try {
      const resp = await route.fetch({ url: u.toString() });
      const j = await resp.json();
      const n = (j.dnat_rules || []).length;
      console.log('[rw] ' + orig.slice(0, 120) + '\n     -> rules=' + n + ' total=' + j.total_size);
      if (!best || n > best.n) best = { n, j, url: u.toString() };
      await route.fulfill({ response: resp });
    } catch (e) {
      console.log('[rw-err] ' + e.message);
      await route.continue().catch(() => {});
    }
  });

  const detailUrl = CONSOLE + '/eip/list/detail?name=' + EIP + '&tab=addressTransform';
  console.log('[goto] ' + detailUrl);
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  await sleep(12000);

  if (!best) {
    console.log('[ERR] no dnatRules request was intercepted');
    process.exit(1);
  }
  const slim = best.j.dnat_rules.map((x) => {
    const p = x.properties || {};
    return {
      n: x.name,
      st: x.state,
      ext: String(p.external_port),
      proto: p.protocol,
      ip: p.internal_ip,
      port: String(p.internal_port),
      itype: p.internal_instance_type,
      inst: p.internal_instance_name,
      desc: x.description,
      c: x.create_time,
    };
  });
  slim.sort((a, b) => Number(a.ext) - Number(b.ext));
  console.log('=== ALL ' + slim.length + ' RULES ===');
  for (const r of slim) {
    console.log('    ' + r.ext + '/' + r.proto + ' -> ' + (r.itype || '-') + ' [' + (r.inst || r.ip) + ']' + ':' + r.port + '  st=' + r.st + '  "' + (r.desc || '') + '"  ' + r.c);
  }
  console.log('=== WANTED ===');
  for (const w of WANT) {
    const hit = slim.filter((r) => r.ext === w);
    console.log('    ext ' + w + ': ' + (hit.length ? JSON.stringify(hit) : 'ABSENT'));
  }
  console.log('=== focus/ctl3-ish ===');
  for (const r of slim.filter((r) => /ctl3|focus/i.test(JSON.stringify(r)))) console.log('    ' + JSON.stringify(r));
  process.exit(0);
})().catch((e) => {
  console.error('[ERR] ' + e.message);
  process.exit(1);
});
