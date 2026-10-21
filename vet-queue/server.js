'use strict';
// ВетОчередь — живая очередь для ветеринарных клиник.
// Сервер без внешних зависимостей: только Node.js >= 18.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const APP_TZ = process.env.APP_TZ || 'Europe/Riga';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_SERVICE_MIN = 15; // пока нет статистики за день
const BUTTON_COOLDOWN_MS = 3000; // защита от двойного нажатия кнопки
const KEEP_TICKETS_DAYS = 3;
const KEEP_CONSULTATIONS_DAYS = 30;

// ---------- хранилище ----------

let db;
let saveTimer = null;

function emptyDb() {
  return { clinics: [], users: [], tickets: [], consultations: [], sessions: {} };
}

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    db = emptyDb();
  }
}

function save() {
  if (!saveTimer) saveTimer = setTimeout(flush, 200);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  prune();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

function prune() {
  const now = Date.now();
  const ticketCutoff = now - KEEP_TICKETS_DAYS * 864e5;
  const consultCutoff = now - KEEP_CONSULTATIONS_DAYS * 864e5;
  db.tickets = db.tickets.filter(t => t.createdAt > ticketCutoff);
  db.consultations = db.consultations.filter(c => c.createdAt > consultCutoff);
  for (const [sid, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[sid];
}

const rid = () => crypto.randomBytes(8).toString('hex');
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: APP_TZ }).format(new Date());
const ticketNo = n => String(n).padStart(3, '0');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
}

// ---------- живые обновления (Server-Sent Events) ----------

const sseClients = new Set();

function changed(scope) {
  save();
  const msg = `data: ${JSON.stringify({ scope })}\n\n`;
  for (const res of sseClients) res.write(msg);
}

setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- доменная логика ----------

function newClinic({ name, address = '', phone = '', hours = '' }) {
  return {
    id: rid(), name, address, phone, hours, rooms: 1,
    buttonToken: crypto.randomBytes(16).toString('hex'),
    counterDate: null, counter: 0, lastButtonAt: 0,
    equipment: [], prices: [],
  };
}

function newUser({ login, password, name, role, clinicId = null, specialization = '' }) {
  return { id: rid(), login, name, role, clinicId, specialization, online: false, pass: hashPassword(password) };
}

function createTicket(clinic, { petName = '', ownerName = '', source }) {
  const d = today();
  if (clinic.counterDate !== d) { clinic.counterDate = d; clinic.counter = 0; }
  clinic.counter += 1;
  const t = {
    id: rid(), clinicId: clinic.id, date: d, number: clinic.counter,
    petName, ownerName, source, status: 'waiting', room: '',
    createdAt: Date.now(), calledAt: null, doneAt: null,
  };
  db.tickets.push(t);
  changed('clinic:' + clinic.id);
  return t;
}

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function todaysTickets(clinicId) {
  const d = today();
  return db.tickets.filter(t => t.clinicId === clinicId && t.date === d);
}

function clinicStats(c) {
  const ts = todaysTickets(c.id);
  const waiting = ts.filter(t => t.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt);
  const serving = ts.filter(t => t.status === 'in_service');
  const done = ts.filter(t => t.status === 'done' && t.calledAt);
  const avgWait = avg(ts.filter(t => t.calledAt).map(t => t.calledAt - t.createdAt));
  const avgService = avg(done.map(t => t.doneAt - t.calledAt));
  const serviceMin = avgService ? avgService / 60000 : DEFAULT_SERVICE_MIN;
  const rooms = Math.max(1, c.rooms || 1);
  // Сколько ждать пациенту, перед которым `ahead` человек в очереди.
  const estimate = ahead => Math.round(Math.max(0, ahead + serving.length - rooms + 1) * serviceMin / rooms);
  return {
    waitingCount: waiting.length,
    servingCount: serving.length,
    servedToday: done.length,
    avgWaitMin: avgWait == null ? null : Math.round(avgWait / 60000),
    avgServiceMin: avgService == null ? null : Math.round(avgService / 60000),
    estimatedWaitMin: estimate(waiting.length),
    waiting: waiting.map(t => ticketNo(t.number)),
    serving: serving.map(t => ({ number: ticketNo(t.number), room: t.room })),
    estimate,
  };
}

function publicEquipment(e) {
  return {
    id: e.id, name: e.name, working: e.working, note: e.note,
    specialistToday: e.specialistDate === today(), specialist: e.specialistDate === today() ? e.specialist : '',
  };
}

function publicClinic(c) {
  const { estimate, ...stats } = clinicStats(c);
  return {
    id: c.id, name: c.name, address: c.address, phone: c.phone, hours: c.hours, rooms: c.rooms,
    stats, equipment: c.equipment.map(publicEquipment), prices: c.prices,
  };
}

function ticketResponse(clinic, t) {
  const stats = clinicStats(clinic);
  const ahead = stats.waiting.indexOf(ticketNo(t.number));
  return { number: ticketNo(t.number), position: ahead + 1, estimatedWaitMin: stats.estimate(ahead) };
}

const publicVet = v => ({ id: v.id, name: v.name, specialization: v.specialization, online: !!v.online });

// ---------- HTTP-утилиты ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 100 * 1024) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function required(v, field, max) {
  const s = str(v, max);
  if (!s) throw new HttpError(400, `Поле «${field}» обязательно`);
  return s;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  const s = sid && db.sessions[sid];
  if (!s || s.exp < Date.now()) return null;
  return db.users.find(u => u.id === s.userId) || null;
}

const me = u => ({ id: u.id, login: u.login, name: u.name, role: u.role, clinicId: u.clinicId, specialization: u.specialization, online: !!u.online });

function findClinic(id) {
  const c = db.clinics.find(x => x.id === id);
  if (!c) throw new HttpError(404, 'Клиника не найдена');
  return c;
}

function requireUser(user, ...roles) {
  if (!user) throw new HttpError(401, 'Нужно войти');
  if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Нет доступа');
}

function requireClinic(user, clinicId, { admin = false } = {}) {
  requireUser(user);
  if (user.role === 'superadmin') return;
  if (!['staff', 'clinic_admin'].includes(user.role) || user.clinicId !== clinicId) throw new HttpError(403, 'Нет доступа к этой клинике');
  if (admin && user.role !== 'clinic_admin') throw new HttpError(403, 'Только для администратора клиники');
}

function findTicket(clinicId, id) {
  const t = db.tickets.find(x => x.id === id && x.clinicId === clinicId);
  if (!t) throw new HttpError(404, 'Талон не найден');
  return t;
}

function findIn(list, id, what) {
  const x = list.find(e => e.id === id);
  if (!x) throw new HttpError(404, `${what} не найдено`);
  return x;
}

function validateNewUser(b, allowedRoles) {
  const login = required(b.login, 'Логин', 50).toLowerCase();
  if (!/^[a-z0-9._-]{3,50}$/.test(login)) throw new HttpError(400, 'Логин: 3–50 символов, латиница, цифры, . _ -');
  if (db.users.some(u => u.login === login)) throw new HttpError(409, 'Такой логин уже занят');
  const password = str(b.password, 200);
  if (password.length < 6) throw new HttpError(400, 'Пароль минимум 6 символов');
  const role = str(b.role);
  if (!allowedRoles.includes(role)) throw new HttpError(400, 'Недопустимая роль');
  return { login, password, role, name: required(b.name, 'Имя', 100), specialization: str(b.specialization, 200) };
}

const loginFails = new Map();

// ---------- маршруты ----------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

// Публичная часть

route('GET', '/api/public/clinics', () => db.clinics.map(publicClinic));
route('GET', '/api/public/clinics/:id', ({ p }) => publicClinic(findClinic(p.id)));
route('GET', '/api/public/vets', () => db.users.filter(u => u.role === 'remote_vet').map(publicVet));

// Цифровая кнопка (киоск/планшет в клинике). Ключ = токен кнопки клиники.
route('POST', '/api/kiosk/:id/ticket', ({ p, body }) => {
  const c = findClinic(p.id);
  if (!body.key || body.key !== c.buttonToken) throw new HttpError(403, 'Неверный ключ киоска');
  return ticketResponse(c, createTicket(c, { source: 'kiosk', petName: str(body.petName, 100) }));
});

// Физическая кнопка (ESP32 и т.п.): POST /api/button/<токен>
route('POST', '/api/button/:token', ({ p }) => {
  const c = db.clinics.find(x => x.buttonToken === p.token);
  if (!c) throw new HttpError(404, 'Неизвестная кнопка');
  if (Date.now() - c.lastButtonAt < BUTTON_COOLDOWN_MS) throw new HttpError(429, 'Слишком часто');
  c.lastButtonAt = Date.now();
  return ticketResponse(c, createTicket(c, { source: 'button' }));
});

// Онлайн-консультации: запрос клиента
route('POST', '/api/public/consultations', ({ body }) => {
  const vet = db.users.find(u => u.id === body.vetId && u.role === 'remote_vet');
  if (!vet) throw new HttpError(404, 'Врач не найден');
  if (!vet.online) throw new HttpError(409, 'Врач сейчас не в сети');
  const c = {
    id: rid(), token: crypto.randomBytes(16).toString('hex'), vetId: vet.id,
    clientName: required(body.clientName, 'Ваше имя', 100),
    contact: required(body.contact, 'Контакт', 100),
    pet: str(body.pet, 200), question: required(body.question, 'Вопрос', 2000),
    status: 'new', roomUrl: null, createdAt: Date.now(),
  };
  db.consultations.push(c);
  changed('consult');
  return { id: c.id, token: c.token };
});

route('GET', '/api/public/consultations/:id', ({ p, query }) => {
  const c = db.consultations.find(x => x.id === p.id);
  if (!c || query.get('t') !== c.token) throw new HttpError(404, 'Заявка не найдена');
  const vet = db.users.find(u => u.id === c.vetId);
  return { status: c.status, roomUrl: c.status === 'accepted' ? c.roomUrl : null, vet: vet ? publicVet(vet) : null, createdAt: c.createdAt };
});

// Вход

route('POST', '/api/login', ({ body, req }) => {
  const ip = req.socket.remoteAddress;
  const f = loginFails.get(ip);
  if (f && f.count >= 5 && Date.now() - f.since < 10 * 60000) throw new HttpError(429, 'Слишком много попыток, подождите 10 минут');
  const u = db.users.find(x => x.login === str(body.login, 50).toLowerCase());
  if (!u || !checkPassword(str(body.password, 200), u.pass)) {
    const cur = f && Date.now() - f.since < 10 * 60000 ? f : { count: 0, since: Date.now() };
    cur.count += 1;
    loginFails.set(ip, cur);
    throw new HttpError(401, 'Неверный логин или пароль');
  }
  loginFails.delete(ip);
  const sid = crypto.randomBytes(32).toString('hex');
  db.sessions[sid] = { userId: u.id, exp: Date.now() + SESSION_TTL_MS };
  save();
  return {
    body: me(u),
    headers: { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` },
  };
});

route('POST', '/api/logout', ({ req }) => {
  delete db.sessions[parseCookies(req).sid];
  save();
  return { body: { ok: true }, headers: { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' } };
});

route('GET', '/api/me', ({ user }) => { requireUser(user); return me(user); });

route('POST', '/api/me/password', ({ user, body }) => {
  requireUser(user);
  if (!checkPassword(str(body.oldPassword, 200), user.pass)) throw new HttpError(400, 'Старый пароль неверен');
  const pw = str(body.newPassword, 200);
  if (pw.length < 6) throw new HttpError(400, 'Пароль минимум 6 символов');
  user.pass = hashPassword(pw);
  save();
  return { ok: true };
});

// Клиника: очередь (персонал)

route('GET', '/api/clinics/:id', ({ p, user }) => {
  requireClinic(user, p.id);
  const c = findClinic(p.id);
  const isAdmin = user.role !== 'staff';
  return {
    ...publicClinic(c),
    equipment: c.equipment.map(e => ({ ...publicEquipment(e), specialistName: e.specialist })),
    buttonToken: isAdmin ? c.buttonToken : undefined,
    tickets: todaysTickets(c.id).map(t => ({ ...t, number: ticketNo(t.number) })),
  };
});

route('POST', '/api/clinics/:id/tickets', ({ p, user, body }) => {
  requireClinic(user, p.id);
  const c = findClinic(p.id);
  return ticketResponse(c, createTicket(c, { source: 'staff', petName: str(body.petName, 100), ownerName: str(body.ownerName, 100) }));
});

function callTicket(t, room) {
  t.status = 'in_service';
  t.calledAt = Date.now();
  t.room = room;
  changed('clinic:' + t.clinicId);
  return { ok: true, number: ticketNo(t.number) };
}

route('POST', '/api/clinics/:id/call-next', ({ p, user, body }) => {
  requireClinic(user, p.id);
  const next = todaysTickets(p.id).filter(t => t.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) throw new HttpError(409, 'Очередь пуста');
  return callTicket(next, str(body.room, 30));
});

route('POST', '/api/clinics/:id/tickets/:tid/call', ({ p, user, body }) => {
  requireClinic(user, p.id);
  const t = findTicket(p.id, p.tid);
  if (t.status !== 'waiting') throw new HttpError(409, 'Талон уже не в очереди');
  return callTicket(t, str(body.room, 30));
});

route('POST', '/api/clinics/:id/tickets/:tid/done', ({ p, user }) => {
  requireClinic(user, p.id);
  const t = findTicket(p.id, p.tid);
  if (t.status !== 'in_service') throw new HttpError(409, 'Пациент не на приёме');
  t.status = 'done';
  t.doneAt = Date.now();
  changed('clinic:' + p.id);
  return { ok: true };
});

route('POST', '/api/clinics/:id/tickets/:tid/cancel', ({ p, user }) => {
  requireClinic(user, p.id);
  const t = findTicket(p.id, p.tid);
  if (t.status === 'done') throw new HttpError(409, 'Приём уже завершён');
  t.status = 'cancelled';
  t.doneAt = Date.now();
  changed('clinic:' + p.id);
  return { ok: true };
});

// Клиника: настройки. Персонал может менять только число врачей на приёме.
route('PUT', '/api/clinics/:id/settings', ({ p, user, body }) => {
  requireClinic(user, p.id);
  const c = findClinic(p.id);
  if (body.rooms !== undefined) c.rooms = Math.min(50, Math.max(1, parseInt(body.rooms, 10) || 1));
  if (user.role !== 'staff') {
    if (body.name !== undefined) c.name = required(body.name, 'Название', 100);
    for (const k of ['address', 'phone', 'hours']) if (body[k] !== undefined) c[k] = str(body[k], 200);
  }
  changed('clinic:' + c.id);
  return { ok: true };
});

route('POST', '/api/clinics/:id/button-token', ({ p, user }) => {
  requireClinic(user, p.id, { admin: true });
  const c = findClinic(p.id);
  c.buttonToken = crypto.randomBytes(16).toString('hex');
  save();
  return { buttonToken: c.buttonToken };
});

// Клиника: аппараты

route('POST', '/api/clinics/:id/equipment', ({ p, user, body }) => {
  requireClinic(user, p.id, { admin: true });
  const e = { id: rid(), name: required(body.name, 'Название', 100), working: true, note: '', specialist: '', specialistDate: null };
  findClinic(p.id).equipment.push(e);
  changed('clinic:' + p.id);
  return e;
});

route('PUT', '/api/clinics/:id/equipment/:eid', ({ p, user, body }) => {
  requireClinic(user, p.id);
  const e = findIn(findClinic(p.id).equipment, p.eid, 'Аппарат');
  if (body.name !== undefined && user.role !== 'staff') e.name = required(body.name, 'Название', 100);
  if (body.working !== undefined) e.working = !!body.working;
  if (body.note !== undefined) e.note = str(body.note, 200);
  if (body.specialist !== undefined) e.specialist = str(body.specialist, 100);
  // «Специалист сегодня есть» действует только на текущую дату — завтра сбросится сам.
  if (body.specialistToday !== undefined) e.specialistDate = body.specialistToday ? today() : null;
  changed('clinic:' + p.id);
  return publicEquipment(e);
});

route('DELETE', '/api/clinics/:id/equipment/:eid', ({ p, user }) => {
  requireClinic(user, p.id, { admin: true });
  const c = findClinic(p.id);
  findIn(c.equipment, p.eid, 'Аппарат');
  c.equipment = c.equipment.filter(e => e.id !== p.eid);
  changed('clinic:' + p.id);
  return { ok: true };
});

// Клиника: цены

function priceFields(body) {
  const price = Number(String(body.price ?? '').replace(',', '.'));
  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'Некорректная цена');
  return { name: required(body.name, 'Услуга', 150), price: Math.round(price * 100) / 100, note: str(body.note, 150) };
}

route('POST', '/api/clinics/:id/prices', ({ p, user, body }) => {
  requireClinic(user, p.id, { admin: true });
  const item = { id: rid(), ...priceFields(body) };
  findClinic(p.id).prices.push(item);
  changed('clinic:' + p.id);
  return item;
});

route('PUT', '/api/clinics/:id/prices/:pid', ({ p, user, body }) => {
  requireClinic(user, p.id, { admin: true });
  Object.assign(findIn(findClinic(p.id).prices, p.pid, 'Услуга'), priceFields(body));
  changed('clinic:' + p.id);
  return { ok: true };
});

route('DELETE', '/api/clinics/:id/prices/:pid', ({ p, user }) => {
  requireClinic(user, p.id, { admin: true });
  const c = findClinic(p.id);
  findIn(c.prices, p.pid, 'Услуга');
  c.prices = c.prices.filter(x => x.id !== p.pid);
  changed('clinic:' + p.id);
  return { ok: true };
});

// Клиника: сотрудники (у каждого свой логин)

route('GET', '/api/clinics/:id/users', ({ p, user }) => {
  requireClinic(user, p.id, { admin: true });
  return db.users.filter(u => u.clinicId === p.id).map(me);
});

route('POST', '/api/clinics/:id/users', ({ p, user, body }) => {
  requireClinic(user, p.id, { admin: true });
  findClinic(p.id);
  const u = newUser({ ...validateNewUser(body, ['staff', 'clinic_admin']), clinicId: p.id });
  db.users.push(u);
  save();
  return me(u);
});

function deleteUser(target, actor) {
  if (target.id === actor.id) throw new HttpError(400, 'Нельзя удалить самого себя');
  db.users = db.users.filter(u => u.id !== target.id);
  for (const [sid, s] of Object.entries(db.sessions)) if (s.userId === target.id) delete db.sessions[sid];
  changed('vets');
  return { ok: true };
}

route('DELETE', '/api/clinics/:id/users/:uid', ({ p, user }) => {
  requireClinic(user, p.id, { admin: true });
  const target = db.users.find(u => u.id === p.uid && u.clinicId === p.id);
  if (!target) throw new HttpError(404, 'Сотрудник не найден');
  return deleteUser(target, user);
});

// Удалённый ветеринар

route('PUT', '/api/vet/status', ({ user, body }) => {
  requireUser(user, 'remote_vet');
  if (body.online !== undefined) user.online = !!body.online;
  if (body.specialization !== undefined) user.specialization = str(body.specialization, 200);
  changed('vets');
  return me(user);
});

route('GET', '/api/vet/consultations', ({ user }) => {
  requireUser(user, 'remote_vet');
  return db.consultations.filter(c => c.vetId === user.id).sort((a, b) => b.createdAt - a.createdAt).map(({ token, ...c }) => c);
});

const consultTransitions = { accept: ['new', 'accepted'], decline: ['new', 'declined'], done: ['accepted', 'done'] };

route('POST', '/api/vet/consultations/:cid/:action', ({ p, user }) => {
  requireUser(user, 'remote_vet');
  const tr = consultTransitions[p.action];
  if (!tr) throw new HttpError(404, 'Неизвестное действие');
  const c = db.consultations.find(x => x.id === p.cid && x.vetId === user.id);
  if (!c) throw new HttpError(404, 'Заявка не найдена');
  if (c.status !== tr[0]) throw new HttpError(409, 'Заявка уже в другом статусе');
  c.status = tr[1];
  if (c.status === 'accepted') c.roomUrl = `https://meet.jit.si/VetQueue-${crypto.randomBytes(10).toString('hex')}`;
  changed('consult');
  return { ok: true, roomUrl: c.roomUrl };
});

// Суперадмин: клиники и все пользователи

route('GET', '/api/admin/clinics', ({ user }) => {
  requireUser(user, 'superadmin');
  return db.clinics.map(c => ({ id: c.id, name: c.name, address: c.address, users: db.users.filter(u => u.clinicId === c.id).length }));
});

route('POST', '/api/admin/clinics', ({ user, body }) => {
  requireUser(user, 'superadmin');
  const c = newClinic({ name: required(body.name, 'Название', 100), address: str(body.address), phone: str(body.phone, 50), hours: str(body.hours) });
  db.clinics.push(c);
  changed('clinic:' + c.id);
  return { id: c.id };
});

route('DELETE', '/api/admin/clinics/:id', ({ p, user }) => {
  requireUser(user, 'superadmin');
  findClinic(p.id);
  db.clinics = db.clinics.filter(c => c.id !== p.id);
  db.tickets = db.tickets.filter(t => t.clinicId !== p.id);
  for (const u of db.users.filter(x => x.clinicId === p.id)) deleteUser(u, user);
  changed('clinic:' + p.id);
  return { ok: true };
});

route('GET', '/api/admin/users', ({ user }) => {
  requireUser(user, 'superadmin');
  return db.users.map(me);
});

route('POST', '/api/admin/users', ({ user, body }) => {
  requireUser(user, 'superadmin');
  const f = validateNewUser(body, ['staff', 'clinic_admin', 'remote_vet', 'superadmin']);
  let clinicId = null;
  if (f.role === 'staff' || f.role === 'clinic_admin') clinicId = findClinic(str(body.clinicId)).id;
  const u = newUser({ ...f, clinicId });
  db.users.push(u);
  changed('vets');
  return me(u);
});

route('DELETE', '/api/admin/users/:uid', ({ p, user }) => {
  requireUser(user, 'superadmin');
  const target = db.users.find(u => u.id === p.uid);
  if (!target) throw new HttpError(404, 'Пользователь не найден');
  return deleteUser(target, user);
});

// ---------- сервер ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Нет доступа' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Не найдено' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Метод не поддерживается' });
    return serveStatic(req, res, pathname);
  }

  try {
    let match = null;
    let r = null;
    for (r of routes) {
      if (r.method === req.method && (match = r.re.exec(pathname))) break;
    }
    if (!match) throw new HttpError(404, 'Не найдено');
    // Простая защита от CSRF: изменяющие запросы из браузера только с JSON (кнопка — исключение).
    if (req.method !== 'GET' && !pathname.startsWith('/api/button/')
      && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Ожидается application/json');
    }
    const p = {};
    r.keys.forEach((k, i) => { p[k] = decodeURIComponent(match[i + 1]); });
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler({ req, p, body, query: url.searchParams, user: currentUser(req) });
    if (out && out.body !== undefined && out.headers) send(res, 200, out.body, out.headers);
    else send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
}

// ---------- начальные данные ----------

function seed({ demo }) {
  if (db.users.some(u => u.role === 'superadmin')) return;
  const pw = process.env.ADMIN_PASSWORD || (demo ? 'admin123' : crypto.randomBytes(9).toString('base64url'));
  db.users.push(newUser({ login: 'admin', password: pw, name: 'Суперадмин', role: 'superadmin' }));
  console.log(`Создан суперадмин: логин admin, пароль ${pw}`);
  if (demo) seedDemo();
  flush();
}

function seedDemo() {
  const d = today();
  const mk = (name, address, phone, hours, equipment, prices) => {
    const c = newClinic({ name, address, phone, hours });
    c.rooms = 2;
    c.equipment = equipment.map(([n, working, specialist]) => ({
      id: rid(), name: n, working, note: working ? '' : 'В ремонте', specialist: specialist || '', specialistDate: specialist ? d : null,
    }));
    c.prices = prices.map(([n, price]) => ({ id: rid(), name: n, price, note: '' }));
    db.clinics.push(c);
    return c;
  };
  const lapa = mk('Ветклиника «Лапа»', 'Ventspils, Kuldīgas iela 1', '+371 20000001', 'Пн–Пт 9:00–19:00, Сб 10:00–15:00',
    [['Рентген', true, 'Др. Озолс'], ['УЗИ', true, ''], ['Анализатор крови', false, 'Лаборант Инга']],
    [['Первичный осмотр', 25], ['Вакцинация', 30], ['Рентген (1 снимок)', 40], ['УЗИ брюшной полости', 45], ['Анализ крови', 35]]);
  mk('VetCentrs Rīga', 'Rīga, Brīvības iela 100', '+371 20000002', 'Ежедневно 8:00–22:00',
    [['Рентген', true, 'Др. Калниня'], ['КТ', true, ''], ['УЗИ', true, 'Др. Берзиньш'], ['Стоматологическая установка', true, '']],
    [['Первичный осмотр', 30], ['Чистка зубов', 80], ['КТ', 150], ['Кастрация кота', 70]]);

  db.users.push(
    newUser({ login: 'lapa-admin', password: 'demo123', name: 'Мария (админ «Лапа»)', role: 'clinic_admin', clinicId: lapa.id }),
    newUser({ login: 'lapa-reg', password: 'demo123', name: 'Анна (регистратура)', role: 'staff', clinicId: lapa.id }),
    Object.assign(newUser({ login: 'vet-ivars', password: 'demo123', name: 'Ivars Liepa', role: 'remote_vet', specialization: 'Терапия кошек и собак' }), { online: true }),
    newUser({ login: 'vet-olga', password: 'demo123', name: 'Ольга Петрова', role: 'remote_vet', specialization: 'Экзотические животные, птицы' }),
  );

  for (const pet of ['Барсик', 'Рекс', 'Мурка', 'Шарик']) createTicket(lapa, { source: 'staff', petName: pet });
  console.log('Демо-данные: lapa-admin / lapa-reg / vet-ivars / vet-olga — пароль demo123');
}

function start() {
  loadDb();
  seed({ demo: process.argv.includes('--demo') || process.env.DEMO === '1' });
  const server = http.createServer((req, res) => { handle(req, res); });
  const shutdown = () => { if (saveTimer) flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(PORT, () => console.log(`ВетОчередь: http://localhost:${PORT}`));
  return server;
}

if (require.main === module) start();

module.exports = { start };
