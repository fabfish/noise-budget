#!/usr/bin/env node
/* Re-point an EXISTING DNAT rule at the right CCI app, without deleting it.
 *
 * Why this exists: on 2026-09-30T18:57:28Z the recovery loop rebuilt the (correctly
 * detected missing) 11182 rule with vision/scripts/acp_dnat_rebuild.js, which picks the
 * 目的实例 option with `.first()` -- and the workspace now holds three FOCUS apps, so the
 * rule landed on `FOCUS-H100` (stopped, zero-DNAT by design) instead of `FOCUS-CTL3`.
 * The rule cannot be deleted (project rule: EIP rules are never removed) and the console
 * disables 绑定 while a rule is bound, so the only in-place fix is 解绑 -> 绑定.
 *
 *   node .kimi-code/_dnat_rebind.js --step=report            # read the row + rule, change nothing
 *   node .kimi-code/_dnat_rebind.js --step=unbind            # 解绑 only (rule survives, becomes 未绑定)
 *   node .kimi-code/_dnat_rebind.js --step=bind --dry        # open the bind modal, fill, verify, CANCEL
 *   node .kimi-code/_dnat_rebind.js --step=bind              # fill + verify + 保存
 *
 * Nothing is saved unless all five checks pass on the 绑定 form, mirroring _ctl3_console.js.
 */
const fs = require('fs');
const path = require('path');

const PW_FILE = process.env.PW_FILE || 'D:/WorkBuddy/zhicheng/pw.txt';
const TENANT = process.env.SC_TENANT || 'zhicheng';
const USERNAME = process.env.SC_USER || '260010182';
const WS =
  process.env.SC_WS ||
  '%2Fsubscriptions%2F0197ee17-b6eb-7846-b2b4-a77c5f509b92%2FresourceGroups%2Fdefault%2Fzones%2Fcn-sh-01z%2Fworkspaces%2Fshare-space';
const BASE = 'https://console.sensecore.cn/cn-sh-01';
const LIST_URL = `${BASE}/cci/app?workspace=${WS}`;
const PORT = Number(process.env.CDP_PORT || 9222);

const args = process.argv.slice(2);
const argOf = (k) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : null;
};
const EIP = argOf('eip') || 'eip-zhicheng-cd005511';
const EXT = argOf('ext') || '11182';
const TARGET = argOf('target') || 'Noise-Budget-MIG-A';
const TARGET_UID = argOf('uid') || 'f346c9dc3cc44b80a1bfd86d02b551d7';
const INT_PORT = argOf('port') || '22';
const STEP = argOf('step') || 'report';
const DRY = args.includes('--dry');

const pcPath = process.env.PLAYWRIGHT_CORE_PATH;
const { chromium } = require(pcPath ? path.resolve(pcPath) : 'playwright-core');

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const KILL_MOTION_CSS = `
  [class*="zoom-appear"], [class*="slide-up-appear"], [class*="fade-appear"],
  .sensed-motion-collapse { animation: none !important; transition: none !important;
    opacity: 1 !important; transform: none !important; }
  .sensed-modal { transform: none !important; opacity: 1 !important; }
  .sensed-select-dropdown { transform: none !important; opacity: 1 !important; }
`;
const killMotion = (page) => page.addStyleTag({ content: KILL_MOTION_CSS });

async function doLogin(page) {
  log('[login] form detected, filling');
  const pw = fs.readFileSync(PW_FILE, 'utf8').replace(/\r?\n+$/, '');
  if (await page.locator('#tenant_code').count()) await page.fill('#tenant_code', TENANT);
  await page.fill('#username', USERNAME);
  await page.fill('#password', pw);
  log(`[login] filled tenant=${TENANT} user=${USERNAME} pwlen=${pw.length}`);
  const submit = page.locator('button[type=submit]').first();
  if (await submit.count()) await submit.focus().catch(() => {});
  await page.keyboard.press('Enter');
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const u = page.url();
    if (/console\.sensecore\.cn/.test(u) && !/signin/.test(u) && !/\/timeout/.test(u)) {
      log(`[login] ok -> ${u}`);
      return true;
    }
  }
  log('[login] TIMED OUT');
  return false;
}

async function ensureSession(page) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  if (/\/timeout/.test(page.url())) {
    const rl = page.locator('text=重新登录').first();
    if (await rl.count()) {
      await rl.click({ force: true }).catch(() => {});
      await sleep(3000);
    }
  }
  const hasForm = (await page.locator('#username').count()) > 0 && (await page.locator('#password').count()) > 0;
  if (hasForm) {
    if (!(await doLogin(page))) throw new Error('login failed');
  }
}

/* Every read of the rule list goes through this: the console's own request carries
 * filter=creator_name=260010182, which hides CCI-created rules.  We let the console
 * issue it and rewrite the URL on the way out. */
function installRuleReader(page, store) {
  return page.route(/dnatRules/, async (route) => {
    const orig = route.request().url();
    let u;
    try {
      u = new URL(orig);
    } catch (e) {
      return route.continue();
    }
    u.searchParams.delete('filter');
    u.searchParams.set('page_size', '500');
    try {
      const resp = await route.fetch({ url: u.toString() });
      const j = await resp.json();
      if (Array.isArray(j.dnat_rules)) store.rules = j.dnat_rules;
      await route.fulfill({ response: resp });
    } catch (e) {
      await route.continue().catch(() => {});
    }
  });
}

const mine = (store) =>
  (store.rules || [])
    .filter((x) => String((x.properties || {}).external_port) === EXT)
    .map((x) => {
      const p = x.properties || {};
      return {
        name: x.name,
        state: x.state,
        ext: String(p.external_port),
        proto: p.protocol,
        itype: p.internal_instance_type,
        inst: p.internal_instance_name,
        port: String(p.internal_port),
      };
    });

async function gotoDnatTab(page, store) {
  store.rules = null;
  await page.goto(`${BASE}/eip/list/detail?name=${EIP}&tab=addressTransform`, { waitUntil: 'domcontentloaded' });
  const rx = new RegExp('(^|[^0-9])' + EXT + '([^0-9]|$)');
  await page.locator('tr', { hasText: rx }).first().waitFor({ timeout: 45000 });
  await sleep(2500);
  await killMotion(page);
}

async function rowInfo(page) {
  return page.evaluate((port) => {
    const rx = new RegExp('(^|[^0-9])' + port + '([^0-9]|$)');
    const row = Array.from(document.querySelectorAll('tr')).find((r) => rx.test((r.innerText || '').replace(/\s+/g, ' ')));
    if (!row) return { err: 'no row' };
    return {
      text: (row.innerText || '').replace(/\s+/g, ' ').trim(),
      buttons: Array.from(row.querySelectorAll('button')).map((b) => ({
        t: (b.innerText || '').replace(/\s+/g, ' ').trim(),
        dis: !!b.disabled,
      })),
    };
  }, EXT);
}

async function clickRowButton(page, label) {
  const rx = new RegExp('(^|[^0-9])' + EXT + '([^0-9]|$)');
  const row = page.locator('tr', { hasText: rx }).first();
  const btn = row.locator('button', { hasText: label }).first();
  if (!(await btn.count())) return { ok: false, why: `no ${label} button in the row` };
  if (await btn.isDisabled()) return { ok: false, why: `${label} is disabled` };
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click();
  await sleep(2000);
  return { ok: true };
}

/* ---- sensed-select helpers (same idioms as .kimi-code/_ctl3_console.js) ---- */
async function openSelect(page, id) {
  await page.evaluate((i) => {
    const input = document.getElementById(i);
    if (!input) throw new Error('no input #' + i);
    const box = input.closest('.sensed-select') || input.parentElement;
    const target = box.querySelector('.sensed-select-selector') || box;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }, id);
  await sleep(900);
}

async function selText(page, id) {
  return collapse(
    await page.evaluate((i) => {
      const el = document.getElementById(i);
      if (!el) return '';
      const box = el.closest('.sensed-select');
      if (!box) return el.value || '';
      const item = box.querySelector('.sensed-select-selection-item');
      return item ? item.innerText : box.innerText;
    }, id)
  );
}

async function optionsFor(page, id) {
  return page.evaluate((i) => {
    const input = document.getElementById(i);
    if (!input) return { err: 'no input #' + i };
    const controls = input.getAttribute('aria-controls');
    let scope = null;
    if (controls) {
      const lb = document.getElementById(controls);
      scope = lb ? lb.closest('[class*="select-dropdown"]') || lb : null;
    }
    if (!scope) scope = input.closest('.sensed-select');
    if (!scope) return { err: '#' + i + ' is not inside a select' };
    return {
      opts: Array.from(scope.querySelectorAll('.sensed-select-item-option')).map((e) => {
        const r = e.getBoundingClientRect();
        return { t: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    };
  }, id);
}

async function waitOptions(page, id, timeoutMs = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await optionsFor(page, id);
    if (!last.err && (last.opts || []).some((o) => o.w > 0 && o.h > 0)) return last;
    await sleep(300);
  }
  return last;
}

async function pickByLabel(page, id, re, query) {
  await openSelect(page, id);
  const before = await waitOptions(page, id, 8000);
  if (query) {
    log(`[pick] ${id} unfiltered: ${JSON.stringify((before.opts || []).map((o) => o.t))}`);
    await page.evaluate((i) => document.getElementById(i).focus(), id);
    await page.keyboard.type(query, { delay: 30 });
    await sleep(1800);
  }
  const scoped = query ? await waitOptions(page, id, 8000) : before;
  const options = (scoped.opts || []).filter((o) => o.w > 0 && o.h > 0);
  const rx = new RegExp(re, 'i');
  const matches = options.filter((o) => rx.test(o.t));
  if (!matches.length) return { ok: false, why: `no option matching /${re}/`, options: options.map((o) => o.t), n: 0 };
  const idx = options.findIndex((o) => rx.test(o.t));
  log(`[pick] ${id}: ${options.length} options, /${re}/ matches ${matches.length} at idx ${idx}`);
  const res = await page.evaluate(
    ({ i, pat }) => {
      const input = document.getElementById(i);
      const controls = input.getAttribute('aria-controls');
      const lb = controls ? document.getElementById(controls) : null;
      const scope = lb ? lb.closest('[class*="select-dropdown"]') || lb : input.closest('.sensed-select');
      const rxv = new RegExp(pat, 'i');
      const cands = Array.from(scope.querySelectorAll('.sensed-select-item-option')).filter((e) => rxv.test((e.innerText || '').trim()));
      if (!cands.length) return { ok: false, n: 0 };
      const el = cands[0];
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, n: cands.length, picked: (el.innerText || '').trim() };
    },
    { i: id, pat: re }
  );
  await sleep(1000);
  let got = await selText(page, id);
  if (!rx.test(got)) {
    log(`[pick] ${id}: dispatch ignored (selected "${got}"), ArrowDown x${idx} + Enter`);
    await page.evaluate((i) => document.getElementById(i).focus(), id);
    for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(1000);
    got = await selText(page, id);
  }
  return { ok: rx.test(got), clicked: res, picked: got, n: matches.length, options: options.map((o) => o.t) };
}

async function pressModalButton(page, rx) {
  const btn = page.locator('.sensed-modal button', { hasText: rx }).last();
  if (!(await btn.count())) return `no modal button matching ${rx}`;
  const t = collapse(await btn.innerText().catch(() => ''));
  await btn.focus().catch(() => {});
  await page.keyboard.press('Enter');
  await sleep(1500);
  return t;
}

async function confirmModalIfAny(page) {
  for (const l of ['确定', '确 定', '确认', '确 认', '提交', '保 存']) {
    const btn = page.locator(`.sensed-modal button:has-text("${l}")`).first();
    if (await btn.count()) {
      const t = collapse(await btn.innerText().catch(() => ''));
      log(`[modal] confirming via "${t}"`);
      await btn.focus().catch(() => {});
      await page.keyboard.press('Enter');
      await sleep(1800);
      return t;
    }
  }
  return null;
}

const modalBody = async (page) =>
  page.evaluate(() => {
    const m = document.querySelector('.sensed-modal');
    return m ? (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200) : null;
  });

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page =
    pages.find((p) => /sensecore\.cn/.test(p.url()) && !/\/timeout/.test(p.url())) ||
    pages.find((p) => /sensecore\.cn/.test(p.url())) ||
    pages[0];
  page.setDefaultTimeout(30000);
  log(`[page] idx=${pages.indexOf(page)} url=${page.url()}`);

  const store = { rules: null };
  await installRuleReader(page, store);
  await ensureSession(page);

  let exitCode = 0;
  try {
    if (STEP === 'report' || DRY) {
      await gotoDnatTab(page, store);
      log(`[row] ${JSON.stringify(await rowInfo(page))}`);
      log(`[rule] ext ${EXT}: ${JSON.stringify(mine(store))}`);
      if (STEP === 'report') return;
    }

    if (STEP === 'unbind' || STEP === 'all') {
      await gotoDnatTab(page, store);
      const before = await rowInfo(page);
      if (before.err) throw new Error('no row for ext ' + EXT);
      log(`[unbind] row before: ${before.text}`);
      if (!/已绑定/.test(before.text)) {
        log('[unbind] row is not 已绑定 -- nothing to unbind');
      } else {
        const r = await clickRowButton(page, '解绑');
        log(`[unbind] click: ${JSON.stringify(r)}`);
        if (!r.ok) throw new Error('could not click 解绑: ' + r.why);
        log(`[unbind] modal: ${await modalBody(page)}`);
        // The confirm dialog's own button is the only safe target: take the last
        // 确定/解绑 inside a modal container.
        const mb = page.locator('.sensed-modal button:has-text("确定"), .sensed-modal button:has-text("解 绑")').last();
        let t = 'no modal confirm button';
        if (await mb.count()) {
          t = collapse(await mb.innerText().catch(() => ''));
          await mb.focus().catch(() => {});
          await page.keyboard.press('Enter');
          await sleep(2000);
        }
        log(`[unbind] pressed "${t}"`);
        await sleep(5000);
        await gotoDnatTab(page, store);
        const after = await rowInfo(page);
        log(`[unbind] row after: ${after.text}`);
        log(`[unbind] rule after: ${JSON.stringify(mine(store))}`);
        if (!/未绑定/.test(after.text)) {
          log('[unbind] WARNING: row no longer reads 未绑定 -- check the state above before binding');
        }
      }
    }

    if (STEP === 'bind' || STEP === 'all') {
      await gotoDnatTab(page, store);
      const before = await rowInfo(page);
      log(`[bind] row before: ${before.text}`);
      if (!/未绑定/.test(before.text)) {
        log('[bind] row is not 未绑定 -- refusing to open the bind form');
        return;
      }
      const r = await clickRowButton(page, '绑定');
      log(`[bind] click: ${JSON.stringify(r)}`);
      if (!r.ok) throw new Error('could not click 绑定: ' + r.why);
      await killMotion(page);
      await sleep(1500);
      log(`[bind] modal: ${await modalBody(page)}`);
      const controls = await page.evaluate(() => {
        const root = document.querySelector('.sensed-modal') || document.body;
        return Array.from(root.querySelectorAll('input'))
          .map((e) => ({ id: e.id || '', ph: e.placeholder || '', dis: !!e.disabled, val: String(e.value).slice(0, 24) }))
          .filter((e) => e.id);
      });
      log(`[bind] inputs: ${JSON.stringify(controls)}`);

      const FIELD_IDS = await page.evaluate(() => {
        const root = document.querySelector('.sensed-modal') || document.body;
        return Array.from(root.querySelectorAll('input[id]')).map((e) => e.id);
      });
      // The 绑定实例 modal uses bare ids (internal_instance_type ...), while the
      // 添加规则 modal uses the address_0_ prefix -- accept both.
      const pick = (re) => FIELD_IDS.filter((i) => re.test(i));
      const typeId = (pick(/(^|_)internal_instance_type$/) || [])[0];
      const instId = (pick(/(^|_)internal_instance_name$/) || [])[0];
      const portId = (pick(/(^|_)internal_port$/) || [])[0];
      const extId = (pick(/(^|_)external_port$/) || [])[0];
      log(`[bind] field map: type=${typeId} inst=${instId} port=${portId} ext=${extId}`);
      if (!typeId || !instId || !portId) throw new Error('bind form field ids not found');

      const rType = await pickByLabel(page, typeId, '^云容器实例应用$');
      log(`[bind] 目的实例类型 -> ${JSON.stringify(rType)}`);
      await sleep(2500);
      const rInst = await pickByLabel(page, instId, TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), TARGET);
      log(`[bind] 目的实例 -> ${JSON.stringify(rInst)}`);
      await sleep(2000);
      const rPort = await pickByLabel(page, portId, `^${INT_PORT}$`);
      log(`[bind] 目的端口 -> ${JSON.stringify(rPort)}`);

      const fields = {
        protocol: FIELD_IDS.some((i) => /_protocol$/.test(i)) ? await selText(page, pick(/_protocol$/)[0]) : '(no protocol field)',
        external_port: extId ? await page.evaluate((i) => document.getElementById(i).value, extId) : EXT,
        instance_type: await selText(page, typeId),
        instance: await selText(page, instId),
        internal_port: await selText(page, portId),
      };
      log(`[bind] FIELDS = ${JSON.stringify(fields)}`);

      const targetRx = new RegExp(TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const enough =
        /云容器实例应用/.test(fields.instance_type) &&
        targetRx.test(fields.instance) &&
        rInst.ok &&
        (rInst.clicked ? rInst.clicked.n === 1 : true) &&
        new RegExp('^' + INT_PORT + '$').test(fields.internal_port) &&
        (extId ? String(fields.external_port) === EXT : true);
      log(`[bind] checked: type=${/云容器实例应用/.test(fields.instance_type)} inst=${targetRx.test(fields.instance)} n=${rInst.clicked && rInst.clicked.n} port=${new RegExp('^' + INT_PORT + '$').test(fields.internal_port)}`);
      if (!enough) {
        log('[bind] VERIFY FAILED -- cancelling, nothing saved');
        await pressModalButton(page, /取\s*消/);
        return;
      }
      if (DRY) {
        log('[bind] dry run: verified, cancelling without saving');
        await pressModalButton(page, /取\s*消/);
        return;
      }
      log('[bind] verified -- saving');
      const t = await pressModalButton(page, /保\s*存/);
      log(`[bind] pressed "${t}"`);
      await sleep(7000);
      log(`[bind] page after save: ${JSON.stringify(await page.evaluate(() => document.body.innerText.split('\n').filter((l) => /失败|成功|错误|已存在|请选择/.test(l)).slice(0, 8)))}`);
      await page.screenshot({ path: '.kimi-code/_rebind_saved.png' });
      await gotoDnatTab(page, store);
      const rule = mine(store);
      log(`[bind] rule now: ${JSON.stringify(rule)}`);
      const okRule = rule.length === 1 && rule[0].inst === TARGET_UID && rule[0].state === 'ACTIVE';
      log(`[bind] ${okRule ? 'PASS' : 'FAIL'}: ext ${EXT} -> ${rule[0] ? rule[0].inst : '<none>'} (want ${TARGET_UID})`);
      if (!okRule) exitCode = 3;
    }
  } catch (e) {
    log(`[ERR] ${e.message}`);
    log(`[ERR] url=${page.url()} body=${(await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)}`);
    exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(exitCode);
}

main();
