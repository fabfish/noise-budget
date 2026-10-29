#!/usr/bin/env node
/* Fill 添加目的地址转换规则 using Playwright Locator clicks (actionability-checked)
 * instead of hand-computed coordinates, which kept hitting the modal mask.
 *
 *   node _rule_ui2.js dry|save
 */
const path = require('path');
const pcPath = process.env.PLAYWRIGHT_CORE_PATH;
const { chromium } = require(pcPath ? path.resolve(pcPath) : 'playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EIP = 'eip-zhicheng-cd005511';
const EXT_PORT = process.env.EXT_PORT || '11182';
const INT_TYPE_TEXT = process.env.INT_TYPE_TEXT || '云容器实例应用';
const INT_FILTER = process.env.INT_FILTER || 'noise-budget-mig-a';
const INT_NAME = process.env.INT_NAME || 'Noise-Budget-MIG-A(noise-budget-mig-a)';
const INT_PORT = process.env.INT_PORT || '22';
const MODE = (process.argv[2] || 'dry').toLowerCase();

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + (process.env.CDP_PORT || 9222));
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page =
    pages.find((p) => /sensecore\.cn/.test(p.url()) && !/\/timeout/.test(p.url())) ||
    pages.find((p) => /sensecore\.cn/.test(p.url())) ||
    pages[0];

  page.on('request', (r) => {
    if (/dnatRules/i.test(r.url()) && r.method() !== 'GET') {
      console.log('[REQ] ' + r.method() + ' ' + r.url().slice(0, 240));
      console.log('      POST ' + String(r.postData() || '').slice(0, 1200));
    }
  });
  page.on('response', async (r) => {
    if (/dnatRules/i.test(r.url()) && r.request().method() !== 'GET') {
      console.log('[RESP] ' + r.status() + ' ' + r.url().slice(0, 160));
      try {
        console.log('      BODY ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 900));
      } catch (e) {}
    }
  });

  const modalCount = () => page.locator('.sensed-modal').count();
  const state = () =>
    page.evaluate(() => {
      const out = {};
      for (const id of ['address_0_protocol', 'address_0_internal_instance_type', 'address_0_internal_instance_name', 'address_0_internal_port']) {
        const e = document.getElementById(id);
        const w = e ? e.closest('.sensed-select') : null;
        const it = w ? w.querySelector('.sensed-select-selection-item') : null;
        out[id] = e ? { dis: !!e.disabled, chosen: it ? (it.innerText || '').trim() : null } : null;
      }
      const x = document.getElementById('address_0_external_port');
      out._ext = x ? x.value : null;
      return out;
    });

  // reset to a clean modal
  if (await modalCount()) {
    await page.keyboard.press('Escape');
    await sleep(1200);
  }
  await page.goto('https://console.sensecore.cn/cn-sh-01/eip/list/detail?name=' + EIP + '&tab=addressTransform', {
    waitUntil: 'domcontentloaded',
  });
  await sleep(9000);
  await page.locator('button', { hasText: '添加规则' }).first().click();
  await sleep(2500);
  console.log('[modal] ' + (await modalCount()) + ' state=' + JSON.stringify(await state()));

  const openSel = async (id) => {
    const wrap = page.locator('#' + id).locator('xpath=ancestor::div[contains(@class,"sensed-select")][1]');
    if (await wrap.count()) await wrap.first().click();
    else await page.locator('#' + id).first().click({ force: true });
    await sleep(1200);
  };
  const pickOpt = async (text) => {
    const o = page.locator('.sensed-select-item-option', { hasText: text }).first();
    const n = await o.count();
    if (!n) return 'no-option:' + text;
    await o.click();
    await sleep(1200);
    return 'clicked:' + text;
  };

  // 1) 协议
  await openSel('address_0_protocol');
  console.log('[protocol opts] ' + JSON.stringify(await page.locator('.sensed-select-item-option').allInnerTexts()));
  console.log('[protocol] ' + (await pickOpt('TCP')));
  console.log('[s1] ' + JSON.stringify(await state()));

  // 2) EIP 端口
  await page.locator('#address_0_external_port').first().fill(EXT_PORT);
  await page.keyboard.press('Tab');
  await sleep(800);
  console.log('[s2] ' + JSON.stringify(await state()));

  // 3) 目的实例类型
  await openSel('address_0_internal_instance_type');
  console.log('[insttype opts] ' + JSON.stringify(await page.locator('.sensed-select-item-option').allInnerTexts()));
  console.log('[insttype] ' + (await pickOpt(INT_TYPE_TEXT)));
  console.log('[s3] ' + JSON.stringify(await state()));

  // 4) 目的实例
  const s3 = await state();
  if (!s3.address_0_internal_instance_name || s3.address_0_internal_instance_name.dis) {
    console.log('[BLOCKED] 目的实例 disabled');
    await page.screenshot({ path: '.kimi-code/_rule_blocked.png' });
    process.exit(2);
  }
  await openSel('address_0_internal_instance_name');
  let lopts = await page.locator('.sensed-select-item-option').allInnerTexts();
  console.log('[inst opts ' + lopts.length + '] ' + JSON.stringify(lopts.slice(0, 20)));
  if (INT_FILTER) {
    await page.locator('#address_0_internal_instance_name').first().fill(INT_FILTER).catch(() => {});
    await sleep(2500);
    lopts = await page.locator('.sensed-select-item-option').allInnerTexts();
    console.log('[inst filtered] ' + JSON.stringify(lopts.slice(0, 20)));
  }
  // Pick the destination app by its EXACT label, never by "the first option whose text
  // contains focus".  On 2026-09-30 that shortcut WAS the outage: the `focus` filter also
  // matches the other FOCUS apps, `.first()` resolved to `FOCUS-H100` (created 09-28, and
  // stopped, with no sshd by design), the rebuilt 11182 rule was bound to it, and every
  // probe kept timing out while the rule read back `ACTIVE` -- a silent mis-bind that the
  // console cannot even show, because the app side prints no rule for the app that lost it.
  // Demanding exactly one match, then reading the committed label back, makes that case a
  // cancelled save instead of a wrong rule.
  const instMatches = await page.locator('.sensed-select-item-option', { hasText: INT_NAME }).count();
  console.log('[inst exact "' + INT_NAME + '"] matches=' + instMatches);
  if (instMatches !== 1) {
    console.log('[ABORT] 目的实例 did not resolve to exactly one option -- cancelling, nothing saved');
    await page.keyboard.press('Escape');
    process.exit(3);
  }
  console.log('[inst] ' + (await pickOpt(INT_NAME)));
  const instChosen = await page.evaluate(() => {
    const el = document.getElementById('address_0_internal_instance_name');
    const box = el && el.closest('.sensed-select');
    const item = box && box.querySelector('.sensed-select-selection-item');
    return item ? item.innerText.trim() : null;
  });
  console.log('[inst chosen] ' + JSON.stringify(instChosen));
  if (!instChosen || instChosen.indexOf(INT_NAME) < 0) {
    console.log('[ABORT] 目的实例 committed "' + instChosen + '", not ' + INT_NAME + ' -- cancelling, nothing saved');
    await page.keyboard.press('Escape');
    process.exit(3);
  }
  console.log('[s4] ' + JSON.stringify(await state()));

  // 5) 目的端口
  await openSel('address_0_internal_port');
  const popts = await page.locator('.sensed-select-item-option').allInnerTexts();
  console.log('[dstport opts] ' + JSON.stringify(popts.slice(0, 20)));
  if (popts.length) console.log('[dstport] ' + (await pickOpt(INT_PORT)));
  else {
    await page.locator('#address_0_internal_port').first().fill(INT_PORT).catch((e) => console.log('[fill err] ' + e.message));
    await page.keyboard.press('Enter');
  }
  await sleep(1200);
  console.log('[s5] ' + JSON.stringify(await state()));
  await page.screenshot({ path: '.kimi-code/_rule_filled.png' });

  if (MODE !== 'save') {
    console.log('[done] dry');
    process.exit(0);
  }
  await page.locator('.sensed-modal button', { hasText: '保 存' }).first().click().catch(async () => {
    await page.locator('.sensed-modal button', { hasText: '保存' }).first().click();
  });
  await sleep(8000);
  console.log('[after save] modal=' + (await modalCount()));
  const lines = await page.evaluate(() =>
    document.body.innerText.split('\n').filter((l) => /11182|失败|成功|错误|请选择|已存在|11182/.test(l)).slice(0, 12)
  );
  console.log('[page] ' + JSON.stringify(lines));
  await page.screenshot({ path: '.kimi-code/_rule_saved.png' });
  process.exit(0);
})().catch((e) => {
  console.error('[ERR] ' + e.message);
  process.exit(1);
});
