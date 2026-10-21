// Общие помощники для всех страниц.

const $ = (sel, root = document) => root.querySelector(sel);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = n => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR' }).format(n);

const minutes = m => (m == null ? '—' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`);

const timeOf = ms => (ms ? new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('Нужно войти');
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  box.append(el);
  setTimeout(() => el.remove(), 3500);
}

// Выполнить действие и показать ошибку, если она случилась.
async function act(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

// Подписка на живые обновления. cb получает {scope}; вызовы схлопываются.
function onLive(cb) {
  let timer;
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    const data = JSON.parse(e.data);
    clearTimeout(timer);
    timer = setTimeout(() => cb(data), 150);
  };
  return es;
}

// Шапка для страниц персонала: имя, смена пароля, выход.
function mountUserBar(user) {
  const bar = $('#userbar');
  if (!bar) return;
  bar.innerHTML = `<span class="muted small">${esc(user.name)} (${esc(user.login)})</span>
    <button class="ghost small" id="pwBtn">Сменить пароль</button>
    <button class="ghost small" id="logoutBtn">Выйти</button>`;
  $('#logoutBtn').onclick = async () => { await api('POST', '/api/logout'); location.href = '/login.html'; };
  $('#pwBtn').onclick = () => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form class="stack" method="dialog">
      <h3>Смена пароля</h3>
      <label class="field">Старый пароль<input type="password" name="oldPassword" required autocomplete="current-password"></label>
      <label class="field">Новый пароль (мин. 6 символов)<input type="password" name="newPassword" required minlength="6" autocomplete="new-password"></label>
      <div class="row"><button type="submit">Сохранить</button><button type="button" class="ghost" value="cancel">Отмена</button></div>
    </form>`;
    document.body.append(dlg);
    dlg.querySelector('[value=cancel]').onclick = () => dlg.close();
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const ok = await act(() => api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))));
      if (ok) { toast('Пароль изменён'); dlg.close(); }
    };
    dlg.showModal();
  };
}

const ROLE_NAMES = { superadmin: 'Суперадмин', clinic_admin: 'Админ клиники', staff: 'Персонал', remote_vet: 'Удалённый ветеринар' };

// ---------- Таймлайн очереди ----------
// Каждый пациент — отрезок длиной в ожидаемое время его кейса. Дорожка = врач на приёме.

const hhmm = ms => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function paceText(tl) {
  if (tl.aheadMin == null) return '';
  if (tl.aheadMin > 0) return `⚡ Сегодня быстрее плана на ${tl.aheadMin} мин (темп ${tl.pacePct}%)`;
  if (tl.aheadMin < 0) return `🐢 Сегодня медленнее плана на ${-tl.aheadMin} мин (темп ${tl.pacePct}%)`;
  return '✓ Идём точно по плану';
}

function renderTimeline(tl, { compact = false } = {}) {
  const MIN = 60000;
  const from = tl.now - (compact ? 30 : 60) * MIN;
  const to = Math.max(tl.now + (compact ? 60 : 90) * MIN, ...tl.items.map(i => i.end)) + 5 * MIN;
  const pct = t => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100;
  const spanMin = (to - from) / MIN;
  const step = (spanMin <= 150 ? 15 : spanMin <= 360 ? 30 : 60) * MIN;
  const ticks = [];
  for (let t = Math.ceil(from / step) * step; t < to; t += step) ticks.push(`<span style="left:${pct(t)}%">${hhmm(t)}</span>`);

  const bar = i => {
    if (i.end <= from) return '';
    const left = pct(i.start);
    const width = Math.max(pct(i.end) - left, 0.8);
    const kase = i.caseKnown ? esc(i.caseName || `${i.plannedMin} мин`) : 'кейс не указан';
    let cls = i.status, text, title;
    if (i.status === 'done') {
      const diff = i.plannedMin - i.actualMin;
      cls += diff > 0 ? ' fast' : diff < 0 ? ' slow' : '';
      text = `${i.number} · ${i.actualMin}/${i.plannedMin} мин${diff > 0 ? ` · −${diff}` : diff < 0 ? ` · +${-diff}` : ''}`;
      title = `${i.number}: ${kase}. План ${i.plannedMin} мин, факт ${i.actualMin} мин (${hhmm(i.start)}–${hhmm(i.end)})`;
    } else if (i.status === 'in_service') {
      if (i.overdue) cls += ' overdue';
      const progress = Math.min(100, ((tl.now - i.start) / (i.end - i.start || 1)) * 100);
      text = `${i.number} · ${kase} · ${i.overdue ? 'задерживается' : 'до ≈' + hhmm(i.end)}`;
      title = `${i.number}${i.room ? ' (' + esc(i.room) + ')' : ''}: ${kase}, начало ${hhmm(i.start)}, план ${i.plannedMin} мин`;
      return `<div class="tl-bar ${cls}" style="left:${left}%;width:${width}%;--p:${progress}%" title="${title}">${text}</div>`;
    } else {
      if (!i.caseKnown) cls += ' unknown';
      text = `${i.number} · ≈${hhmm(i.start)} · ${kase}`;
      title = `${i.number}: ${kase}. Примерно ${hhmm(i.start)}–${hhmm(i.end)} (через ${i.waitMin} мин)`;
    }
    return `<div class="tl-bar ${cls}" style="left:${left}%;width:${width}%" title="${title}">${text}</div>`;
  };

  const rows = Array.from({ length: tl.lanes }, (_, lane) =>
    `<div class="tl-row">${tl.items.filter(i => i.lane === lane).map(bar).join('')}</div>`).join('');
  const labels = Array.from({ length: tl.lanes }, (_, lane) => `<div>Врач ${lane + 1}</div>`).join('');
  const next = tl.nextFreeAt - tl.now < MIN ? 'сейчас' : `≈ ${hhmm(tl.nextFreeAt)} (через ${Math.round((tl.nextFreeAt - tl.now) / MIN)} мин)`;

  return `<div class="tl${compact ? ' compact' : ''}">
    <div class="tl-labels"><div></div>${labels}</div>
    <div class="tl-scroll"><div class="tl-inner">
      <div class="tl-axis">${ticks.join('')}</div>${rows}
      <div class="tl-now" style="left:${pct(tl.now)}%"><span>сейчас</span></div>
    </div></div>
  </div>
  <div class="tl-summary">Новый пациент попадёт к врачу: <b>${next}</b>${paceText(tl) ? ` · ${paceText(tl)}` : ''}</div>`;
}

const TL_LEGEND = `<div class="tl-legend">
  <span><i style="background:var(--accent)"></i>на приёме</span>
  <span><i style="border:1px dashed var(--accent)"></i>ожидает (≈ время)</span>
  <span><i style="background:var(--ok-soft)"></i>прошёл быстрее плана</span>
  <span><i style="background:var(--warn-soft)"></i>дольше плана</span>
  <span><i style="background:var(--bad)"></i>задерживается</span>
</div>`;
