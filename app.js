let state = { incidents: [], officers: [], sites: [], tours: [], activity: [], incidentFilter: 'All', demoDataControls: false };
let currentView = 'dashboard';
let toastTimer;
let currentUser = null;
let csrfToken = '';
let quickNavOpen = false;

const pageContent = document.getElementById('pageContent');
const modalLayer = document.getElementById('modalLayer');
const modalCard = document.getElementById('modalCard');
const toastElement = document.getElementById('toast');
const authScreen = document.getElementById('authScreen');
const appShell = document.getElementById('appShell');
const loginForm = document.getElementById('loginForm');
const loginMessage = document.getElementById('loginMessage');
const casdoorLoginButton = document.getElementById('casdoorLoginButton');

const viewTitles = {
  dashboard: 'Command center',
  incidents: 'Incidents',
  patrols: 'Patrols & tours',
  officers: 'Officers',
  sites: 'Sites & posts',
  reports: 'Reports',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase()) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setTheme(theme) {
  const selectedTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selectedTheme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = selectedTheme === 'dark' ? '#101923' : '#f4f7f8';

  try { localStorage.setItem('northstar-theme', selectedTheme); } catch { /* Theme preference is optional. */ }
  document.querySelectorAll('[data-action="toggle-theme"]').forEach((button) => {
    const nextTheme = selectedTheme === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-checked', String(selectedTheme === 'dark'));
    button.setAttribute('aria-label', 'Switch to ' + nextTheme + ' theme');
    button.setAttribute('title', 'Switch to ' + nextTheme + ' theme');
  });
}

function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

function setFontSize(size) {
  const scale = { small: 1, medium: 1.15, large: 1.32 }[size] || 1.15;
  document.documentElement.style.setProperty('--font-scale', String(scale));
  document.querySelectorAll('[data-font-size]').forEach((button) => {
    const selected = button.dataset.fontSize === size;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('active', selected);
  });
  try { localStorage.setItem('northstar-font-size', size); } catch { /* Text sizing preference is optional. */ }
}

function updateLiveClock() {
  const clock = document.getElementById('liveClock');
  if (!clock) return;
  const now = new Date();
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (currentUser?.timezone) options.timeZone = currentUser.timezone;
  clock.textContent = new Intl.DateTimeFormat(undefined, options).format(now);
  clock.dateTime = now.toISOString();
}

function closeAccountMenus() {
  const profileMenu = document.getElementById('profileMenu');
  if (profileMenu) profileMenu.hidden = true;
  document.querySelectorAll('[data-action="toggle-profile-menu"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  const quickNavMenu = document.getElementById('quickNavMenu');
  if (quickNavMenu) quickNavMenu.hidden = true;
  document.querySelectorAll('[data-action="toggle-quick-nav"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  quickNavOpen = false;
}

function showLogin(message = '') {
  currentUser = null;
  csrfToken = '';
  currentView = 'dashboard';
  state = { incidents: [], officers: [], sites: [], tours: [], activity: [], incidentFilter: 'All', demoDataControls: false };
  closeAccountMenus();
  closeModal();
  authScreen.hidden = false;
  appShell.hidden = true;
  if (loginMessage) {
    loginMessage.textContent = message;
    loginMessage.hidden = !message;
  }
}

function displayUser(user) {
  const initials = String(user.name || user.email).split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  document.querySelectorAll('.profile-label strong').forEach((node) => { node.textContent = user.name; });
  document.querySelectorAll('.profile-label small').forEach((node) => { node.textContent = user.role + ' · ' + user.tenantName; });
  document.querySelectorAll('.avatar').forEach((node) => {
    node.textContent = initials;
    if (user.avatarUrl) node.style.backgroundImage = 'url("' + user.avatarUrl + '?v=' + encodeURIComponent(user.id) + '")';
    else node.style.backgroundImage = '';
  });
  const tenant = document.querySelector('.tenant-copy strong');
  if (tenant) tenant.textContent = user.tenantName;
  updateLiveClock();
  const service = document.querySelector('.service-status');
  if (service) {
    service.querySelector('strong').textContent = 'WORKSPACE ONLINE';
    service.querySelector('small').textContent = 'Authenticated workspace';
    service.classList.add('connected');
  }
  const connectedPill = document.getElementById('connectionPill');
  if (connectedPill) connectedPill.textContent = user.tenantName;
  document.querySelectorAll('[data-admin-only]').forEach((node) => { node.hidden = user.role !== 'admin'; });
  document.querySelectorAll('[data-management-only]').forEach((node) => { node.hidden = user.role === 'guard'; });
  document.querySelectorAll('[data-demo-only]').forEach((node) => { node.hidden = !state.demoDataControls; });
}

async function loadWorkspace() {
  const data = await apiRequest('/api/state');
  state = { ...data, incidentFilter: state.incidentFilter || 'All' };
  render();
}

async function enterWorkspace(user, token) {
  currentUser = user;
  csrfToken = token;
  displayUser(user);
  try {
    await loadWorkspace();
    authScreen.hidden = true;
    appShell.hidden = false;
  } catch (error) {
    showLogin(error.status === 401 ? 'Your session expired. Please sign in again.' : 'The database is unavailable. Check the server and database, then try again.');
  }
}

async function initialize() {
  let theme = 'light';
  try { theme = localStorage.getItem('northstar-theme') || 'light'; } catch { /* Theme preference is optional. */ }
  setTheme(theme);
  const signInUrl = new URL(window.location.href);
  const ssoFailed = signInUrl.searchParams.get('sso') === 'failed';
  if (signInUrl.searchParams.has('sso')) {
    signInUrl.searchParams.delete('sso');
    history.replaceState(null, '', signInUrl.pathname + signInUrl.search + signInUrl.hash);
  }
  try {
    const provider = await apiRequest('/api/auth/casdoor/status');
    if (casdoorLoginButton) casdoorLoginButton.hidden = !provider.enabled;
  } catch {
    if (casdoorLoginButton) casdoorLoginButton.hidden = true;
  }
  try {
    const session = await apiRequest('/api/auth/session');
    if (session.user) await enterWorkspace(session.user, session.csrfToken);
    else showLogin(ssoFailed ? 'Casdoor sign-in could not be completed. Check the account and try again.' : '');
  } catch {
    showLogin('The service is unavailable. Check the server and database, then try again.');
  }
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 2800);
}

function openCount() {
  return state.incidents.filter((incident) => incident.status !== 'resolved').length;
}

function pageHeading(eyebrow, title, subtitle, actions = '') {
  return `<div class="page-heading">
    <div><div class="page-eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div>
    <div class="heading-actions">${actions}</div>
  </div>`;
}

function newDispatchButton() {
  return `<button class="primary-btn" type="button" data-action="new-dispatch"><span class="button-plus">＋</span> ${currentUser?.role === 'guard' ? 'Report incident' : 'New dispatch'}</button>`;
}

function statusChip(status) {
  const labels = { open: 'OPEN', assigned: 'ASSIGNED', resolved: 'RESOLVED' };
  return `<span class="status-chip ${status === 'assigned' ? 'assigned' : ''} ${status === 'resolved' ? 'resolved' : ''}"><span class="status-dot"></span>${labels[status] || 'OPEN'}</span>`;
}

function severityLabel(severity) {
  return severity === 'critical' ? '<span class="priority">● CRITICAL</span>' : `${severity.toUpperCase()} PRIORITY`;
}

function incidentRow(incident) {
  return `<article class="incident-row" role="button" tabindex="0" data-action="open-incident" data-id="${escapeHtml(incident.id)}" aria-label="Open ${escapeHtml(incident.title)}">
    <span class="severity-bar ${escapeHtml(incident.severity)}"></span>
    <div class="incident-copy">
      <div class="incident-type">${severityLabel(incident.severity)} <span class="meta-separator">·</span> ${escapeHtml(incident.type)}</div>
      <div class="incident-title">${escapeHtml(incident.title)}</div>
      <div class="incident-meta"><span>${escapeHtml(incident.site)}</span><span class="meta-separator">·</span><span>${escapeHtml(incident.location)}</span></div>
    </div>
    <div class="incident-trailing"><span class="age-text">${escapeHtml(incident.opened)}</span>${statusChip(incident.status)}</div>
  </article>`;
}

function incidentCard(incident) {
  return `<article class="incident-card" tabindex="0" role="button" data-action="open-incident" data-id="${escapeHtml(incident.id)}" aria-label="Open ${escapeHtml(incident.title)}">
    <div class="incident-card-top"><div class="incident-type"><span class="severity-bar ${escapeHtml(incident.severity)}" ></span>${severityLabel(incident.severity)} · ${escapeHtml(incident.type)}</div>${statusChip(incident.status)}</div>
    <div class="incident-card-title">${escapeHtml(incident.title)}</div>
    <div class="incident-card-description">${escapeHtml(incident.description)}</div>
    <div class="incident-card-footer"><span>${escapeHtml(incident.id)} · ${escapeHtml(incident.opened)}</span><span class="incident-assignee">${incident.assignedOfficer ? `Assigned · ${escapeHtml(incident.assignedOfficer)}` : 'Unassigned'}</span></div>
  </article>`;
}

function mapMarkup() {
  return `<div class="map-stage" role="img" aria-label="Schematic demo map showing Harbour Centre and sample officer positions">
    <div class="map-chip"><span class="map-chip-dot"></span>DEMO SITE · HARBOUR CENTRE</div>
    <svg class="map-svg" viewBox="0 0 850 450" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path class="map-water" d="M0 358 C148 325 202 386 328 367 C438 350 489 310 592 324 C690 338 768 317 850 298 L850 450 L0 450Z" />
      <path class="map-road-major-edge" d="M-30 96 C183 118 266 76 422 111 S688 149 885 104" />
      <path class="map-road-major" d="M-30 96 C183 118 266 76 422 111 S688 149 885 104" />
      <path class="map-road-edge" d="M58 -10 C89 112 75 217 116 331 S151 425 168 470" />
      <path class="map-road" d="M58 -10 C89 112 75 217 116 331 S151 425 168 470" />
      <path class="map-road-edge" d="M665 -10 C635 102 675 213 648 321 S626 411 604 474" />
      <path class="map-road" d="M665 -10 C635 102 675 213 648 321 S626 411 604 474" />
      <path class="map-road-edge" d="M-20 248 C154 230 298 256 430 236 S663 219 876 248" />
      <path class="map-road" d="M-20 248 C154 230 298 256 430 236 S663 219 876 248" />
      <path class="map-road-edge" d="M335 -20 C319 114 366 191 350 290 S345 399 361 465" />
      <path class="map-road" d="M335 -20 C319 114 366 191 350 290 S345 399 361 465" />
      <rect class="map-block" x="181" y="139" width="104" height="68" rx="7" />
      <rect class="map-park" x="439" y="139" width="123" height="67" rx="7" />
      <rect class="map-block" x="455" y="270" width="118" height="50" rx="6" />
      <rect class="map-block" x="190" y="275" width="105" height="51" rx="6" />
      <path class="map-geofence" d="M348 151 L480 147 L510 208 L493 287 L378 293 L334 242Z" />
      <path class="map-route" d="M409 219 L461 185 L478 229 L421 271 L397 242" />
      <text class="map-building-label" x="204" y="177">BAY PLAZA</text>
      <text class="map-building-label" x="463" y="176">PUBLIC GARDEN</text>
      <text class="map-label" x="168" y="228">KING STREET</text>
      <text class="map-label" x="387" y="124">WELLINGTON STREET</text>
      <text class="map-label" x="489" y="310">FRONT STREET</text>
      <text class="map-label" x="30" y="402">LAKE ONTARIO</text>
    </svg>
    <div class="map-site-pin">⌖</div><div class="map-site-label">HARBOUR CENTRE</div>
    <div class="map-pin pin-maya"><span class="map-pin-bubble"><span>MC</span></span><span class="map-pin-label">Maya Chen <em>· On post</em></span></div>
    <div class="map-pin available pin-jordan"><span class="map-pin-bubble"><span>JL</span></span><span class="map-pin-label">Jordan Lee <em>· Available</em></span></div>
    <div class="map-pin alert pin-alert"><span class="map-pin-bubble"><span>!</span></span></div>
    <div class="map-control-stack"><button class="map-control" aria-label="Zoom in" data-action="map-zoom">+</button><button class="map-control" aria-label="Zoom out" data-action="map-zoom">−</button></div>
  </div>
  <div class="map-legend"><span class="legend-item"><i class="legend-dot"></i>On post</span><span class="legend-item"><i class="legend-dot green"></i>Available</span><span class="legend-item"><i class="legend-dot red"></i>Incident</span><span class="legend-item"><i class="legend-line"></i>Patrol route</span><span class="schematic-note">Schematic demo map · Not live GPS</span></div>`;
}

function widthClass(value) {
  const numeric = Number(value);
  const bounded = Number.isFinite(numeric) ? Math.max(0, Math.min(numeric, 100)) : 0;
  return 'width-' + Math.round(bounded / 5) * 5;
}

function batteryMarkup(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '<span class="battery-unavailable">—</span>';
  const battery = Math.max(0, Math.min(100, numeric));
  const style = battery < 35 ? 'mid' : '';
  return '<span class="battery"><span class="battery-icon"><i class="battery-fill ' + style + ' ' + widthClass(Math.max(10, battery)) + '"></i></span>' + battery + '%</span>';
}
function rosterTable(officers, compact = false) {
  const rows = officers.map((officer) => {
    const statusClass = officer.status === 'Available' ? 'off-post' : '';
    return `<tr>
      <td><div class="officer-cell"><span class="officer-initials">${escapeHtml(officer.initials)}</span><span class="officer-name">${escapeHtml(officer.name)}<small>${escapeHtml(officer.id)} · ${escapeHtml(officer.role)}</small></span></div></td>
      <td><span class="presence ${statusClass}"><i class="presence-dot"></i>${escapeHtml(officer.status)}</span></td>
      <td>${escapeHtml(officer.site)}</td>
      <td>${escapeHtml(officer.post)}</td>
      <td>${batteryMarkup(officer.battery)}</td>
      <td>${escapeHtml(officer.ping)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>OFFICER</th><th>STATUS</th><th>SITE</th><th>ASSIGNMENT</th><th>BATTERY</th><th>LAST UPDATE</th></tr></thead><tbody>${rows || `<tr><td class="muted-empty" colspan="6">No officer records.</td></tr>`}</tbody></table></div>`;
}

function timelineMarkup() {
  return `<div class="timeline">${state.activity.slice(0, 5).map((item) => `<div class="timeline-item"><span class="timeline-marker">${escapeHtml(item.icon)}</span><div class="timeline-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div><time class="timeline-time">${escapeHtml(item.time)}</time></div>`).join('')}</div>`;
}

function renderDashboard() {
  if (currentUser?.role === 'guard') return renderGuardDashboard();
  const incidents = state.incidents.filter((incident) => incident.status !== 'resolved').slice(0, 4);
  const open = openCount();
  const onDuty = state.officers.filter((officer) => officer.status !== 'Off duty').length;
  const exceptions = state.tours.filter((tour) => tour.status === 'exception').length;
  const siteName = state.sites[0]?.name || 'No sites configured';
  const today = new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  return `${pageHeading(today, 'Operations overview', 'Current records from your authenticated operations workspace.', `<button class="site-select" data-action="show-info"><span class="pin">⌖</span> ${escapeHtml(siteName)}</button>${newDispatchButton()}`)}
    <section class="metrics-grid" aria-label="Operations summary">
      <article class="metric-card"><div class="metric-head"><span>OFFICER ROSTER</span><span class="metric-icon green">♙</span></div><div class="metric-value-row"><strong class="metric-value">${onDuty}</strong></div><div class="metric-foot"><b>Database records</b> · device presence is not live</div></article>
      <article class="metric-card"><div class="metric-head"><span>OPEN INCIDENTS</span><span class="metric-icon red">!</span></div><div class="metric-value-row"><strong class="metric-value">${open}</strong><span class="metric-trend warn">${open ? 'Needs review' : 'All clear'}</span></div><div class="metric-foot"><b>${state.incidents.filter((incident) => incident.severity === 'critical' && incident.status !== 'resolved').length} critical</b> · ${state.incidents.filter((incident) => incident.status === 'assigned').length} assigned</div></article>
      <article class="metric-card"><div class="metric-head"><span>PATROL EXCEPTIONS</span><span class="metric-icon amber">◷</span></div><div class="metric-value-row"><strong class="metric-value">${exceptions}</strong></div><div class="metric-foot">Tour records saved on the server</div></article>
      <article class="metric-card"><div class="metric-head"><span>SHIFT COVERAGE</span><span class="metric-icon blue">▧</span></div><div class="metric-value-row"><strong class="metric-value">—</strong></div><div class="metric-foot">Shift planning is not configured</div></article>
    </section>
    <section class="dashboard-grid">
      <article class="panel"><header class="panel-header"><div class="panel-title"><span class="panel-title-icon">⌖</span> Site plan preview <small>· NO LIVE POSITIONS</small></div><button class="panel-link" data-view="officers">View roster <span>→</span></button></header><div class="panel-body">${mapMarkup()}</div></article>
      <article class="panel"><header class="panel-header"><div class="panel-title"><span class="panel-title-icon">◉</span> Incident queue <small>· ${open} OPEN</small></div><button class="panel-link" data-view="incidents">View all <span>→</span></button></header><div class="incident-list">${incidents.length ? incidents.map(incidentRow).join('') : '<div class="incident-empty">No open incidents.</div>'}</div></article>
    </section>
    <section class="lower-grid">
      <article class="panel"><header class="panel-header"><div class="panel-title"><span class="panel-title-icon">♙</span> Officer roster <small>· DATABASE RECORDS</small></div><button class="panel-link" data-view="officers">Full roster <span>→</span></button></header>${rosterTable(state.officers.slice(0, 4), true)}</article>
      <article class="panel"><header class="panel-header"><div class="panel-title"><span class="panel-title-icon">⌁</span> Activity feed <small>· AUDIT EVENTS</small></div><span class="status-chip resolved">DATABASE</span></header><div class="panel-body">${timelineMarkup()}</div></article>
    </section>`;
}

function renderGuardDashboard() {
  const officer = state.officers[0];
  const site = state.sites[0];
  const activeTours = (state.tours || []).filter((tour) => tour.status !== 'completed');
  const openIncidents = state.incidents.filter((incident) => incident.status !== 'resolved');
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const tourCards = activeTours.length ? activeTours.map((tour) => `<article class="guard-task-card"><div><strong>${escapeHtml(tour.name)}</strong><p>${escapeHtml(tour.site)} · ${escapeHtml(tour.window)}</p></div><span class="status-chip assigned">${tour.status === 'exception' ? 'CHECK REQUIRED' : 'ON SHIFT'}</span><p class="guard-checkpoints">${escapeHtml(tour.checkpoints.join('  ·  ') || 'No checkpoints listed')}</p></article>`).join('') : '<div class="muted-empty">No active patrol tours are assigned.</div>';
  return `${pageHeading(today, 'Guard duty', 'Your post, assigned patrols, and incidents for this shift.', `<button class="secondary-btn" type="button" data-view="sites">View post details <span>→</span></button>${newDispatchButton()}`)}
    <section class="guard-welcome panel"><div><span class="page-eyebrow">SIGNED IN AS FIELD PERSONNEL</span><h2>${escapeHtml(officer?.name || currentUser.name)}</h2><p>${escapeHtml(officer?.role || 'Security guard')} · ${escapeHtml(site?.name || officer?.site || 'No post linked')}</p></div><div class="guard-status"><span class="service-dot"></span><strong>${escapeHtml(officer?.status || 'Account active')}</strong><small>Roster status</small></div></section>
    <section class="metrics-grid guard-metrics"><article class="metric-card"><div class="metric-head"><span>MY ASSIGNED INCIDENTS</span><span class="metric-icon red">!</span></div><div class="metric-value-row"><strong class="metric-value">${openIncidents.length}</strong></div><div class="metric-foot">Only incidents assigned to your officer account</div></article><article class="metric-card"><div class="metric-head"><span>MY PATROL TOURS</span><span class="metric-icon blue">◎</span></div><div class="metric-value-row"><strong class="metric-value">${state.tours.length}</strong></div><div class="metric-foot">Assigned tour records for this account</div></article><article class="metric-card"><div class="metric-head"><span>MY POST</span><span class="metric-icon green">⌖</span></div><div class="metric-value-row"><strong class="metric-value guard-metric-name">${escapeHtml(site?.name || 'Not linked')}</strong></div><div class="metric-foot">Contact your supervisor if your post is incorrect</div></article><article class="metric-card"><div class="metric-head"><span>QUICK ACCESS</span><span class="metric-icon amber">↗</span></div><div class="guard-shortcuts"><button class="panel-link" data-view="incidents">Incidents →</button><button class="panel-link" data-view="patrols">My patrols →</button></div></article></section>
    <section class="dashboard-grid"><article class="panel"><header class="panel-header"><div class="panel-title">My patrols <small>· ASSIGNED TOUR RECORDS</small></div><button class="panel-link" data-view="patrols">View all <span>→</span></button></header><div class="panel-body guard-tasks">${tourCards}</div></article><article class="panel"><header class="panel-header"><div class="panel-title">My incidents <small>· ASSIGNED TO YOU</small></div><button class="panel-link" data-view="incidents">View all <span>→</span></button></header><div class="incident-list">${openIncidents.length ? openIncidents.slice(0, 5).map(incidentRow).join('') : '<div class="incident-empty">No active incidents are assigned to you.</div>'}</div></article></section>
    <div class="connection-banner"><span>i</span><div><strong>Report incidents from your current post</strong>Use Report incident to submit a report. It is saved for your operations team; this prototype does not send an emergency alert or dispatch notification.</div></div>`;
}
function renderIncidents() {
  const filters = ['All', 'Open', 'Assigned', 'Resolved'];
  const incidents = state.incidents.filter((incident) => state.incidentFilter === 'All' || incident.status === state.incidentFilter.toLowerCase());
  const guard = currentUser?.role === 'guard';
  return `${pageHeading(guard ? 'FIELD REPORTS' : 'RESPONSE WORKFLOW', guard ? 'My incidents' : 'Incident management', guard ? 'Review incidents assigned to your guard account and submit a new report.' : 'Create, assign, and close incident records.', guard ? newDispatchButton() : `<button class="secondary-btn" data-action="show-info">Export view <span>↗</span></button>${newDispatchButton()}`)}
    <div class="view-toolbar"><div class="filter-row">${filters.map((filter) => `<button class="filter-chip ${state.incidentFilter === filter ? 'active' : ''}" data-action="incident-filter" data-filter="${filter}">${filter}${filter === 'Open' ? ` (${openCount()})` : ''}</button>`).join('')}</div><span class="form-hint">${guard ? 'Reports you submit are assigned to your guard account.' : 'Changes are recorded on the server with an audit event.'}</span></div>
    <section class="full-incident-grid">${incidents.length ? incidents.map(incidentCard).join('') : '<div class="panel muted-empty">No incidents match this filter.</div>'}</section>`;
}

function renderPatrols() {
  const tours = state.tours || [];
  const exceptions = tours.filter((tour) => tour.status === 'exception').length;
  const checkpointCount = tours.reduce((sum, tour) => sum + tour.total, 0);
  const completedCount = tours.reduce((sum, tour) => sum + tour.complete, 0);
  return `${pageHeading('TOUR COMPLIANCE', 'Patrols & tours', 'Tour records load from the operations service. Checkpoint activity is not connected to field devices.', `<button class="secondary-btn" data-action="show-info">Tour templates</button><button class="primary-btn" data-action="show-info"><span class="button-plus">＋</span> Create tour</button>`)}
    <section class="metrics-grid">
      <article class="metric-card"><div class="metric-head"><span>TOUR RECORDS</span><span class="metric-icon green">◎</span></div><div class="metric-value-row"><strong class="metric-value">${tours.length}</strong></div><div class="metric-foot">Saved in the operations workspace</div></article>
      <article class="metric-card"><div class="metric-head"><span>CHECKPOINTS</span><span class="metric-icon blue">✓</span></div><div class="metric-value-row"><strong class="metric-value">${completedCount}</strong><span class="metric-trend">of ${checkpointCount}</span></div><div class="metric-foot">Seed/demo counts until device sync is added</div></article>
      <article class="metric-card"><div class="metric-head"><span>TOUR EXCEPTIONS</span><span class="metric-icon amber">!</span></div><div class="metric-value-row"><strong class="metric-value">${exceptions}</strong></div><div class="metric-foot">Requires real patrol event integration</div></article>
      <article class="metric-card"><div class="metric-head"><span>LIVE CHECK-INS</span><span class="metric-icon red">↗</span></div><div class="metric-value-row"><strong class="metric-value">—</strong></div><div class="metric-foot">No officer device is connected</div></article>
    </section>
    <div class="view-toolbar"><div class="filter-row"><button class="filter-chip active">All tours</button></div><span class="form-hint">Sample tours remain illustrative until replaced with verified schedules.</span></div>
    <section class="patrol-list">${tours.length ? tours.map((tour) => `<article class="patrol-card"><div class="patrol-card-head"><div><div class="patrol-name">${escapeHtml(tour.name)}</div><div class="patrol-site">${escapeHtml(tour.site)} · Assigned to ${escapeHtml(tour.officer)}</div></div><span class="status-chip ${tour.status === 'exception' ? '' : 'assigned'}"><span class="status-dot"></span>${tour.status === 'exception' ? 'EXCEPTION' : tour.status === 'completed' ? 'COMPLETE' : 'IN PROGRESS'}</span></div><div class="patrol-stats"><span class="patrol-stat"><strong>${escapeHtml(tour.window)}</strong><small>TOUR WINDOW</small></span><span class="patrol-stat"><strong>${tour.complete} / ${tour.total}</strong><small>CHECKPOINTS</small></span><span class="patrol-stat"><strong>${tour.total ? Math.round(tour.complete / tour.total * 100) : 0}%</strong><small>COMPLETE</small></span></div><div class="progress-track"><div class="progress-fill ${widthClass(tour.total ? tour.complete / tour.total * 100 : 0)}"></div></div><div class="tour-checkpoints">${tour.checkpoints.map((point, pointIndex) => `<span class="tour-checkpoint ${pointIndex < tour.complete ? 'done' : tour.status === 'exception' && pointIndex === tour.complete ? 'missed' : ''}"><i class="tour-point-dot"></i>${escapeHtml(point)}</span>`).join('')}</div></article>`).join('') : '<div class="panel muted-empty">No patrol tours configured.</div>'}</section>`;
}
function renderOfficers() {
  const onDuty = state.officers.filter((officer) => officer.status !== 'Off duty').length;
  const available = state.officers.filter((officer) => officer.status === 'Available').length;
  return `${pageHeading('FIELD PERSONNEL', 'Officer roster', 'Officer records are stored securely. Device presence is not connected.', `<button class="secondary-btn" data-action="show-info">Qualifications</button><button class="primary-btn" data-action="show-info"><span class="button-plus">＋</span> Add officer</button>`)}
    <section class="metrics-grid">
      <article class="metric-card"><div class="metric-head"><span>ROSTERED OFFICERS</span><span class="metric-icon green">♙</span></div><div class="metric-value-row"><strong class="metric-value">${onDuty}</strong></div><div class="metric-foot">Database roster count</div></article>
      <article class="metric-card"><div class="metric-head"><span>AVAILABLE</span><span class="metric-icon blue">◌</span></div><div class="metric-value-row"><strong class="metric-value">${available}</strong></div><div class="metric-foot">Status saved securely</div></article>
      <article class="metric-card"><div class="metric-head"><span>DEVICE CHECK-IN</span><span class="metric-icon green">⌁</span></div><div class="metric-value-row"><strong class="metric-value">—</strong></div><div class="metric-foot">No officer devices are reporting</div></article>
      <article class="metric-card"><div class="metric-head"><span>LICENSES</span><span class="metric-icon amber">▤</span></div><div class="metric-value-row"><strong class="metric-value">—</strong></div><div class="metric-foot">Qualification records are not configured</div></article>
    </section>
    <article class="panel"><header class="panel-header"><div class="panel-title">Officer records <small>· SECURE SERVICE</small></div></header>${rosterTable(state.officers)}</article>
    <div class="connection-banner"><span>i</span><div><strong>No live presence feed</strong>Last-seen times and battery values are database fields; they do not update from a device until an authenticated mobile sync service is connected.</div></div>`;
}

function renderSites() {
  const siteCards = state.sites.map((site) => {
    const assigned = state.officers.filter((officer) => officer.site === site.name);
    return `<section class="site-detail">
      <article class="site-hero"><span class="page-eyebrow">CLIENT SITE · ${escapeHtml(site.status)}</span><h2>${escapeHtml(site.name)}</h2><p>${escapeHtml([site.address, site.city, site.region, site.site_type].filter(Boolean).join(' · '))}</p><div class="site-detail-grid"><div class="site-detail-stat"><strong>${assigned.length}</strong><small>OFFICER RECORDS</small></div><div class="site-detail-stat"><strong>${escapeHtml(site.contract_window || 'Not configured')}</strong><small>CONTRACT WINDOW</small></div><div class="site-detail-stat"><strong>${site.geofence_m} m</strong><small>DATABASE FENCE VALUE</small></div></div></article>
      <article class="panel"><header class="panel-header"><div class="panel-title">Site overview</div></header><div class="panel-body"><div class="site-info-list"><div class="site-info-row"><span>Client account</span><strong>${escapeHtml(site.client_name || 'Not configured')}</strong></div><div class="site-info-row"><span>Primary contact</span><strong>${escapeHtml([site.contact_name, site.contact_phone].filter(Boolean).join(' · ') || 'Not configured')}</strong></div><div class="site-info-row"><span>Operating region</span><strong>${escapeHtml([site.city, site.region].filter(Boolean).join(' · '))}</strong></div><div class="site-info-row"><span>Site status</span><strong>${escapeHtml(site.status)}</strong></div></div></div></article>
      <article class="panel"><header class="panel-header"><div class="panel-title">Assigned officers</div></header>${rosterTable(assigned)}</article>
    </section>`;
  }).join('');
  const firstSite = state.sites[0]?.name || 'No site selected';
  return `${pageHeading('SITE DIRECTORY', 'Sites & posts', 'Site records load from the operations service. Map geometry remains a non-operational schematic.', `<span class="site-select"><span class="pin">⌖</span> ${escapeHtml(firstSite)}</span>`)}
    ${siteCards || '<div class="panel muted-empty">No sites are configured for this workspace.</div>'}
    <article class="panel site-map-panel"><header class="panel-header"><div class="panel-title">Schematic map preview <small>· NOT A LIVE MAP</small></div></header><div class="panel-body">${mapMarkup()}<div class="connection-banner"><span>i</span><div><strong>Map integration is not configured</strong>Replace this illustration with a verified site plan and authorized location service before operational use.</div></div></div></article>`;
}
function renderReports() {
  const open = openCount();
  const resolved = state.incidents.filter((incident) => incident.status === 'resolved').length;
  const assigned = state.incidents.filter((incident) => incident.status === 'assigned').length;
  const total = state.incidents.length;
  const openPercent = total ? Math.round(open / total * 100) : 0;
  const assignedPercent = total ? Math.round(assigned / total * 100) : 0;
  const resolvedPercent = total ? Math.round(resolved / total * 100) : 0;
  return `${pageHeading('OPERATIONAL INSIGHTS', 'Reports & performance', 'Incident counts use workspace records. Historical KPIs are not configured.', `<button class="secondary-btn" data-action="show-info">Reporting status <span>↗</span></button>`)}
    <section class="metrics-grid">
      <article class="metric-card"><div class="metric-head"><span>OPEN INCIDENTS</span><span class="metric-icon red">!</span></div><div class="metric-value-row"><strong class="metric-value">${open}</strong></div><div class="metric-foot">Current database records</div></article>
      <article class="metric-card"><div class="metric-head"><span>ASSIGNED INCIDENTS</span><span class="metric-icon blue">↗</span></div><div class="metric-value-row"><strong class="metric-value">${assigned}</strong></div><div class="metric-foot">Current database records</div></article>
      <article class="metric-card"><div class="metric-head"><span>RESOLVED INCIDENTS</span><span class="metric-icon green">✓</span></div><div class="metric-value-row"><strong class="metric-value">${resolved}</strong></div><div class="metric-foot">Loaded incident history</div></article>
      <article class="metric-card"><div class="metric-head"><span>RESPONSE TIME</span><span class="metric-icon amber">◷</span></div><div class="metric-value-row"><strong class="metric-value">—</strong></div><div class="metric-foot">Not calculated yet</div></article>
    </section>
    <section class="report-grid"><article class="panel chart-panel"><div class="chart-title">Operational reporting is not enabled</div><div class="chart-subtitle">This dashboard does not yet calculate shifts, patrol completion, response-time trends, or client SLAs from verified records.</div><div class="connection-banner"><span>i</span><div><strong>Connect verified operational workflows</strong>Configure shift, patrol event, and SLA records before publishing performance reports.</div></div></article><article class="panel chart-panel"><div class="chart-title">Incident status</div><div class="sla-row"><span>Open</span><div class="sla-track"><div class="sla-fill amber ${widthClass(openPercent)}"></div></div><span class="sla-value">${open}</span></div><div class="sla-row"><span>Assigned</span><div class="sla-track"><div class="sla-fill blue ${widthClass(assignedPercent)}"></div></div><span class="sla-value">${assigned}</span></div><div class="sla-row"><span>Resolved</span><div class="sla-track"><div class="sla-fill ${widthClass(resolvedPercent)}"></div></div><span class="sla-value">${resolved}</span></div></article></section>`;
}
function render() {
  const renderers = {
    dashboard: renderDashboard,
    incidents: renderIncidents,
    patrols: renderPatrols,
    officers: renderOfficers,
    sites: renderSites,
    reports: renderReports,
  };
  pageContent.innerHTML = (renderers[currentView] || renderDashboard)();
  const crumb = document.getElementById('breadcrumbTitle');
  crumb.textContent = viewTitles[currentView] || viewTitles.dashboard;
  document.getElementById('incidentNavCount').textContent = String(openCount());
  document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === currentView);
    button.setAttribute('aria-current', button.dataset.view === currentView ? 'page' : 'false');
  });
  document.querySelectorAll('[data-management-only]').forEach((node) => { node.hidden = currentUser?.role === 'guard'; });
  document.querySelectorAll('[data-admin-only]').forEach((node) => { node.hidden = currentUser?.role !== 'admin'; });
  document.querySelectorAll('[data-demo-only]').forEach((node) => { node.hidden = !state.demoDataControls; });
}

function switchView(view) {
  if (!viewTitles[view]) return;
  if (currentUser?.role === 'guard' && ['officers', 'reports'].includes(view)) return;
  currentView = view;
  closeAccountMenus();
  document.querySelector('.sidebar').classList.remove('mobile-open');
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openModal(content) {
  modalCard.innerHTML = content;
  modalLayer.hidden = false;
  document.body.classList.add('modal-open');
  const focusable = modalCard.querySelector('input, select, textarea, button');
  if (focusable) setTimeout(() => focusable.focus(), 20);
}

function closeModal() {
  modalLayer.hidden = true;
  modalCard.innerHTML = '';
  document.body.classList.remove('modal-open');
}

function openDispatchModal() {
  if (!state.sites.length) {
    showToast('Add an active site before creating a dispatch.');
    return;
  }
  const siteOptions = state.sites.map((site) =>
    '<option value="' + escapeHtml(site.id) + '">' + escapeHtml(site.name) + '</option>',
  ).join('');
  const guard = currentUser?.role === 'guard';
  openModal('<div class="modal-head"><div><h2 id="modalTitle">' + (guard ? 'Report an incident' : 'Create dispatch ticket') + '</h2><p>' + (guard ? 'Submit a report from your linked post for the operations team.' : 'Save a new incident to the secure operations workspace.') + '</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<form id="dispatchForm">' +
      '<div class="form-field"><label for="dispatchType">INCIDENT TYPE</label><select id="dispatchType" name="type" required><option>Alarm response</option><option>Medical emergency</option><option>Noise complaint</option><option>Access control</option><option>Suspicious person</option><option>Property damage</option></select></div>' +
      '<div class="form-field"><label for="dispatchPriority">PRIORITY</label><select id="dispatchPriority" name="severity"><option value="high">High</option><option value="critical">Critical</option><option value="medium">Medium</option><option value="low">Low</option></select></div>' +
      '<div class="form-field"><label for="dispatchSite">SITE</label><select id="dispatchSite" name="siteId" required>' + siteOptions + '</select></div>' +
      '<div class="form-field"><label for="dispatchLocation">LOCATION</label><input id="dispatchLocation" name="location" required maxlength="90" placeholder="e.g. Level 4 · North stairwell" /></div>' +
      '<div class="form-field"><label for="dispatchSummary">SUMMARY</label><input id="dispatchSummary" name="title" required maxlength="100" placeholder="Briefly describe the incident" /></div>' +
      '<div class="form-field"><label for="dispatchDetails">DISPATCH NOTES</label><textarea id="dispatchDetails" name="description" maxlength="800" placeholder="Add relevant response notes"></textarea></div>' +
      '<div class="form-hint">' + (guard ? 'This saves a report for your operations team. It does not send an emergency alert.' : 'This saves an incident record. It does not alert a guard device.') + '</div>' +
      '<div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">' + (guard ? 'Submit report' : 'Save incident') + '</button></div>' +
    '</form>');
}

function openIncidentModal(id) {
  const incident = state.incidents.find((item) => item.id === id);
  if (!incident) return;
  const actionButtons = currentUser?.role === 'guard' ? '' : incident.status === 'resolved'
    ? '<span class="status-chip resolved"><span class="status-dot"></span>RESOLVED</span>'
    : '<button class="secondary-btn" type="button" data-action="resolve-incident" data-id="' + escapeHtml(id) + '">Mark resolved</button>' +
      (incident.assignedOfficer ? '' : '<button class="primary-btn" type="button" data-action="assign-incident" data-id="' + escapeHtml(id) + '">Assign available officer</button>');
  openModal(`<div class="modal-head"><div><div class="incident-type"><span class="severity-bar ${escapeHtml(incident.severity)}" ></span>${severityLabel(incident.severity)} · ${escapeHtml(incident.type)}</div><h2 id="modalTitle" class="incident-modal-title">${escapeHtml(incident.title)}</h2><p>${escapeHtml(incident.id)} · ${escapeHtml(incident.opened)}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>
    <div class="detail-block"><small>STATUS & ASSIGNMENT</small><p>${statusChip(incident.status)}${incident.assignedOfficer ? ' <span class="incident-assignee">' + escapeHtml(incident.assignedOfficer) + '</span>' : ' <span class="form-hint">No officer assigned</span>'}</p></div>
    <div class="detail-block"><small>SITE & LOCATION</small><p>${escapeHtml(incident.site)}<br />${escapeHtml(incident.location)}</p></div>
    <div class="detail-block"><small>REPORT SUMMARY</small><p>${escapeHtml(incident.description)}</p></div>
    <div class="connection-banner"><span>i</span><div><strong>Saved record</strong>The action is audited. No officer device or monitoring service is connected.</div></div>
    <div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Close</button>${actionButtons}</div>`);
}

function showInfoModal() {
  const demoControls = state.demoDataControls
    ? '<div class="demo-controls"><div><h3>Fictional demo data</h3><p>Load sample sites, officers, patrols, incidents, and activity, or remove only records marked as demo.</p></div><div class="demo-actions"><button class="secondary-btn" type="button" data-action="load-demo">＋ Add demo data</button><button class="danger-btn" type="button" data-action="confirm-remove-demo">Remove demo data</button></div></div>'
    : '';
  openModal('<div class="modal-head"><div><h2 id="modalTitle">Workspace connection</h2><p>Authenticated operations workspace</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<div class="detail-block"><small>WORKSPACE</small><p>Incidents, roster, sites, patrol summaries, and audit events load from your secure operations workspace.</p></div>' +
    '<div class="detail-block"><small>DISPATCH</small><p>Creating, assigning, and resolving an incident changes a database record. No officer device, paging, SMS, email, or monitoring center is notified.</p></div>' +
    '<div class="detail-block"><small>NOT CONNECTED</small><p>Live GPS, mobile sync, site geofences, shift planning, qualifications, and verified performance reporting still require separate production workflows.</p></div>' +
    demoControls +
    '<div class="modal-actions"><button class="primary-btn" type="button" data-action="close-modal">Got it</button></div>');
}

function showDemoDataModal() {
  closeAccountMenus();
  if (!state.demoDataControls) {
    showToast('Demo data controls are available to the Northstar administrator in development only.');
    return;
  }
  openModal('<div class="modal-head"><div><h2 id="modalTitle">Manage demo data</h2><p>Development-only fictional records for a Northstar administrator.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<div class="detail-block"><small>DEMO RECORDS</small><p>Add fictional sites, guards, patrols, incidents, and activity to explore the interface. Remove only records explicitly tagged as demo.</p></div>' +
    '<div class="modal-actions demo-actions"><button class="secondary-btn" type="button" data-action="load-demo">＋ Add demo data</button><button class="danger-btn" type="button" data-action="confirm-remove-demo">Remove demo data</button><button class="secondary-btn" type="button" data-action="close-modal">Done</button></div>');
}

function showLogoutConfirmation() {
  closeAccountMenus();
  openModal('<div class="modal-head"><div><h2 id="modalTitle">Sign out of Northstar?</h2><p>Your current workspace session will end on this device.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<div class="connection-banner"><span>↪</span><div><strong>Ready to sign out?</strong>You will need to sign in again to view secure operation records.</div></div>' +
    '<div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Stay signed in</button><button class="danger-btn" type="button" data-action="confirm-logout">Sign out</button></div>');
}

async function performLogout(button) {
  if (button) button.disabled = true;
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', body: '{}' });
    showLogin();
  } catch (error) {
    if (error.status === 401) showLogin('Your session has expired. Please sign in again.');
    else {
      showToast(error.message || 'Sign out failed. Check the connection and try again.');
      if (button) button.disabled = false;
    }
  }
}

function showAccountOptionsModal() {
  closeAccountMenus();
  const adminOptions = currentUser?.role === 'admin'
    ? '<button class="secondary-btn" type="button" data-action="open-users">User management</button><button class="secondary-btn" type="button" data-action="open-query">Record query</button><button class="secondary-btn" type="button" data-action="open-db-settings">Connection settings</button>'
    : '';
  const demoOptions = state.demoDataControls
    ? '<button class="secondary-btn" type="button" data-action="show-demo">Manage demo data</button>'
    : '';
  openModal('<div class="modal-head"><div><h2 id="modalTitle">Account options</h2><p>' + escapeHtml(currentUser.name) + ' · ' + escapeHtml(currentUser.email) + '</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<div class="account-options-list"><button class="secondary-btn" type="button" data-action="open-profile">My profile</button>' + adminOptions + demoOptions + '<button class="danger-btn" type="button" data-action="logout">Sign out…</button></div>');
}

function showProfileModal() {
  closeAccountMenus();
  const timezones = ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
  const selectedTimezone = currentUser.timezone || 'America/Toronto';
  if (!timezones.includes(selectedTimezone)) timezones.unshift(selectedTimezone);
  const timezoneOptions = timezones.map((timezone) => '<option value="' + escapeHtml(timezone) + '" ' + (timezone === selectedTimezone ? 'selected' : '') + '>' + escapeHtml(timezone.replaceAll('_', ' ')) + '</option>').join('');
  openModal('<div class="modal-head"><div><h2 id="modalTitle">My profile</h2><p>Manage your contact details, time zone, profile image, and password.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<form id="profileForm"><div class="profile-edit-card"><span class="avatar profile-edit-avatar">' + escapeHtml(String(currentUser.name || currentUser.email).split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()) + '</span><div><strong>' + escapeHtml(currentUser.email) + '</strong><small>' + escapeHtml(currentUser.role) + ' · ' + escapeHtml(currentUser.tenantName) + '</small></div></div>' +
    '<div class="profile-form-grid"><div class="form-field"><label for="profileName">DISPLAY NAME</label><input id="profileName" name="name" required maxlength="100" value="' + escapeHtml(currentUser.name) + '" /></div>' +
    '<div class="form-field"><label for="profilePhone">CONTACT PHONE</label><input id="profilePhone" name="phone" type="tel" autocomplete="tel" maxlength="40" value="' + escapeHtml(currentUser.phone || '') + '" placeholder="Optional" /></div>' +
    '<div class="form-field"><label for="profileTimezone">TIME ZONE</label><select id="profileTimezone" name="timezone">' + timezoneOptions + '</select><span class="form-hint">Used for the live clock in the workspace.</span></div>' +
    '<div class="form-field"><label for="profileImage">PROFILE IMAGE</label><input id="profileImage" name="image" type="file" accept="image/jpeg,image/png,image/webp" /><span class="form-hint">JPEG, PNG, or WebP · 1 MB maximum. SVG files are not accepted.</span></div></div>' +
    '<div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Save profile</button></div></form>' +
    '<form id="passwordForm" class="password-change-form"><h3>Change password</h3><p>Changing your password signs out your other active sessions.</p><div class="profile-form-grid"><div class="form-field"><label for="currentPassword">CURRENT PASSWORD</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" /></div><div class="form-field"><label for="newPassword">NEW PASSWORD</label><input id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="16" required maxlength="1024" /><span class="form-hint">Use at least 16 characters.</span></div><div class="form-field"><label for="confirmPassword">CONFIRM NEW PASSWORD</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="16" required maxlength="1024" /></div></div><div class="modal-actions"><button class="primary-btn" type="submit">Update password</button></div></form>');
  if (currentUser.avatarUrl) {
    const preview = modalCard.querySelector('.profile-edit-avatar');
    preview.style.backgroundImage = 'url("' + currentUser.avatarUrl + '?v=' + encodeURIComponent(currentUser.id) + '")';
  }
}

function readImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('The selected image could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function saveProfile(form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form).entries());
    const result = await apiRequest('/api/profile', { method: 'PATCH', body: JSON.stringify({ name: values.name, phone: values.phone, timezone: values.timezone }) });
    const image = form.elements.image.files[0];
    if (image) {
      if (image.size > 1_048_576) throw new Error('Profile images must be 1 MB or smaller.');
      const dataUrl = await readImageDataUrl(image);
      await apiRequest('/api/profile/avatar', { method: 'POST', body: JSON.stringify({ dataUrl }) });
      currentUser.avatarUrl = '/api/profile/avatar/' + currentUser.id;
    }
    currentUser.name = result.name;
    currentUser.phone = result.phone;
    currentUser.timezone = result.timezone;
    displayUser(currentUser);
    closeModal();
    showToast('Profile saved.');
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

async function savePassword(form) {
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form).entries());
  if (values.newPassword !== values.confirmPassword) {
    showToast('The new passwords do not match.');
    return;
  }
  button.disabled = true;
  try {
    await apiRequest('/api/profile/password', { method: 'POST', body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) });
    form.reset();
    showToast('Password updated. Other sessions have been signed out.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function showUserManagementModal() {
  closeAccountMenus();
  try {
    const [accountData, workspace] = await Promise.all([apiRequest('/api/admin/users'), apiRequest('/api/state')]);
    const officers = workspace.officers || [];
    const officerOptions = (selected = '') => '<option value="">No officer linked</option>' + officers.map((officer) => '<option value="' + escapeHtml(officer.uuid) + '" ' + (officer.uuid === selected ? 'selected' : '') + '>' + escapeHtml(officer.name + ' · ' + officer.id) + '</option>').join('');
    const roleOptions = (selected) => ['admin', 'dispatcher', 'supervisor', 'viewer', 'guard'].map((role) => '<option value="' + role + '" ' + (role === selected ? 'selected' : '') + '>' + role[0].toUpperCase() + role.slice(1) + '</option>').join('');
    const rows = accountData.users.map((account) => '<form class="user-admin-row" data-user-edit-form data-user-id="' + escapeHtml(account.id) + '"><div class="user-admin-summary"><strong>' + escapeHtml(account.name) + '</strong><small>' + escapeHtml(account.email) + (account.officerName ? ' · ' + escapeHtml(account.officerName) : '') + '</small></div><div class="user-admin-controls"><label>Role<select name="role" ' + (account.id === currentUser.id ? 'disabled' : '') + '>' + roleOptions(account.role) + '</select></label><label>Officer<select name="officerId">' + officerOptions(account.officerId || '') + '</select></label><label class="active-toggle"><input type="checkbox" name="active" ' + (account.active ? 'checked' : '') + ' ' + (account.id === currentUser.id ? 'disabled' : '') + ' /> Active</label><button class="secondary-btn button-small" type="submit" ' + (account.id === currentUser.id ? 'disabled' : '') + '>Save</button></div></form>').join('');
    openModal('<div class="modal-head"><div><h2 id="modalTitle">User management</h2><p>Create workspace accounts and assign least privilege. Guard accounts require a linked officer.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
      '<section class="admin-user-list"><h3>Workspace accounts</h3>' + (rows || '<div class="muted-empty">No accounts found.</div>') + '</section>' +
      '<form id="createUserForm" class="admin-create-user"><h3>Add an account</h3><div class="admin-form-grid"><div class="form-field"><label for="newUserName">FULL NAME</label><input id="newUserName" name="name" required maxlength="100" /></div><div class="form-field"><label for="newUserEmail">EMAIL</label><input id="newUserEmail" name="email" type="email" required maxlength="254" /></div><div class="form-field"><label for="newUserRole">ROLE</label><select id="newUserRole" name="role">' + roleOptions('guard') + '</select></div><div class="form-field"><label for="newUserOfficer">LINKED OFFICER</label><select id="newUserOfficer" name="officerId">' + officerOptions() + '</select></div><div class="form-field admin-password-field"><label for="newUserPassword">TEMPORARY PASSWORD</label><input id="newUserPassword" name="password" type="password" minlength="16" maxlength="1024" autocomplete="new-password" required /><span class="form-hint">At least 16 characters; give it to the user securely.</span></div></div><div class="modal-actions"><button class="primary-btn" type="submit">Create account</button></div></form>' +
      '<div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Done</button></div>');
  } catch (error) {
    closeModal();
    showToast(error.message);
  }
}

async function saveUserAccount(form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    const body = { role: values.role, active: form.elements.active.checked, officerId: values.officerId || null };
    await apiRequest('/api/admin/users/' + encodeURIComponent(form.dataset.userId), { method: 'PATCH', body: JSON.stringify(body) });
    showToast('Account updated.');
    await showUserManagementModal();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

async function createUserAccount(form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    await apiRequest('/api/admin/users', { method: 'POST', body: JSON.stringify({ ...values, officerId: values.officerId || null }) });
    showToast('Account created.');
    await showUserManagementModal();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

async function showAdminQueryModal() {
  closeAccountMenus();
  openModal('<div class="modal-head"><div><h2 id="modalTitle">Record query</h2><p>Admin-only read access. Choose a record set and search fields approved for this workspace.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<form id="adminQueryForm"><div class="admin-form-grid"><div class="form-field"><label for="queryDataset">RECORD TYPE</label><select id="queryDataset" name="dataset"><option value="incidents">Incidents</option><option value="officers">Officers</option><option value="sites">Sites</option><option value="patrols">Patrol tours</option><option value="activity">Activity</option></select></div><div class="form-field"><label for="querySearch">SEARCH</label><input id="querySearch" name="search" maxlength="100" placeholder="Code, name, location, or detail" /></div></div><div class="form-hint">Read-only search · maximum 100 rows · account, session, and password data are excluded.</div><div class="modal-actions"><button class="primary-btn" type="submit">Search records</button></div></form><div id="adminQueryResult" class="admin-query-result" aria-live="polite"></div>');
}

async function runAdminQuery(form) {
  const resultNode = document.getElementById('adminQueryResult');
  const values = Object.fromEntries(new FormData(form).entries());
  resultNode.textContent = 'Searching…';
  try {
    const result = await apiRequest('/api/admin/query', { method: 'POST', body: JSON.stringify(values) });
    const table = '<div class="table-scroll"><table class="data-table"><thead><tr>' + result.columns.map((column) => '<th>' + escapeHtml(column) + '</th>').join('') + '</tr></thead><tbody>' + result.rows.map((row) => '<tr>' + result.columns.map((column) => '<td>' + escapeHtml(row[column] instanceof Object ? JSON.stringify(row[column]) : row[column] ?? '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
    resultNode.innerHTML = (result.rows.length ? table : '<p class="muted-empty">No matching records.</p>') + (result.limited ? '<p class="form-hint">Showing the first 100 records. Narrow the search to view fewer results.</p>' : '');
  } catch (error) {
    resultNode.textContent = error.message;
  }
}

async function showDatabaseSettingsModal() {
  closeAccountMenus();
  try {
    const status = await apiRequest('/api/admin/database/status');
    openModal('<div class="modal-head"><div><h2 id="modalTitle">Connection settings</h2><p>Test a candidate server connection before updating the host-managed application settings.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
      '<div class="detail-block"><small>CURRENT SERVER TARGET</small><p>' + escapeHtml(status.database) + ' · ' + escapeHtml(status.host) + ':' + escapeHtml(status.port) + ' · ' + escapeHtml(status.sslMode) + '</p></div>' +
      '<form id="databaseTestForm"><div class="admin-form-grid"><div class="form-field"><label for="candidateHost">DATABASE HOST</label><input id="candidateHost" name="host" required maxlength="253" value="' + escapeHtml(status.host) + '" /></div><div class="form-field"><label for="candidatePort">PORT</label><input id="candidatePort" name="port" type="number" min="1" max="65535" required value="' + escapeHtml(status.port) + '" /></div><div class="form-field"><label for="candidateDatabase">DATABASE</label><input id="candidateDatabase" name="database" required maxlength="128" value="' + escapeHtml(status.database) + '" /></div><div class="form-field"><label for="candidateUsername">USERNAME</label><input id="candidateUsername" name="username" autocomplete="off" required maxlength="128" value="' + escapeHtml(status.username) + '" /></div><div class="form-field"><label for="candidatePassword">PASSWORD</label><input id="candidatePassword" name="password" type="password" autocomplete="new-password" required maxlength="1024" /></div></div><p class="form-hint">Credentials are sent to this server over the current session and used only for this connection test. They are not saved. To apply them, update the server secret configuration and restart the service. New hosts must first be added to DATABASE_ALLOWED_HOSTS.</p><div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Test connection</button></div></form><div id="databaseTestResult" class="admin-query-result" aria-live="polite"></div>');
  } catch (error) {
    closeModal();
    showToast(error.message);
  }
}

async function testDatabaseConnection(form) {
  const resultNode = document.getElementById('databaseTestResult');
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form).entries());
  const candidate = 'postgresql://' + encodeURIComponent(values.username) + ':' + encodeURIComponent(values.password) + '@' + values.host + ':' + values.port + '/' + encodeURIComponent(values.database);
  button.disabled = true;
  resultNode.textContent = 'Testing…';
  try {
    const result = await apiRequest('/api/admin/database/test', { method: 'POST', body: JSON.stringify({ connectionString: candidate }) });
    resultNode.textContent = 'Connected to ' + result.database + ' at ' + result.host + ':' + result.port + '. Settings were tested only and were not applied.';
    form.elements.password.value = '';
  } catch (error) {
    resultNode.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function confirmRemoveDemoData() {
  closeAccountMenus();
  openModal('<div class="modal-head"><div><h2 id="modalTitle">Remove demo data?</h2><p>This will remove fictional sample records from this workspace.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<div class="connection-banner"><span>!</span><div><strong>Only records marked as demo are selected.</strong>If a sample site or officer is linked to an operational record, removal will stop and explain what needs attention.</div></div>' +
    '<form id="removeDemoForm"><label class="demo-confirm-label"><input id="removeDemoConfirm" type="checkbox" required /> I understand this removes all tagged demo records in this workspace.</label>' +
    '<div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Cancel</button><button class="danger-btn" type="submit">Remove demo data</button></div></form>');
}

async function manageDemoData(action, sourceButton = null) {
  closeAccountMenus();
  const button = sourceButton || (action === 'remove-demo'
    ? modalCard.querySelector('#removeDemoForm button[type="submit"]')
    : modalCard.querySelector('[data-action="' + action + '"]'));
  if (button) button.disabled = true;
  try {
    const removing = action === 'remove-demo';
    const result = await apiRequest('/api/demo-data/' + (removing ? 'remove' : 'load'), {
      method: 'POST', body: JSON.stringify({ confirm: removing ? 'REMOVE' : 'LOAD' }),
    });
    closeModal();
    await loadWorkspace();
    const count = Object.values(result.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    showToast(removing ? count + ' demo records removed.' : 'Fictional demo data is ready.');
  } catch (error) {
    showToast(error.message);
    if (button) button.disabled = false;
  }
}

async function createDispatch(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await apiRequest('/api/incidents', { method: 'POST', body: JSON.stringify(values) });
    closeModal();
    await loadWorkspace();
    showToast(result.id + ' saved in the operations workspace.');
  } catch (error) {
    showToast(error.message);
  }
}

async function updateIncident(id, action) {
  try {
    const result = await apiRequest('/api/incidents/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    });
    closeModal();
    await loadWorkspace();
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
}

function assignIncident(id) {
  return updateIncident(id, 'assign');
}

function resolveIncident(id) {
  return updateIncident(id, 'resolve');
}

document.querySelectorAll('[data-font-size]').forEach((button) => {
  button.addEventListener('click', () => setFontSize(button.dataset.fontSize));
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], [data-view]');
  if (!target) return;
  if (target.dataset.view) {
    switchView(target.dataset.view);
    return;
  }
  const { action, id } = target.dataset;
  if (action === 'toggle-theme') toggleTheme();
  else if (action === 'toggle-profile-menu') {
    const menu = document.getElementById('profileMenu');
    const open = menu.hidden;
    closeAccountMenus();
    menu.hidden = !open;
    document.querySelectorAll('[data-action="toggle-profile-menu"]').forEach((button) => button.setAttribute('aria-expanded', String(open)));
  }
  else if (action === 'toggle-quick-nav') {
    const menu = document.getElementById('quickNavMenu');
    const open = menu.hidden;
    closeAccountMenus();
    menu.hidden = !open;
    quickNavOpen = open;
    document.querySelectorAll('[data-action="toggle-quick-nav"]').forEach((button) => button.setAttribute('aria-expanded', String(open)));
  }
  else if (action === 'open-profile') showProfileModal();
  else if (action === 'open-account-options') showAccountOptionsModal();
  else if (action === 'open-users') showUserManagementModal();
  else if (action === 'open-query') showAdminQueryModal();
  else if (action === 'open-db-settings') showDatabaseSettingsModal();
  else if (action === 'new-dispatch') openDispatchModal();
  else if (action === 'open-incident') openIncidentModal(id);
  else if (action === 'close-modal') closeModal();
  else if (action === 'show-info') showInfoModal();
  else if (action === 'show-demo') showDemoDataModal();
  else if (action === 'load-demo') manageDemoData('load-demo', target);
  else if (action === 'confirm-remove-demo') confirmRemoveDemoData();
  else if (action === 'assign-incident') assignIncident(id);
  else if (action === 'resolve-incident') resolveIncident(id);
  else if (action === 'incident-filter') { state.incidentFilter = target.dataset.filter; render(); }
  else if (action === 'toggle-nav') document.querySelector('.sidebar').classList.toggle('mobile-open');
  else if (action === 'map-zoom') showToast('The site plan is a visual preview.');
  else if (action === 'logout') showLogoutConfirmation();
  else if (action === 'confirm-logout') performLogout(target);
});

document.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.profile-menu-wrap, .breadcrumbs')) return;
  closeAccountMenus();
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'loginForm') {
    event.preventDefault();
    const button = loginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    loginMessage.hidden = true;
    const values = Object.fromEntries(new FormData(loginForm).entries());
    try {
      const session = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      loginForm.reset();
      await enterWorkspace(session.user, session.csrfToken);
    } catch (error) {
      loginMessage.textContent = error.message;
      loginMessage.hidden = false;
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (event.target.id === 'dispatchForm') {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    await createDispatch(event.target);
    button.disabled = false;
    return;
  }
  if (event.target.id === 'removeDemoForm') {
    event.preventDefault();
    if (!document.getElementById('removeDemoConfirm')?.checked) return;
    await manageDemoData('remove-demo');
    return;
  }
  if (event.target.id === 'profileForm') {
    event.preventDefault();
    await saveProfile(event.target);
    return;
  }
  if (event.target.id === 'passwordForm') {
    event.preventDefault();
    await savePassword(event.target);
    return;
  }
  if (event.target.id === 'createUserForm') {
    event.preventDefault();
    await createUserAccount(event.target);
    return;
  }
  if (event.target.matches('[data-user-edit-form]')) {
    event.preventDefault();
    await saveUserAccount(event.target);
    return;
  }
  if (event.target.id === 'adminQueryForm') {
    event.preventDefault();
    await runAdminQuery(event.target);
    return;
  }
  if (event.target.id === 'databaseTestForm') {
    event.preventDefault();
    await testDatabaseConnection(event.target);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalLayer.hidden) closeModal();
  if (event.key === 'Escape') closeAccountMenus();
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"][data-action="open-incident"]')) {
    event.preventDefault();
    openIncidentModal(event.target.dataset.id);
  }
});

let savedFontSize = 'medium';
try { savedFontSize = localStorage.getItem('northstar-font-size') || 'medium'; } catch { /* Text sizing preference is optional. */ }
setFontSize(savedFontSize);
updateLiveClock();
setInterval(updateLiveClock, 1000);
initialize();
