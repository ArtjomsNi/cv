'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetq-'));
let server;

async function call(method, url, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

const login = async (l, p = 'demo123') => (await call('POST', '/api/login', { login: l, password: p })).cookie;

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--demo'], {
    env: { ...process.env, PORT, DATA_FILE: path.join(dir, 'db.json') }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/public/vets'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('публичный список клиник со статистикой, аппаратами и ценами', async () => {
  const { data } = await call('GET', '/api/public/clinics');
  assert.strictEqual(data.length, 2);
  const lapa = data.find(c => c.name.includes('Лапа'));
  assert.strictEqual(lapa.stats.waitingCount, 3);
  assert.deepStrictEqual(lapa.stats.waiting, ['005', '006', '007']);
  assert.ok(lapa.equipment.some(e => !e.working));
  assert.ok(lapa.prices.length > 0);
  assert.strictEqual(lapa.buttonToken, undefined, 'ключ кнопки не должен быть публичным');
});

test('client in / client out через кабинет персонала', async () => {
  const cookie = await login('lapa-reg');
  const me = (await call('GET', '/api/me', undefined, cookie)).data;
  const add = await call('POST', `/api/clinics/${me.clinicId}/tickets`, { petName: 'Бим' }, cookie);
  assert.strictEqual(add.data.number, '008');
  assert.strictEqual(add.data.position, 4);

  const next = await call('POST', `/api/clinics/${me.clinicId}/call-next`, { room: 'Каб. 1' }, cookie);
  assert.strictEqual(next.data.number, '005');

  const full = (await call('GET', `/api/clinics/${me.clinicId}`, undefined, cookie)).data;
  const t = full.tickets.find(x => x.number === '005');
  assert.strictEqual(t.status, 'in_service');
  assert.strictEqual(full.buttonToken, undefined, 'персонал не видит ключ кнопки');

  assert.strictEqual((await call('POST', `/api/clinics/${me.clinicId}/tickets/${t.id}/done`, {}, cookie)).status, 200);
  const pub = (await call('GET', `/api/public/clinics/${me.clinicId}`)).data;
  assert.strictEqual(pub.stats.servedToday, 3);
  assert.strictEqual(pub.stats.waitingCount, 3);
});

test('персонал не может управлять чужой клиникой и ценами', async () => {
  const cookie = await login('lapa-reg');
  const other = (await call('GET', '/api/public/clinics')).data.find(c => !c.name.includes('Лапа'));
  assert.strictEqual((await call('POST', `/api/clinics/${other.id}/tickets`, {}, cookie)).status, 403);
  const me = (await call('GET', '/api/me', undefined, cookie)).data;
  assert.strictEqual((await call('POST', `/api/clinics/${me.clinicId}/prices`, { name: 'X', price: 1 }, cookie)).status, 403);
  assert.strictEqual((await call('POST', `/api/clinics/${me.clinicId}/tickets`, {})).status, 401);
});

test('физическая и цифровая кнопки', async () => {
  const admin = await login('lapa-admin');
  const me = (await call('GET', '/api/me', undefined, admin)).data;
  const { buttonToken } = (await call('GET', `/api/clinics/${me.clinicId}`, undefined, admin)).data;

  const press = await fetch(`${BASE}/api/button/${buttonToken}`, { method: 'POST' });
  assert.strictEqual(press.status, 200);
  assert.match((await press.json()).number, /^\d{3}$/);
  assert.strictEqual((await fetch(`${BASE}/api/button/${buttonToken}`, { method: 'POST' })).status, 429, 'двойное нажатие игнорируется');
  assert.strictEqual((await fetch(`${BASE}/api/button/wrong`, { method: 'POST' })).status, 404);

  assert.strictEqual((await call('POST', `/api/kiosk/${me.clinicId}/ticket`, { key: 'wrong' })).status, 403);
  assert.strictEqual((await call('POST', `/api/kiosk/${me.clinicId}/ticket`, { key: buttonToken })).status, 200);
});

test('аппарат: статус и специалист на сегодня', async () => {
  const cookie = await login('lapa-reg');
  const me = (await call('GET', '/api/me', undefined, cookie)).data;
  const clinic = (await call('GET', `/api/public/clinics/${me.clinicId}`)).data;
  const uzi = clinic.equipment.find(e => e.name === 'УЗИ');
  assert.strictEqual(uzi.specialistToday, false);
  const r = await call('PUT', `/api/clinics/${me.clinicId}/equipment/${uzi.id}`, { specialistToday: true, specialist: 'Др. Лиепа', working: false }, cookie);
  assert.deepStrictEqual([r.data.specialistToday, r.data.specialist, r.data.working], [true, 'Др. Лиепа', false]);
});

test('онлайн-консультация: запрос клиента и ответ врача', async () => {
  const vets = (await call('GET', '/api/public/vets')).data;
  const online = vets.find(v => v.online);
  const offline = vets.find(v => !v.online);
  assert.strictEqual((await call('POST', '/api/public/consultations', { vetId: offline.id, clientName: 'A', contact: 'a', question: 'q' })).status, 409);

  const req = (await call('POST', '/api/public/consultations', { vetId: online.id, clientName: 'Пётр', contact: '+371', question: 'Кот не ест' })).data;
  assert.strictEqual((await call('GET', `/api/public/consultations/${req.id}?t=bad`)).status, 404);

  const vet = await login('vet-ivars');
  const acc = await call('POST', `/api/vet/consultations/${req.id}/accept`, {}, vet);
  assert.match(acc.data.roomUrl, /^https:\/\/meet\.jit\.si\//);
  const status = (await call('GET', `/api/public/consultations/${req.id}?t=${req.token}`)).data;
  assert.strictEqual(status.status, 'accepted');
  assert.strictEqual(status.roomUrl, acc.data.roomUrl);
});

test('у каждого сотрудника свой логин; запрос без JSON отклоняется', async () => {
  const admin = await login('lapa-admin');
  const me = (await call('GET', '/api/me', undefined, admin)).data;
  const created = await call('POST', `/api/clinics/${me.clinicId}/users`, { login: 'lapa-vet2', password: 'secret1', name: 'Врач 2', role: 'staff' }, admin);
  assert.strictEqual(created.status, 200);
  assert.ok(await login('lapa-vet2', 'secret1'));
  assert.strictEqual((await call('POST', `/api/clinics/${me.clinicId}/users`, { login: 'x', password: 'secret1', name: 'X', role: 'superadmin' }, admin)).status, 400);
  assert.strictEqual((await call('POST', '/api/login', { login: 'lapa-admin', password: 'nope' })).status, 401);

  const res = await fetch(`${BASE}/api/clinics/${me.clinicId}/tickets`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.strictEqual(res.status, 415);
});

test('таймлайн: отрезки по кейсам, сдвиг при раннем завершении', async () => {
  const cookie = await login('lapa-admin');
  const me = (await call('GET', '/api/me', undefined, cookie)).data;
  const url = `/api/clinics/${me.clinicId}`;
  await call('PUT', url + '/settings', { rooms: 1 }, cookie);
  // Закрываем всё, что осталось от предыдущих тестов.
  for (const t of (await call('GET', url, undefined, cookie)).data.tickets) {
    if (t.status === 'waiting' || t.status === 'in_service') await call('POST', `${url}/tickets/${t.id}/cancel`, {}, cookie);
  }
  const { cases } = (await call('GET', url, undefined, cookie)).data;
  const k = await call('POST', url + '/cases', { name: 'Тестовый кейс', minutes: 40 }, cookie);
  assert.strictEqual(k.data.minutes, 40);
  const vacc = cases.find(c => c.name === 'Вакцинация');

  const a = await call('POST', url + '/tickets', { petName: 'A', caseId: k.data.id }, cookie);
  const b = await call('POST', url + '/tickets', { petName: 'B', caseId: vacc.id }, cookie);
  assert.strictEqual(a.data.estimatedWaitMin, 0);
  assert.strictEqual(b.data.estimatedWaitMin, 40, 'B ждёт, пока идёт 40-минутный кейс A');

  await call('POST', url + '/call-next', {}, cookie);
  let tl = (await call('GET', `/api/public/clinics/${me.clinicId}`)).data.timeline;
  const bItem = tl.items.find(i => i.number === b.data.number);
  assert.strictEqual(bItem.waitMin, 40);

  // Врач уточнил кейс пациента B после осмотра — своё время.
  const full = (await call('GET', url, undefined, cookie)).data;
  const tb = full.tickets.find(t => t.number === b.data.number);
  assert.strictEqual((await call('PUT', `${url}/tickets/${tb.id}`, { minutes: 25 }, cookie)).status, 200);
  assert.strictEqual((await call('PUT', `${url}/tickets/${tb.id}`, { minutes: 0 }, cookie)).status, 400);

  // A ушёл намного раньше плана — B сдвигается на «сейчас», темп быстрее плана.
  const ta = full.tickets.find(t => t.number === a.data.number);
  await call('POST', `${url}/tickets/${ta.id}/done`, {}, cookie);
  tl = (await call('GET', `/api/public/clinics/${me.clinicId}`)).data.timeline;
  const b2 = tl.items.find(i => i.number === b.data.number);
  assert.strictEqual(b2.waitMin, 0);
  assert.strictEqual(b2.plannedMin, 25);
  assert.strictEqual(tl.items.find(i => i.number === a.data.number).status, 'done');
  assert.ok(tl.aheadMin >= 39, 'опережаем план почти на 40 минут');
  assert.strictEqual(tl.newClientWaitMin, 25);
});
