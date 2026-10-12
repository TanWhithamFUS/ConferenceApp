(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
    },
  };
  const csrf = ($('meta[name="csrf-token"]') || {}).content || '';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  /* ---------- Local time helpers (attendees are on site, so device time = event time) ---------- */
  function nowParts() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  function fmtTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  function slotEnd(item) {
    if (item.e) return item.e;
    const [h, m] = item.s.split(':').map(Number);
    const t = Math.min(h * 60 + m + 30, 23 * 60 + 59);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  /* ---------- Conference picker ---------- */
  const search = $('#event-search');
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      $$('[data-search]').forEach((li) => {
        const match = !q || li.dataset.search.includes(q);
        li.hidden = !match;
        if (match) shown++;
      });
      $$('.event-group').forEach((g) => { g.hidden = !$$('[data-search]', g).some((li) => !li.hidden); });
      $('#no-results').hidden = shown > 0;
    });
    const last = store.get('lastEvent', null);
    const box = $('#continue');
    if (last && last.slug && box) {
      const a = document.createElement('a');
      a.href = `/e/${encodeURIComponent(last.slug)}`;
      const label = document.createElement('div');
      label.innerHTML = '<div class="eyebrow">Continue to</div>';
      const name = document.createElement('strong');
      name.textContent = last.name;
      label.appendChild(name);
      a.appendChild(label);
      a.insertAdjacentHTML('beforeend', '<span aria-hidden="true">→</span>');
      box.appendChild(a);
      box.hidden = false;
    }
  }

  /* ---------- Conference pages ---------- */
  const main = $('.event-main');
  const slug = main && main.dataset.eventSlug;
  if (slug) store.set('lastEvent', { slug, name: main.dataset.eventName });

  // Now / next on the conference home screen.
  const nn = $('#now-next');
  if (nn) {
    const items = JSON.parse(nn.dataset.items || '[]');
    const { date, time } = nowParts();
    const today = items.filter((i) => i.d === date);
    const now = today.filter((i) => i.s <= time && time < slotEnd(i));
    const next = today.find((i) => i.s > time);
    const rows = [];
    const row = (label, i) => {
      const div = document.createElement('div');
      div.className = 'nn-row';
      div.innerHTML = `<div class="nn-label"></div><strong></strong><div class="muted small"></div>`;
      div.children[0].textContent = label;
      div.children[1].textContent = i.t;
      div.children[2].textContent = `${fmtTime(i.s)}${i.e ? ` – ${fmtTime(i.e)}` : ''}${i.l ? ` · ${i.l}` : ''}`;
      return div;
    };
    now.forEach((i) => rows.push(row('Happening now', i)));
    if (next) rows.push(row('Up next', next));
    if (rows.length) {
      const body = $('#now-next-body');
      rows.forEach((r) => body.appendChild(r));
      nn.hidden = false;
    }
  }

  // Schedule: day tabs, stars, "my schedule", now/past highlighting.
  const dayTabs = $$('.day-tab');
  if (dayTabs.length) {
    const show = (day) => {
      dayTabs.forEach((t) => { const on = t.dataset.day === day; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
      $$('section.day').forEach((s) => { s.hidden = s.dataset.day !== day; });
      updateMineEmpty();
    };
    dayTabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.day)));
    const { date, time } = nowParts();
    if (dayTabs.some((t) => t.dataset.day === date)) show(date);

    $$('.slot').forEach((li) => {
      if (li.dataset.date < date) li.classList.add('is-past');
      if (li.dataset.date === date) {
        const end = slotEnd({ s: li.dataset.start, e: li.dataset.end });
        if (end <= time) li.classList.add('is-past');
        else if (li.dataset.start <= time) li.classList.add('is-now');
      }
    });

    const key = `starred:${slug}`;
    const starred = new Set(store.get(key, []));
    const mine = $('#mine-only');
    function applyStars() {
      $$('[data-star]').forEach((b) => {
        const on = starred.has(b.dataset.star);
        b.setAttribute('aria-pressed', on);
        b.setAttribute('aria-label', on ? 'Remove from my schedule' : 'Add to my schedule');
      });
      $$('.slot').forEach((li) => { li.hidden = mine.checked && !starred.has(li.dataset.id); });
      updateMineEmpty();
    }
    function updateMineEmpty() {
      const visibleDay = $('section.day:not([hidden])');
      const any = visibleDay && $$('.slot', visibleDay).some((li) => !li.hidden);
      const empty = $('#mine-empty');
      if (empty) empty.hidden = !mine || !mine.checked || any;
    }
    $$('[data-star]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.star;
      if (starred.has(id)) starred.delete(id); else starred.add(id);
      store.set(key, [...starred]);
      applyStars();
    }));
    mine.checked = store.get('mineOnly', false);
    mine.addEventListener('change', () => { store.set('mineOnly', mine.checked); applyStars(); });
    applyStars();
  }

  /* ---------- Push notifications ---------- */
  const pushCard = $('#push-card');
  if (pushCard && slug) setupPush();

  async function setupPush() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) {
      if (isIOS && !standalone) $('#ios-hint').hidden = false;
      return;
    }
    const button = $('#push-toggle');
    const status = $('#push-status');
    pushCard.hidden = false;

    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const subscribedSlugs = new Set(store.get('pushSlugs', []));
    let on = !!sub && subscribedSlugs.has(slug) && Notification.permission === 'granted';

    function render() {
      if (Notification.permission === 'denied') {
        status.textContent = 'Notifications are blocked. Turn them on in your browser or phone settings.';
        button.hidden = true;
        return;
      }
      status.textContent = on ? 'You’ll get alerts for announcements and changes.' : 'Turn on notifications for schedule changes and announcements.';
      button.textContent = on ? 'Turn off' : 'Turn on';
      button.classList.toggle('btn-outline', on);
    }
    render();

    async function post(path, body) {
      const res = await fetch(`/api/push/${encodeURIComponent(slug)}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Request failed');
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (on) {
          if (sub) await post('unsubscribe', { endpoint: sub.endpoint });
          subscribedSlugs.delete(slug);
          if (sub && subscribedSlugs.size === 0) { await sub.unsubscribe(); sub = null; }
          on = false;
        } else {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') { render(); return; }
          if (!sub) {
            const { publicKey } = await (await fetch('/api/push/key')).json();
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
          }
          await post('subscribe', sub.toJSON());
          subscribedSlugs.add(slug);
          on = true;
        }
        store.set('pushSlugs', [...subscribedSlugs]);
      } catch (err) {
        status.textContent = 'Something went wrong. Please try again.';
        console.error(err);
        return;
      } finally {
        button.disabled = false;
      }
      render();
    });
  }

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  /* ---------- Management helpers ---------- */
  document.addEventListener('submit', (e) => {
    const msg = (e.submitter && e.submitter.dataset.confirm) || e.target.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  $$('[data-toggle-partner]').forEach((select) => {
    const field = $('[data-partner-field]', select.form);
    const sync = () => { if (field) field.hidden = select.value !== 'partner'; };
    select.addEventListener('change', sync);
    sync();
  });

  $$('[data-check-all]').forEach((box) => {
    box.addEventListener('change', () => {
      $$(`input[name="${box.dataset.checkAll}"]`, box.form).forEach((b) => { b.checked = box.checked; });
    });
  });

  $$('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
  $$('[data-select-all]').forEach((i) => i.addEventListener('focus', () => i.select()));
  $$('[data-origin]').forEach((el) => { el.textContent = location.origin + el.textContent; });
}());
