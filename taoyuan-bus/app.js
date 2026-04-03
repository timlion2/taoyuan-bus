'use strict';

/* ═══════════════════════════════════════════
   TDX API Client
═══════════════════════════════════════════ */
const TDX = {
  BASE: 'https://tdx.transportdata.tw/api/basic/v2',
  TOKEN_URL: 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
  _token: null,
  _tokenExp: 0,

  get clientId()     { return localStorage.getItem('tdx_client_id') || ''; },
  get clientSecret() { return localStorage.getItem('tdx_client_secret') || ''; },
  get hasCredentials() { return !!(this.clientId && this.clientSecret); },

  async getToken() {
    if (this._token && Date.now() < this._tokenExp) return this._token;
    const res = await fetch(this.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}`
    });
    if (!res.ok) throw new Error('Token 取得失敗，請確認 API 憑證是否正確');
    const data = await res.json();
    this._token = data.access_token;
    this._tokenExp = Date.now() + (data.expires_in - 60) * 1000;
    return this._token;
  },

  async get(path) {
    const token = await this.getToken();
    const res = await fetch(`${this.BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`API 錯誤 ${res.status}`);
    return res.json();
  },

  // 搜尋路線 (桃園市)
  async searchRoutes(keyword) {
    const enc = encodeURIComponent(keyword);
    const path = `/Bus/Route/City/Taoyuan?$filter=contains(RouteName/Zh_tw,'${enc}')&$top=30&$format=JSON`;
    return this.get(path);
  },

  // 取得路線下行/上行站牌
  async getStops(routeName) {
    const enc = encodeURIComponent(routeName);
    return this.get(`/Bus/StopOfRoute/City/Taoyuan/${enc}?$format=JSON`);
  },

  // 取得即時到站時間
  async getETA(routeName) {
    const enc = encodeURIComponent(routeName);
    return this.get(`/Bus/EstimatedTimeOfArrival/City/Taoyuan/${enc}?$format=JSON`);
  },

  // 取得時刻表
  async getSchedule(routeName) {
    const enc = encodeURIComponent(routeName);
    return this.get(`/Bus/Schedule/City/Taoyuan/${enc}?$format=JSON`);
  }
};

/* ═══════════════════════════════════════════
   State
═══════════════════════════════════════════ */
const State = {
  currentRoute: null,
  stopsData: [],   // [{Direction, Stops:[...]}]
  etaData: [],     // flat ETA list
  realtimeDir: 0,
  stopsDir: 0,
  pageHistory: ['home'],
  etaRefreshTimer: null,
};

/* ═══════════════════════════════════════════
   Favorites
═══════════════════════════════════════════ */
const Favs = {
  get() { return JSON.parse(localStorage.getItem('favs') || '[]'); },
  has(routeId) { return this.get().some(r => r.RouteUID === routeId); },
  toggle(route) {
    const list = this.get();
    const idx = list.findIndex(r => r.RouteUID === route.RouteUID);
    if (idx >= 0) list.splice(idx, 1);
    else list.unshift(route);
    localStorage.setItem('favs', JSON.stringify(list.slice(0, 20)));
    return idx < 0; // true = added
  }
};

/* ═══════════════════════════════════════════
   UI Helpers
═══════════════════════════════════════════ */
const $ = id => document.getElementById(id);

function showLoading()  { $('loading').classList.remove('hidden'); }
function hideLoading()  { $('loading').classList.add('hidden'); }

let _toastTimer;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ═══════════════════════════════════════════
   App Controller
═══════════════════════════════════════════ */
const App = {

  /* ── Init ── */
  init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    this.renderFavorites();
    App.showPage('home', false);
  },

  /* ── Pages ── */
  showPage(name, pushHistory = true) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $(`page-${name}`).classList.add('active');

    const backBtn    = $('back-btn');
    const settBtn    = $('settings-btn');
    const titleEl    = $('page-title');

    const titles = { home: '桃園公車查詢', route: '', settings: '設定' };
    titleEl.textContent = titles[name] || '';

    if (name === 'home') {
      backBtn.classList.add('hidden');
      settBtn.classList.remove('hidden');
    } else if (name === 'settings') {
      backBtn.classList.remove('hidden');
      settBtn.classList.add('hidden');
      titleEl.textContent = '設定';
      this.loadSettingsForm();
    } else {
      backBtn.classList.remove('hidden');
      settBtn.classList.remove('hidden');
    }

    if (pushHistory && State.pageHistory[State.pageHistory.length - 1] !== name) {
      State.pageHistory.push(name);
    }

    window.scrollTo(0, 0);
    this.stopEtaRefresh();
  },

  goBack() {
    if (State.pageHistory.length > 1) State.pageHistory.pop();
    const prev = State.pageHistory[State.pageHistory.length - 1];
    this.showPage(prev, false);
  },

  /* ── Search ── */
  onSearchInput(val) {
    $('clear-btn').classList.toggle('hidden', !val);
  },

  clearSearch() {
    $('route-input').value = '';
    $('clear-btn').classList.add('hidden');
    $('section-results').classList.add('hidden');
    $('section-favorites').classList.remove('hidden');
  },

  async searchRoutes() {
    const keyword = $('route-input').value.trim();
    if (!keyword) { showToast('請輸入路線號碼'); return; }
    if (!TDX.hasCredentials) {
      this.showNeedSettings($('results-list'));
      $('section-results').classList.remove('hidden');
      $('section-favorites').classList.add('hidden');
      return;
    }
    showLoading();
    try {
      const data = await TDX.searchRoutes(keyword);
      this.renderRouteList(data, $('results-list'));
      const count = data.length;
      $('results-count').textContent = `共 ${count} 條`;
      $('section-results').classList.remove('hidden');
      $('section-favorites').classList.add('hidden');
    } catch (e) {
      showToast(e.message || '查詢失敗');
    } finally {
      hideLoading();
    }
  },

  /* ── Route List ── */
  renderRouteList(routes, container) {
    if (!routes || routes.length === 0) {
      container.innerHTML = `<div class="empty-state"><span class="empty-icon">🚌</span><p>找不到相關路線</p></div>`;
      return;
    }
    container.innerHTML = routes.map(r => this.routeCardHTML(r)).join('');
  },

  routeCardHTML(r) {
    const name  = r.RouteName?.Zh_tw || '';
    const dep   = r.DepartureStopNameZh || '';
    const dest  = r.DestinationStopNameZh || '';
    const isFav = Favs.has(r.RouteUID);
    const key   = registerRoute(r);
    return `
      <div class="route-card" onclick="App.openRouteByKey('${key}')">
        <div class="route-card-accent"></div>
        <div class="route-card-body">
          <div class="route-number">${name}</div>
          <div class="route-name">${dep} ↔ ${dest}</div>
        </div>
        <button class="route-card-fav ${isFav ? 'active' : ''}"
          onclick="event.stopPropagation(); App.toggleFavByKey(this, '${key}')"
          title="加入常用">
          ${isFav ? '★' : '☆'}
        </button>
      </div>`;
  },

  /* ── Favorites ── */
  renderFavorites() {
    const favs = Favs.get();
    const el   = $('favorites-list');
    if (!favs.length) {
      el.innerHTML = `<div class="empty-state"><span class="empty-icon">★</span><p>查詢路線後，點擊 ☆ 可加入常用路線</p></div>`;
      return;
    }
    // 確保 favorites 的路線也進入 Registry
    favs.forEach(r => registerRoute(r));
    el.innerHTML = favs.map(r => this.routeCardHTML(r)).join('');
  },

  toggleFav(btn, route) {
    const added = Favs.toggle(route);
    btn.textContent = added ? '★' : '☆';
    btn.classList.toggle('active', added);
    showToast(added ? '已加入常用路線' : '已移除常用路線');
    this.renderFavorites();
  },

  clearFavorites() {
    if (!confirm('確定要清除所有常用路線？')) return;
    localStorage.removeItem('favs');
    this.renderFavorites();
    showToast('已清除常用路線');
  },

  /* ── Open Route ── */
  async openRoute(route) {
    if (!TDX.hasCredentials) {
      this.showPage('settings');
      showToast('請先設定 API 憑證');
      return;
    }

    State.currentRoute = route;
    State.realtimeDir  = 0;
    State.stopsDir     = 0;

    const name = route.RouteName?.Zh_tw || '';
    $('page-title').textContent = `路線 ${name}`;

    // Render header
    const dep  = route.DepartureStopNameZh || '';
    const dest = route.DestinationStopNameZh || '';
    const isFav = Favs.has(route.RouteUID);
    $('route-header').innerHTML = `
      <div style="position:relative">
        <div class="rh-number">${name}</div>
        <div class="rh-name">${dep} ↔ ${dest}</div>
        <div class="rh-meta">
          <span class="rh-badge">桃園市</span>
          ${route.OperatorNames?.map(o => `<span class="rh-badge">${o.Zh_tw || ''}</span>`).join('') || ''}
        </div>
        <button class="fav-toggle" onclick="App.toggleFavFromHeader(this)" data-is-fav="${isFav}">
          ${isFav ? '★' : '☆'}
        </button>
      </div>`;

    // Reset tabs
    document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    document.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('active', i === 0));
    this.setDirBtns('rt-dir', 0);

    this.showPage('route');
    this.loadRealtime();
  },

  openRouteByKey(key) {
    const r = RouteRegistry.get(key);
    if (r) this.openRoute(r);
  },

  toggleFavByKey(btn, key) {
    const r = RouteRegistry.get(key);
    if (r) this.toggleFav(btn, r);
  },

  toggleFavFromHeader(btn) {
    const isFav = btn.dataset.isFav === 'true';
    const added = Favs.toggle(State.currentRoute);
    btn.dataset.isFav = added;
    btn.textContent = added ? '★' : '☆';
    showToast(added ? '已加入常用路線' : '已移除常用路線');
    this.renderFavorites();
  },

  /* ── Tabs ── */
  switchTab(tab, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${tab}`).classList.add('active');

    this.stopEtaRefresh();
    if (tab === 'realtime') this.loadRealtime();
    if (tab === 'schedule') this.loadSchedule();
    if (tab === 'stops')    this.loadStops();
  },

  /* ── Realtime ── */
  setRealtimeDir(dir) {
    State.realtimeDir = dir;
    this.setDirBtns('rt-dir', dir);
    this.renderRealtime();
  },

  async loadRealtime() {
    const route = State.currentRoute;
    showLoading();
    try {
      const [stopsArr, etaArr] = await Promise.all([
        TDX.getStops(route.RouteName?.Zh_tw),
        TDX.getETA(route.RouteName?.Zh_tw)
      ]);
      State.stopsData = stopsArr;
      State.etaData   = etaArr;
      this.renderRealtime();
      this.startEtaRefresh();
    } catch (e) {
      $('realtime-content').innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><p>${e.message}</p></div>`;
    } finally {
      hideLoading();
    }
  },

  renderRealtime() {
    const dir   = State.realtimeDir;
    const stops = (State.stopsData.find(s => s.Direction === dir) || State.stopsData[dir])?.Stops || [];
    const etaMap = {};
    State.etaData.filter(e => e.Direction === dir).forEach(e => {
      etaMap[e.StopUID] = e;
    });

    if (!stops.length) {
      $('realtime-content').innerHTML = `<div class="empty-state"><span class="empty-icon">🚌</span><p>暫無站牌資料</p></div>`;
      return;
    }

    const now = Date.now();
    const rows = stops.map((stop, idx) => {
      const eta  = etaMap[stop.StopUID] || {};
      const sec  = eta.EstimateTime;
      const stat = eta.StopStatus; // 0=正常 1=尚未發車 2=交管 3=末班已過 4=今日未行駛

      let etaHTML = '';
      let dotCls  = '';

      if (stat === 1) { etaHTML = `<span class="stop-eta eta-none">尚未發車</span>`; }
      else if (stat === 3) { etaHTML = `<span class="stop-eta eta-none">末班已過</span>`; }
      else if (stat === 4) { etaHTML = `<span class="stop-eta eta-none">今日未行駛</span>`; }
      else if (sec === undefined) { etaHTML = `<span class="stop-eta eta-none">—</span>`; }
      else if (sec <= 0)  { etaHTML = `<span class="stop-eta eta-arriving">進站中</span>`; dotCls = 'arrived'; }
      else if (sec <= 60) { etaHTML = `<span class="stop-eta eta-arriving">即將進站</span><br><span class="bus-badge">🚌 約 ${sec} 秒</span>`; dotCls = 'arrived'; }
      else if (sec <= 180){ etaHTML = `<span class="stop-eta eta-soon">約 ${Math.ceil(sec/60)} 分鐘</span>`; dotCls = 'approaching'; }
      else                { etaHTML = `<span class="stop-eta eta-normal">約 ${Math.ceil(sec/60)} 分鐘</span>`; }

      const isFirst = idx === 0;
      const isLast  = idx === stops.length - 1;
      const terminalCls = (isFirst || isLast) ? ' terminal' : '';

      return `
        <div class="stop-item">
          <div class="stop-timeline">
            ${isFirst ? '' : '<div class="stop-line"></div>'}
            <div class="stop-dot${terminalCls}${dotCls ? ' ' + dotCls : ''}"></div>
            ${isLast ? '' : '<div class="stop-line"></div>'}
          </div>
          <div class="stop-info">
            <div class="stop-seq">${stop.StopSequence}</div>
            <div class="stop-name">${stop.StopName?.Zh_tw || ''}</div>
            ${etaHTML}
          </div>
        </div>`;
    });

    const updated = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('realtime-content').innerHTML =
      `<div class="info-bar">更新：${updated}</div>` + rows.join('');
  },

  startEtaRefresh() {
    this.stopEtaRefresh();
    State.etaRefreshTimer = setInterval(async () => {
      try {
        State.etaData = await TDX.getETA(State.currentRoute.RouteName?.Zh_tw);
        this.renderRealtime();
      } catch (_) {}
    }, 30000);
  },

  stopEtaRefresh() {
    if (State.etaRefreshTimer) {
      clearInterval(State.etaRefreshTimer);
      State.etaRefreshTimer = null;
    }
  },

  /* ── Stops ── */
  setStopsDir(dir) {
    State.stopsDir = dir;
    this.setDirBtns('stops-dir', dir);
    this.renderStops();
  },

  async loadStops() {
    if (!State.stopsData.length) {
      showLoading();
      try {
        State.stopsData = await TDX.getStops(State.currentRoute.RouteName?.Zh_tw);
      } catch (e) {
        $('stops-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`;
        hideLoading(); return;
      } finally { hideLoading(); }
    }
    this.renderStops();
  },

  renderStops() {
    const dir   = State.stopsDir;
    const stops = (State.stopsData.find(s => s.Direction === dir) || State.stopsData[dir])?.Stops || [];
    if (!stops.length) {
      $('stops-content').innerHTML = `<div class="empty-state"><p>暫無資料</p></div>`;
      return;
    }
    $('stops-content').innerHTML = stops.map((stop, idx) => {
      const isFirst = idx === 0, isLast = idx === stops.length - 1;
      return `
        <div class="stop-item">
          <div class="stop-timeline">
            ${isFirst ? '' : '<div class="stop-line"></div>'}
            <div class="stop-dot${(isFirst||isLast) ? ' terminal' : ''}"></div>
            ${isLast ? '' : '<div class="stop-line"></div>'}
          </div>
          <div class="stop-info">
            <div class="stop-seq">${stop.StopSequence}</div>
            <div class="stop-name">${stop.StopName?.Zh_tw || ''}</div>
          </div>
        </div>`;
    }).join('');
  },

  /* ── Schedule ── */
  async loadSchedule() {
    showLoading();
    try {
      const data = await TDX.getSchedule(State.currentRoute.RouteName?.Zh_tw);
      this.renderSchedule(data);
    } catch (e) {
      $('schedule-content').innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><p>${e.message}</p></div>`;
    } finally { hideLoading(); }
  },

  renderSchedule(data) {
    if (!data || !data.length) {
      $('schedule-content').innerHTML = `<div class="empty-state"><span class="empty-icon">📅</span><p>暫無時刻表資料</p></div>`;
      return;
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // Group by Direction
    const dirs = {};
    data.forEach(d => {
      const dir = d.Direction ?? 0;
      if (!dirs[dir]) dirs[dir] = [];
      (d.Timetables || []).forEach(t => {
        (t.StopTimes || []).forEach(st => {
          if (st.StopSequence === 1 && st.DepartureTime) {
            dirs[dir].push(st.DepartureTime);
          }
        });
      });
    });

    let html = '';
    [0, 1].forEach(dir => {
      const times = (dirs[dir] || []).sort();
      if (!times.length) return;
      const label = dir === 0 ? '去程' : '返程';
      const chips = times.map(t => {
        const [h, m] = t.split(':').map(Number);
        const isPast = (h * 60 + m) < nowMin;
        return `<div class="time-chip ${isPast ? 'past' : ''}">${t.slice(0, 5)}</div>`;
      }).join('');
      html += `<div class="schedule-section"><h3>${label}</h3><div class="schedule-grid">${chips}</div></div>`;
    });

    $('schedule-content').innerHTML = html || `<div class="empty-state"><p>暫無資料</p></div>`;
  },

  /* ── Settings ── */
  loadSettingsForm() {
    $('input-client-id').value     = TDX.clientId;
    $('input-client-secret').value = TDX.clientSecret;
    $('settings-msg').classList.add('hidden');
  },

  async saveSettings() {
    const id  = $('input-client-id').value.trim();
    const sec = $('input-client-secret').value.trim();
    if (!id || !sec) { showSettingsMsg('請填寫 Client ID 和 Client Secret', 'error'); return; }

    localStorage.setItem('tdx_client_id', id);
    localStorage.setItem('tdx_client_secret', sec);
    TDX._token = null;

    showLoading();
    try {
      await TDX.getToken();
      showSettingsMsg('設定成功！API 連線正常', 'success');
    } catch (e) {
      showSettingsMsg(`連線失敗：${e.message}`, 'error');
    } finally { hideLoading(); }
  },

  togglePassword() {
    const inp = $('input-client-secret');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  },

  /* ── Util ── */
  setDirBtns(prefix, dir) {
    [0, 1].forEach(d => {
      const btn = $(`${prefix}-${d}`);
      if (btn) btn.classList.toggle('active', d === dir);
    });
  },

  showNeedSettings(container) {
    container.innerHTML = `
      <div class="no-credentials-msg">
        <span class="big-icon">🔑</span>
        <p>請先設定 TDX API 憑證才能查詢路線</p>
        <button onclick="App.showPage('settings')">前往設定</button>
      </div>`;
  }
};

/* ── Route Registry（避免 onclick 屬性中 JSON 斷裂）── */
const RouteRegistry = new Map();

function registerRoute(r) {
  const key = r.RouteUID || r.RouteID || `r_${Math.random().toString(36).slice(2)}`;
  RouteRegistry.set(key, r);
  return key;
}

/* ── Helpers ── */
function showSettingsMsg(msg, type) {
  const el = $('settings-msg');
  el.textContent = msg;
  el.className = `settings-msg ${type}`;
}

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
