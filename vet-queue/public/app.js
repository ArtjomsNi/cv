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
