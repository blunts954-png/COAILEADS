// ── COAI Lead Engine — app.js ────────────────────────────────────────────────

// ─── OUTREACH CONFIG ─────────────────────────────────────────────────────────
// Edit these values to personalise all outreach templates.
// None of this information is sent to the server — it stays in your browser.
const CONFIG = {
  senderName:      'Jason',
  senderLastName:  'Manuel',         // used in email signature when provided
  companyName:     'Chaotically Organized AI',
  companyUrl:      'chaoticallyorganizedai.com',
  phone:           '(661) 610-9198',
  address:         '1712 19th St #216, Bakersfield CA',
  city:            'Bakersfield',
  // Optional: set to a Calendly / booking URL to embed a direct link in outreach.
  // e.g. 'https://calendly.com/your-link'
  bookingLink: '',
};

// ─── STATE ───────────────────────────────────────────────────────────────────
let allLeads       = [];
let currentFilter  = 'all';
let activeLead     = null;
let msgType        = 'text';
let contacted      = new Set();
let closed         = new Set();
let activeCats     = new Set();
let scannedCatCount = 0;
let failedCats     = [];
let selectedLeads  = new Set();
let retryQueue     = [];       // categories queued for retry
let lastScanParams = null;     // {lat, lng, radius, resultsCount} — used by retry

// ─── UTILITY ─────────────────────────────────────────────────────────────────

// Escape a string for safe insertion into innerHTML (prevents XSS)
function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str == null ? '' : String(str)));
  return d.innerHTML;
}

// Convert a category string to a safe DOM id fragment
function catSlug(cat) {
  return cat.replace(/[^a-z0-9]/gi, '_');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── AUTH STORAGE ─────────────────────────────────────────────────────────────
function getStoredAuth() {
  return localStorage.getItem('coai_auth') || sessionStorage.getItem('coai_auth');
}

// ─── CAT SELECTION ───────────────────────────────────────────────────────────
function updateCatCount() {
  document.getElementById('cat-count').textContent = activeCats.size + ' selected';
}

function toggleCat(btn) {
  const cat = btn.dataset.cat;
  if (activeCats.has(cat)) { activeCats.delete(cat); btn.classList.remove('active'); }
  else                      { activeCats.add(cat);    btn.classList.add('active'); }
  updateCatCount();
}

function toggleVertical(vertical) {
  const btns = document.querySelectorAll(`[data-vertical="${vertical}"]`);
  const allActive = Array.from(btns).every(b => activeCats.has(b.dataset.cat));
  btns.forEach(btn => {
    if (allActive) { activeCats.delete(btn.dataset.cat); btn.classList.remove('active'); }
    else           { activeCats.add(btn.dataset.cat);    btn.classList.add('active'); }
  });
  updateCatCount();
}

function selectAllCats() {
  document.querySelectorAll('.cat-btn').forEach(btn => {
    activeCats.add(btn.dataset.cat);
    btn.classList.add('active');
  });
  updateCatCount();
}

function clearAllCats() {
  document.querySelectorAll('.cat-btn').forEach(btn => {
    activeCats.delete(btn.dataset.cat);
    btn.classList.remove('active');
  });
  updateCatCount();
}

function selectHotOnly() {
  clearAllCats();
  const hot = ['hvac','plumber','electrician','roofing contractor','auto repair','dentist',
               'pest control','landscaping','house cleaning','tattoo shop','hair salon','barber shop'];
  hot.forEach(cat => {
    activeCats.add(cat);
    const btn = document.querySelector(`[data-cat="${CSS.escape(cat)}"]`);
    if (btn) btn.classList.add('active');
  });
  updateCatCount();
}

// ─── SEARCH PRESETS ──────────────────────────────────────────────────────────
function loadPresets() {
  const presets = JSON.parse(localStorage.getItem('coai_presets') || '[]');
  const sel = document.getElementById('preset-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Load preset —</option>';
  presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
}

function savePreset() {
  const nameEl = document.getElementById('preset-name');
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  const presets = JSON.parse(localStorage.getItem('coai_presets') || '[]');
  const preset = {
    name,
    location:     document.getElementById('location').value,
    radius:       document.getElementById('radius').value,
    cats:         Array.from(activeCats),
    minReviews:   document.getElementById('min-reviews').value,
    maxRating:    document.getElementById('max-rating').value,
    resultsCount: document.getElementById('results-count').value,
  };
  const idx = presets.findIndex(p => p.name === name);
  if (idx >= 0) presets[idx] = preset; else presets.push(preset);
  localStorage.setItem('coai_presets', JSON.stringify(presets));
  nameEl.value = '';
  loadPresets();
  document.getElementById('preset-select').value = name;
}

function applyPreset() {
  const name = document.getElementById('preset-select').value;
  if (!name) return;
  const presets = JSON.parse(localStorage.getItem('coai_presets') || '[]');
  const preset = presets.find(p => p.name === name);
  if (!preset) return;
  document.getElementById('location').value       = preset.location;
  document.getElementById('radius').value         = preset.radius;
  document.getElementById('min-reviews').value    = preset.minReviews;
  document.getElementById('max-rating').value     = preset.maxRating;
  document.getElementById('results-count').value  = preset.resultsCount;
  clearAllCats();
  (preset.cats || []).forEach(cat => {
    activeCats.add(cat);
    const btn = document.querySelector(`[data-cat="${CSS.escape(cat)}"]`);
    if (btn) btn.classList.add('active');
  });
  updateCatCount();
}

function deletePreset() {
  const name = document.getElementById('preset-select').value;
  if (!name) return;
  if (!confirm(`Delete preset "${name}"?`)) return;
  const presets = JSON.parse(localStorage.getItem('coai_presets') || '[]');
  localStorage.setItem('coai_presets', JSON.stringify(presets.filter(p => p.name !== name)));
  loadPresets();
}

// ─── PERSIST / RESTORE STATE ─────────────────────────────────────────────────
function persistState() {
  try {
    localStorage.setItem('coai_leads',     JSON.stringify(allLeads));
    localStorage.setItem('coai_contacted', JSON.stringify([...contacted]));
    localStorage.setItem('coai_closed',    JSON.stringify([...closed]));
  } catch (e) {
    console.warn('[COAI] Could not persist state:', e);
  }
}

function restoreState() {
  try {
    const leads     = localStorage.getItem('coai_leads');
    const contacted_ = localStorage.getItem('coai_contacted');
    const closed_   = localStorage.getItem('coai_closed');
    if (leads)      allLeads   = JSON.parse(leads);
    if (contacted_) contacted  = new Set(JSON.parse(contacted_));
    if (closed_)    closed     = new Set(JSON.parse(closed_));
  } catch (e) {
    console.warn('[COAI] Could not restore state:', e);
  }
}

// ─── INIT (called after successful auth) ─────────────────────────────────────
function initApp() {
  restoreState();
  loadPresets();
  if (allLeads.length > 0) {
    scannedCatCount = new Set(allLeads.flatMap(l => l.cats || [l.cat])).size;
    allLeads.sort((a, b) => b.score - a.score);
    renderLeads(allLeads);
    updateStats();
    document.getElementById('stats-row').style.display   = 'grid';
    document.getElementById('filter-row').style.display  = 'flex';
    document.getElementById('sort-row').style.display    = 'flex';
    document.getElementById('export-bar').style.display  = 'flex';
    document.getElementById('select-all-row').style.display = 'flex';
    document.getElementById('empty-state').style.display = 'none';
    updateExportInfo();
  }
}

// ─── FETCH (proxy through /api/search) ───────────────────────────────────────
async function gFetch(googleUrl) {
  const authKey = getStoredAuth();
  if (!authKey) { location.reload(); throw new Error('No auth token.'); }

  const u = new URL(googleUrl);
  const params = new URLSearchParams();

  if (u.pathname.includes('geocode')) {
    params.set('mode', 'geocode');
    params.set('location', u.searchParams.get('address') || '');
  } else {
    const [latStr, lngStr] = (u.searchParams.get('location') || '').split(',');
    params.set('lat',    latStr || '');
    params.set('lng',    lngStr || '');
    params.set('type',   u.searchParams.get('keyword') || '');
    params.set('radius', u.searchParams.get('radius')  || '8000');
    const pt = u.searchParams.get('pagetoken');
    if (pt) params.set('pagetoken', pt);
  }

  const resp = await fetch('/api/search?' + params.toString(), {
    signal:  AbortSignal.timeout(15000),
    headers: { 'Authorization': authKey },
  });

  if (resp.status === 401) {
    localStorage.removeItem('coai_auth');
    sessionStorage.removeItem('coai_auth');
    alert('Access Denied: Session expired or invalid token.');
    location.reload();
    throw new Error('Unauthorized');
  }
  if (resp.status === 429) {
    throw new Error('Rate limit hit. Please wait a minute before scanning again.');
  }
  if (!resp.ok) throw new Error(`API error (status ${resp.status}). Check Vercel logs.`);
  return resp.json();
}

// Fetch Place Details for a given place_id (expand view)
async function fetchDetails(placeId) {
  const authKey = getStoredAuth();
  if (!authKey) throw new Error('No auth token.');
  const resp = await fetch(`/api/search?mode=details&place_id=${encodeURIComponent(placeId)}`, {
    signal:  AbortSignal.timeout(10000),
    headers: { 'Authorization': authKey },
  });
  if (!resp.ok) throw new Error('Details fetch failed.');
  return resp.json();
}

// ─── PAGINATED NEARBY SEARCH ─────────────────────────────────────────────────
async function fetchCategoryLeads(cat, lat, lng, radius, maxResults) {
  let results   = [];
  let pageToken = null;
  let page      = 0;
  const maxPages = maxResults <= 20 ? 1 : maxResults <= 40 ? 2 : 3;

  do {
    let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
      + `?location=${lat},${lng}`
      + `&radius=${radius}`
      + `&keyword=${encodeURIComponent(cat)}`
      + `&key=SERVER_SIDE`;
    if (pageToken) url += `&pagetoken=${encodeURIComponent(pageToken)}`;

    const data = await gFetch(url);

    if (data.status === 'REQUEST_DENIED')
      throw new Error('Places API not enabled or key denied. Check Google Cloud Console.');
    if (data.status === 'OVER_QUERY_LIMIT') { await sleep(2500); break; }
    if (data.status === 'INVALID_REQUEST' && pageToken) break;

    if (data.results && data.results.length > 0) results = results.concat(data.results);
    pageToken = data.next_page_token || null;
    page++;
    if (pageToken && page < maxPages) await sleep(2200);
  } while (pageToken && page < maxPages && results.length < maxResults);

  return results.slice(0, maxResults);
}

// ─── SCAN PROGRESS CHECKLIST ─────────────────────────────────────────────────
function renderProgressChecklist(cats) {
  const el = document.getElementById('scan-checklist');
  if (!el) return;
  el.innerHTML = cats.map(cat =>
    `<span id="prog-${catSlug(cat)}" class="prog-item prog-pending">○ ${esc(cat)}</span>`
  ).join('');
}

function setProgressItem(cat, status) {
  const el = document.getElementById('prog-' + catSlug(cat));
  if (!el) return;
  const icon = status === 'done' ? '✓' : status === 'failed' ? '✗' : status === 'scanning' ? '⟳' : '○';
  el.className = `prog-item prog-${status}`;
  el.textContent = `${icon} ${cat}`;
}

// ─── MAIN SEARCH ─────────────────────────────────────────────────────────────
async function runSearch(catsOverride) {
  const cats = catsOverride ? Array.from(catsOverride) : Array.from(activeCats);
  if (cats.length === 0) { alert('Select at least one industry category.'); return; }

  const location     = document.getElementById('location').value.trim() || 'Bakersfield, CA';
  const radius       = document.getElementById('radius').value;
  const resultsCount = parseInt(document.getElementById('results-count').value);

  document.getElementById('empty-state').style.display  = 'none';
  if (!catsOverride) {
    document.getElementById('leads-container').innerHTML = '';
    allLeads = [];
    scannedCatCount = 0;
    failedCats = [];
    selectedLeads.clear();
  }
  document.getElementById('loading-wrap').style.display  = 'flex';
  document.getElementById('stats-row').style.display     = 'none';
  document.getElementById('filter-row').style.display    = 'none';
  document.getElementById('sort-row').style.display      = 'none';
  document.getElementById('export-bar').style.display    = 'none';
  document.getElementById('select-all-row').style.display = 'none';
  document.getElementById('search-btn').disabled         = true;
  document.getElementById('failed-banner').classList.remove('show');

  renderProgressChecklist(cats);

  try {
    document.getElementById('loading-text').textContent = 'LOCATING TARGET AREA...';
    document.getElementById('loading-sub').textContent  = 'Resolving coordinates for ' + location;

    let lat = 35.3733, lng = -119.0187;
    try {
      const geo = await gFetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=SERVER_SIDE`);
      if (geo.status === 'REQUEST_DENIED') throw new Error('KEY_DENIED');
      if (geo.results && geo.results.length > 0) {
        lat = geo.results[0].geometry.location.lat;
        lng = geo.results[0].geometry.location.lng;
      }
    } catch (geoErr) {
      if (geoErr.message === 'KEY_DENIED') {
        document.getElementById('loading-wrap').style.display = 'none';
        document.getElementById('empty-state').style.display  = 'flex';
        document.getElementById('search-btn').disabled        = false;
        alert('API KEY DENIED.\n\n1. Places API enabled?\n2. Geocoding API enabled?\n3. Application Restrictions → NONE\n4. API Restrictions → Don\'t restrict\n5. Wait 5 min then try again');
        return;
      }
      console.warn('[COAI] Geocode failed, using default coords:', geoErr.message);
    }

    lastScanParams = { lat, lng, radius, resultsCount };

    let processed = 0;
    const newFailedCats = [];

    for (const cat of cats) {
      processed++;
      setProgressItem(cat, 'scanning');
      document.getElementById('loading-text').textContent     = `SCANNING: ${cat.toUpperCase()}`;
      document.getElementById('loading-progress').textContent = `${processed} / ${cats.length} categories`;
      document.getElementById('loading-sub').textContent      = `${allLeads.length} leads found so far...`;

      try {
        const places = await fetchCategoryLeads(cat, lat, lng, radius, resultsCount);
        places.forEach(place => {
          const existing = allLeads.find(l => l.id === place.place_id);
          if (existing) {
            // Merge additional category into existing lead
            if (!existing.cats.includes(cat)) existing.cats.push(cat);
          } else {
            const lead = buildLead(place, cat);
            if (lead) allLeads.push(lead);
          }
        });
        scannedCatCount++;
        setProgressItem(cat, 'done');
      } catch (catErr) {
        if (catErr.message.includes('Places API') || catErr.message.includes('key denied')) {
          throw catErr;
        }
        console.warn('[COAI] Category skipped:', cat, '—', catErr.message);
        newFailedCats.push(cat);
        setProgressItem(cat, 'failed');
      }

      await sleep(500);
    }

    // Accumulate failed cats across retries
    failedCats = [...new Set([...failedCats, ...newFailedCats])];
    retryQueue = [...failedCats];

    if (allLeads.length === 0) {
      document.getElementById('loading-wrap').style.display = 'none';
      document.getElementById('empty-state').style.display  = 'flex';
      document.getElementById('search-btn').disabled        = false;
      alert('Zero results.\n\n• Expand radius to 25–50 miles\n• Select more categories\n• Check Places API is enabled');
      return;
    }

    allLeads.sort((a, b) => b.score - a.score);
    renderLeads(allLeads);
    updateStats();
    persistState();

    document.getElementById('loading-wrap').style.display   = 'none';
    document.getElementById('stats-row').style.display      = 'grid';
    document.getElementById('filter-row').style.display     = 'flex';
    document.getElementById('sort-row').style.display       = 'flex';
    document.getElementById('export-bar').style.display     = 'flex';
    document.getElementById('select-all-row').style.display = 'flex';
    updateExportInfo();

    if (failedCats.length > 0) renderFailedSummary();
    renderAnalytics();

  } catch (err) {
    document.getElementById('loading-wrap').style.display = 'none';
    document.getElementById('empty-state').style.display  = allLeads.length === 0 ? 'flex' : 'none';
    alert('Error: ' + err.message);
  }

  document.getElementById('search-btn').disabled = false;
}

// ─── RETRY FAILED CATEGORIES ─────────────────────────────────────────────────
function retryFailed() {
  if (!retryQueue.length) return;
  const toRetry = new Set(retryQueue);
  retryQueue    = [];
  failedCats    = failedCats.filter(c => !toRetry.has(c));
  runSearch(toRetry);
}

function renderFailedSummary() {
  const banner = document.getElementById('failed-banner');
  if (!banner || failedCats.length === 0) return;
  const list = document.getElementById('failed-cats-list');
  list.innerHTML = failedCats.map(c => `<span class="failed-cat-tag">${esc(c)}</span>`).join('');
  document.getElementById('failed-label').textContent =
    `⚠ ${failedCats.length} categor${failedCats.length === 1 ? 'y' : 'ies'} failed:`;
  banner.classList.add('show');
}

// ─── BUILD LEAD ───────────────────────────────────────────────────────────────
function buildLead(place, cat) {
  // Filter out permanently-closed businesses.
  // Check both business_status (current field) and permanently_closed (deprecated legacy field).
  if (place.business_status === 'CLOSED_PERMANENTLY' || place.permanently_closed === true) return null;

  const minReviews = parseInt(document.getElementById('min-reviews').value) || 0;
  const maxRating  = parseFloat(document.getElementById('max-rating').value) || 5;

  const hasWebsite = !!place.website;
  const rating     = place.rating || 0;
  const reviews    = place.user_ratings_total || 0;
  const hasPhone   = !!place.formatted_phone_number;
  const photoCount = (place.photos && place.photos.length) || 0;

  // Filter based on sidebar settings
  if (reviews < minReviews) return null;
  if (rating > 0 && rating > maxRating) return null;

  let score = 0;
  const breakdown = [];

  if (!hasWebsite)                        { score += 40; breakdown.push('No website      +40'); }
  if (rating > 0 && rating < 3.5)         { score += 25; breakdown.push(`Low rating ${rating}★   +25`); }
  if (rating === 0)                        { score += 20; breakdown.push('No rating       +20'); }
  if (reviews < 10)                        { score += 15; breakdown.push(`${reviews} reviews       +15`); }
  if (!hasPhone)                           { score += 10; breakdown.push('No phone        +10'); }
  if (reviews === 0)                       { score += 10; breakdown.push('Zero reviews    +10'); }
  if (photoCount === 0)                    { score +=  5; breakdown.push('No photos        +5'); }

  const signals = [];
  if (!hasWebsite)                          signals.push({ label: 'No Website',       type: 'bad'  });
  if (rating > 0 && rating < 3.5)           signals.push({ label: `${rating}★`,        type: 'bad'  });
  if (rating === 0)                          signals.push({ label: 'No Rating',        type: 'warn' });
  if (reviews === 0)                         signals.push({ label: '0 Reviews',        type: 'bad'  });
  else if (reviews < 10)                     signals.push({ label: `${reviews} Reviews`, type: 'warn' });
  if (!hasPhone)                             signals.push({ label: 'No Phone',         type: 'warn' });
  if (photoCount === 0)                      signals.push({ label: 'No Photos',        type: 'warn' });
  if (reviews >= 10 && rating >= 4)          signals.push({ label: 'Active Biz',       type: 'ok'   });
  if (reviews >= 50)                         signals.push({ label: `${reviews} Reviews`, type: 'ok'  });

  const priority = score >= 50 ? 'high' : score >= 25 ? 'med' : 'low';

  return {
    id: place.place_id,
    name: place.name,
    cats: [cat],
    cat,                    // kept for CSV / backward compat
    address: place.vicinity || place.formatted_address || '',
    rating, reviews, photoCount,
    hasWebsite, website: place.website || '',
    phone: place.formatted_phone_number || '',
    hasPhone,
    score, priority, signals,
    scoreBreakdown: breakdown,
    placeId: place.place_id,
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
    note: '',
    detailsFetched: false,
  };
}

// ─── RENDER LEADS ─────────────────────────────────────────────────────────────
function renderLeads(leads) {
  const container = document.getElementById('leads-container');
  container.innerHTML = '';

  if (leads.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--muted);font-size:13px;">No leads match this filter.</div>';
    return;
  }

  leads.forEach(lead => {
    const card = document.createElement('div');
    card.className = `lead-card priority-${lead.priority}`
      + (contacted.has(lead.id) ? ' contacted' : '')
      + (closed.has(lead.id)    ? ' closed'    : '');
    card.id = `card-${lead.id}`;
    card.style.paddingLeft = '2rem';  // room for checkbox

    const scoreClass = lead.score >= 50 ? 'score-hot' : lead.score >= 25 ? 'score-warm' : 'score-cold';
    const scoreLabel = lead.score >= 50 ? '🔥 HOT' : lead.score >= 25 ? 'WARM' : 'COLD';
    const tooltip = `SCORE BREAKDOWN\n${(lead.scoreBreakdown || []).join('\n')}\n─────────────\nTOTAL: ${lead.score}`;
    const catTags    = (lead.cats || [lead.cat]).map(c => `<span class="lead-cat-tag">${esc(c.toUpperCase())}</span>`).join('');
    const sigTags    = (lead.signals || []).map(s => `<span class="signal-tag sig-${s.type}">${esc(s.label)}</span>`).join('');
    const isSelected = selectedLeads.has(lead.id);

    card.innerHTML = `
      <input type="checkbox" class="lead-check" data-id="${esc(lead.id)}"
        ${isSelected ? 'checked' : ''} onchange="toggleLeadSelect('${esc(lead.id)}',this.checked)"
        title="Select lead"/>
      <div class="lead-top">
        <div class="lead-name">${esc(lead.name)}</div>
        <div class="lead-score ${scoreClass}" data-tooltip="${esc(tooltip)}">${esc(scoreLabel)} · ${lead.score}</div>
      </div>
      <div class="lead-meta">
        ${catTags}
        <span class="lead-address">${esc(lead.address)}</span>
      </div>
      <div class="lead-signals">${sigTags}</div>
      <div class="lead-actions">
        <button class="action-btn" onclick="openMaps('${esc(lead.mapsUrl)}')">Maps</button>
        ${lead.phone ? `<button class="action-btn" onclick="callLead('${esc(lead.phone)}')">Call ${esc(lead.phone)}</button>` : ''}
        ${lead.website ? `<button class="action-btn" onclick="openWebsite('${esc(lead.id)}')">Website</button>` : ''}
        <button class="action-btn" onclick="toggleExpand('${esc(lead.id)}')">Expand ↕</button>
        <button class="action-btn" onclick="openOutreach('${esc(lead.id)}')">Outreach</button>
        <button class="action-btn mark-contacted" onclick="markContacted('${esc(lead.id)}')">Contacted</button>
        <button class="action-btn mark-closed"    onclick="markClosed('${esc(lead.id)}')">Closed ✓</button>
        <button class="action-btn" onclick="toggleNote('${esc(lead.id)}')">Note</button>
      </div>
      <div class="lead-details" id="details-${esc(lead.id)}"></div>
      <div class="lead-note"    id="note-${esc(lead.id)}">
        <textarea placeholder="Add a note..."
          onchange="saveNote('${esc(lead.id)}',this.value)">${esc(lead.note || '')}</textarea>
      </div>
    `;
    container.appendChild(card);
  });
}

// ─── EXPAND LEAD DETAILS ──────────────────────────────────────────────────────
async function toggleExpand(id) {
  const panel = document.getElementById('details-' + id);
  if (!panel) return;

  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    return;
  }

  panel.classList.add('open');

  const lead = allLeads.find(l => l.id === id);
  if (!lead) return;

  if (lead.detailsFetched) {
    renderDetailsPanel(panel, lead);
    return;
  }

  panel.innerHTML = '<div class="details-loading">⟳ Loading details...</div>';

  try {
    const data = await fetchDetails(id);
    if (data.result) {
      const r = data.result;
      lead.detailsFull = r;
      lead.detailsFetched = true;
    }
  } catch (e) {
    lead.detailsFetched = true; // don't retry on error
  }

  renderDetailsPanel(panel, lead);
}

function renderDetailsPanel(panel, lead) {
  const r = lead.detailsFull;
  let html = '<div class="details-row">';

  if (r && r.formatted_address) {
    html += `<span class="detail-chip">📍 ${esc(r.formatted_address)}</span>`;
  }
  if (lead.website) {
    html += `<span class="detail-chip">🌐 <a href="${esc(lead.website)}" target="_blank" rel="noopener">Website</a></span>`;
  }
  html += `<span class="detail-chip">📸 ${lead.photoCount || 0} photos</span>`;
  html += `<span class="detail-chip">⭐ ${lead.rating || 'No rating'} (${lead.reviews || 0} reviews)</span>`;
  html += '</div>';

  if (r && r.opening_hours && r.opening_hours.weekday_text) {
    html += '<div class="detail-hours">'
      + r.opening_hours.weekday_text.map(d => esc(d)).join('<br>')
      + '</div>';
  } else if (!r) {
    html += '<div class="detail-hours">Details unavailable.</div>';
  }

  html += `<div style="margin-top:6px;"><a href="${esc(lead.mapsUrl)}" target="_blank" rel="noopener"
    style="font-family:var(--mono);font-size:9px;color:var(--blue);text-decoration:none;letter-spacing:0.06em;">
    VIEW ON GOOGLE MAPS →</a></div>`;

  panel.innerHTML = html;
}

function openWebsite(id) {
  const lead = allLeads.find(l => l.id === id);
  if (lead && lead.website) window.open(lead.website, '_blank', 'noopener');
}

// ─── SORT ─────────────────────────────────────────────────────────────────────
function applySortAndRender() {
  const sort   = document.getElementById('sort-select').value;
  let sorted   = [...allLeads];
  if      (sort === 'score')       sorted.sort((a, b) => b.score - a.score);
  else if (sort === 'reviews_asc') sorted.sort((a, b) => a.reviews - b.reviews);
  else if (sort === 'rating_asc')  sorted.sort((a, b) => a.rating  - b.rating);
  else if (sort === 'name')        sorted.sort((a, b) => a.name.localeCompare(b.name));
  renderLeads(sorted);
}

// ─── FILTER ───────────────────────────────────────────────────────────────────
function filterLeads(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  let filtered = allLeads;
  if      (filter === 'hot')            filtered = allLeads.filter(l => l.score >= 50);
  else if (filter === 'nosite')         filtered = allLeads.filter(l => !l.hasWebsite);
  else if (filter === 'lowrated')       filtered = allLeads.filter(l => l.rating > 0 && l.rating < 4);
  else if (filter === 'notcontacted')   filtered = allLeads.filter(l => !contacted.has(l.id) && !closed.has(l.id));
  else if (filter === 'nosite_norating') filtered = allLeads.filter(l => !l.hasWebsite && l.rating === 0);
  renderLeads(filtered);
}

// ─── STATS ────────────────────────────────────────────────────────────────────
function updateStats() {
  const hot    = allLeads.filter(l => l.score >= 50).length;
  const nosite = allLeads.filter(l => !l.hasWebsite).length;
  const lowrated = allLeads.filter(l => l.rating > 0 && l.rating < 4).length;
  document.getElementById('st-found').textContent    = allLeads.length;
  document.getElementById('st-nosite').textContent   = nosite;
  document.getElementById('st-lowrated').textContent = lowrated;
  document.getElementById('st-cats').textContent     = scannedCatCount;
  document.getElementById('s-total').textContent     = allLeads.length;
  document.getElementById('s-hot').textContent       = hot;
  document.getElementById('s-nosite2').textContent   = nosite;
  document.getElementById('s-contacted').textContent = contacted.size;
  document.getElementById('s-closed').textContent    = closed.size;
}

function updateExportInfo() {
  document.getElementById('export-info').textContent =
    `${allLeads.length} leads · ${contacted.size} contacted · ${closed.size} closed`;
}

// ─── CATEGORY ANALYTICS ──────────────────────────────────────────────────────
function renderAnalytics() {
  const catStats = {};
  allLeads.forEach(lead => {
    (lead.cats || [lead.cat]).forEach(cat => {
      if (!catStats[cat]) catStats[cat] = { count: 0, totalScore: 0, hot: 0 };
      catStats[cat].count++;
      catStats[cat].totalScore += lead.score;
      if (lead.score >= 50) catStats[cat].hot++;
    });
  });

  const sorted = Object.entries(catStats).sort((a, b) => b[1].hot - a[1].hot);
  const maxHot = Math.max(1, ...sorted.map(([, s]) => s.hot));

  const tbody = document.getElementById('analytics-body');
  if (!tbody) return;
  tbody.innerHTML = sorted.map(([cat, s]) => {
    const barPct = Math.round((s.hot / maxHot) * 80);
    return `<tr>
      <td>${esc(cat)}</td>
      <td style="color:var(--white)">${s.count}</td>
      <td style="color:var(--red)">${s.hot}</td>
      <td style="color:var(--muted)">${(s.totalScore / s.count).toFixed(0)}</td>
      <td class="analytics-bar-wrap"><span class="analytics-bar" style="width:${barPct}px"></span></td>
    </tr>`;
  }).join('');

  document.getElementById('analytics-panel').style.display = 'block';
}

function toggleAnalytics() {
  const panel = document.getElementById('analytics-panel');
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// ─── BULK ACTIONS ─────────────────────────────────────────────────────────────
function toggleLeadSelect(id, checked) {
  if (checked) selectedLeads.add(id);
  else         selectedLeads.delete(id);
  updateBulkBar();
}

function toggleSelectAll(cb) {
  document.querySelectorAll('.lead-check').forEach(check => {
    check.checked = cb.checked;
    if (cb.checked) selectedLeads.add(check.dataset.id);
    else            selectedLeads.delete(check.dataset.id);
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  const count = selectedLeads.size;
  if (count > 0) {
    bar.style.display = 'flex';
    document.getElementById('bulk-count').textContent = `${count} selected`;
  } else {
    bar.style.display = 'none';
  }
}

function bulkMarkContacted() {
  selectedLeads.forEach(id => {
    contacted.add(id);
    const card = document.getElementById('card-' + id);
    if (card) card.classList.add('contacted');
  });
  clearBulkSelection();
  updateStats();
  updateExportInfo();
  persistState();
}

function bulkDelete() {
  if (!confirm(`Delete ${selectedLeads.size} selected lead(s)? This cannot be undone.`)) return;
  allLeads = allLeads.filter(l => !selectedLeads.has(l.id));
  clearBulkSelection();
  applySortAndRender();
  updateStats();
  updateExportInfo();
  persistState();
}

function clearBulkSelection() {
  selectedLeads.clear();
  document.querySelectorAll('.lead-check').forEach(c => c.checked = false);
  const allCb = document.getElementById('select-all-cb');
  if (allCb) allCb.checked = false;
  updateBulkBar();
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────
function openMaps(url)  { window.open(url, '_blank', 'noopener'); }
function callLead(phone){ window.location.href = 'tel:' + phone.replace(/\D/g, ''); }

function markContacted(id) {
  contacted.add(id);
  const card = document.getElementById('card-' + id);
  if (card) card.classList.add('contacted');
  document.getElementById('s-contacted').textContent = contacted.size;
  updateExportInfo();
  persistState();
}

function markClosed(id) {
  closed.add(id);
  contacted.add(id);
  const card = document.getElementById('card-' + id);
  if (card) { card.classList.add('closed'); card.classList.remove('contacted'); }
  document.getElementById('s-closed').textContent    = closed.size;
  document.getElementById('s-contacted').textContent = contacted.size;
  updateExportInfo();
  persistState();
}

function toggleNote(id) {
  const note = document.getElementById('note-' + id);
  if (note) note.style.display = note.style.display === 'block' ? 'none' : 'block';
}

function saveNote(id, val) {
  const lead = allLeads.find(l => l.id === id);
  if (lead) { lead.note = val; persistState(); }
}

// ─── OUTREACH MODAL ───────────────────────────────────────────────────────────
function openOutreach(id) {
  activeLead = allLeads.find(l => l.id === id);
  if (!activeLead) return;
  document.getElementById('modal-biz-name').textContent =
    activeLead.name + ' · ' + (activeLead.cats || [activeLead.cat]).join(', ').toUpperCase();
  setMsgType('text', document.querySelector('.msg-type-btn'));
  document.getElementById('modal-overlay').classList.add('open');
}

function setMsgType(type, btn) {
  msgType = type;
  document.querySelectorAll('.msg-type-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const preview = document.getElementById('msg-preview');
  if (preview) preview.value = generateMsg(activeLead, type);
}

function generateMsg(lead, type) {
  if (!lead) return '';
  const c      = CONFIG;
  const noSite  = !lead.hasWebsite;
  const lowRate = lead.rating > 0 && lead.rating < 3.5;
  const noRate  = lead.rating === 0;
  const pain    = noSite  ? 'no website showing up on Google'
                : lowRate ? `a ${lead.rating}-star rating online`
                : noRate  ? 'no reviews or ratings yet on Google'
                :           'a digital presence that could use some work';

  const cta = c.bookingLink
    ? `Book a free 10-min audit call: ${c.bookingLink}`
    : `Give me a call at ${c.phone}`;

  if (type === 'text') {
    return `Hey, I noticed ${lead.name} has ${pain}. I'm ${c.senderName} with ${c.companyName} here in ${c.city} — we build websites and AI systems for local businesses like yours starting at $1,200, and you own everything outright. No monthly fees. Would you be open to a free 10-minute audit call?\n${cta}`;
  }

  if (type === 'email') {
    const catName = (lead.cats || [lead.cat])[0];
    const fullName = c.senderLastName ? `${c.senderName} ${c.senderLastName}` : c.senderName;
    return `Subject: Your Google listing for ${lead.name} — quick question

Hi there,

I was searching for ${catName} businesses in ${c.city} and noticed ${lead.name} has ${pain}.

I'm ${fullName}, founder of ${c.companyName} (${c.companyUrl}). We build sovereign websites and AI lead capture systems for local service businesses — starting at $1,200 with full ownership and zero monthly platform fees.

I'd love to do a free 15-minute audit of your current online presence and show you exactly what it's costing you in missed leads.

${c.bookingLink ? `Book a time here: ${c.bookingLink}` : `Worth a quick call?`}

— ${fullName}
${c.phone}
${c.companyUrl}
${c.address}`;
  }

  if (type === 'voicemail') {
    return `Hey, this is ${c.senderName} calling for ${lead.name}. I run ${c.companyName} here in ${c.city} — we help local businesses fix their online presence so they stop losing leads to competitors. I noticed ${pain} on your Google listing and wanted to offer a free audit — takes about 15 minutes and I'll show you exactly what it's costing you. ${c.bookingLink ? `You can also book a time online at ${c.bookingLink}.` : `Give me a call back at ${c.phone}.`} Thanks — talk soon.`;
  }

  return '';
}

function copyMsg() {
  const preview = document.getElementById('msg-preview');
  const text    = preview ? preview.value : '';
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = 'Copy Message', 2000);
  });
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.remove('open');
  }
}

// ─── EXPORT CSV ───────────────────────────────────────────────────────────────
function exportCSV() {
  if (allLeads.length === 0) { alert('No leads to export.'); return; }
  const headers = ['Name','Categories','Address','Phone','Has Website','Website','Rating','Reviews','Score','Priority','Status','Note'];
  const rows = allLeads.map(l => [
    `"${l.name.replace(/"/g,'""')}"`,
    `"${(l.cats || [l.cat]).join('; ')}"`,
    `"${l.address}"`,
    l.phone,
    l.hasWebsite ? 'Yes' : 'No',
    l.website || '',
    l.rating  || '',
    l.reviews || '',
    l.score, l.priority,
    closed.has(l.id) ? 'Closed' : contacted.has(l.id) ? 'Contacted' : 'New',
    `"${(l.note || '').replace(/"/g,'""')}"`
  ]);
  downloadCSV([headers, ...rows], `coai-leads-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportHotCSV() {
  const hot = allLeads.filter(l => l.score >= 50);
  if (hot.length === 0) { alert('No hot leads to export.'); return; }
  const headers = ['Name','Categories','Address','Phone','Has Website','Rating','Reviews','Score'];
  const rows = hot.map(l => [
    `"${l.name.replace(/"/g,'""')}"`,
    `"${(l.cats || [l.cat]).join('; ')}"`,
    `"${l.address}"`,
    l.phone,
    l.hasWebsite ? 'Yes' : 'No',
    l.rating  || '',
    l.reviews || '',
    l.score,
  ]);
  downloadCSV([headers, ...rows], `coai-HOT-leads-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportFiltered() {
  // Export only the currently visible (filtered) leads
  const visibleIds = new Set(
    Array.from(document.querySelectorAll('.lead-card')).map(c => c.id.replace('card-', ''))
  );
  const visible = allLeads.filter(l => visibleIds.has(l.id));
  if (visible.length === 0) { alert('No leads visible with current filter.'); return; }
  const headers = ['Name','Categories','Address','Phone','Has Website','Rating','Reviews','Score','Status'];
  const rows = visible.map(l => [
    `"${l.name.replace(/"/g,'""')}"`,
    `"${(l.cats || [l.cat]).join('; ')}"`,
    `"${l.address}"`,
    l.phone,
    l.hasWebsite ? 'Yes' : 'No',
    l.rating  || '',
    l.reviews || '',
    l.score,
    closed.has(l.id) ? 'Closed' : contacted.has(l.id) ? 'Contacted' : 'New',
  ]);
  downloadCSV([headers, ...rows], `coai-filtered-leads-${new Date().toISOString().slice(0, 10)}.csv`);
}

function downloadCSV(data, filename) {
  const csv  = data.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function clearAll() {
  if (!confirm('Clear all leads? This cannot be undone.')) return;
  allLeads = []; contacted.clear(); closed.clear(); selectedLeads.clear();
  localStorage.removeItem('coai_leads');
  localStorage.removeItem('coai_contacted');
  localStorage.removeItem('coai_closed');
  document.getElementById('leads-container').innerHTML = '';
  document.getElementById('empty-state').style.display    = 'flex';
  document.getElementById('stats-row').style.display      = 'none';
  document.getElementById('filter-row').style.display     = 'none';
  document.getElementById('sort-row').style.display       = 'none';
  document.getElementById('export-bar').style.display     = 'none';
  document.getElementById('select-all-row').style.display = 'none';
  document.getElementById('analytics-panel').style.display = 'none';
  document.getElementById('bulk-bar').style.display       = 'none';
  document.getElementById('failed-banner').classList.remove('show');
  updateStats();
}

// ─── AUTH GATE ────────────────────────────────────────────────────────────────
function unlockEngine() {
  const key      = document.getElementById('access-key').value.trim();
  if (!key) return;
  const remember = document.getElementById('remember-me').checked;

  fetch('/api/search?mode=ping', { headers: { 'Authorization': key } })
    .then(r => {
      if (r.status === 401) {
        document.getElementById('login-error').style.display = 'block';
        document.getElementById('access-key').value = '';
        document.getElementById('access-key').focus();
      } else {
        if (remember) {
          localStorage.setItem('coai_remember', '1');
          localStorage.setItem('coai_auth', key);
        } else {
          localStorage.removeItem('coai_remember');
          localStorage.removeItem('coai_auth');
          sessionStorage.setItem('coai_auth', key);
        }
        document.getElementById('login-overlay').style.display = 'none';
        initApp();
      }
    })
    .catch(() => {
      // /api unavailable (e.g. local file) — accept the key anyway
      sessionStorage.setItem('coai_auth', key);
      document.getElementById('login-overlay').style.display = 'none';
      initApp();
    });
}

// Auto-hide login overlay if a valid stored session exists
(function () {
  const existing = getStoredAuth();
  if (existing) {
    document.getElementById('login-overlay').style.display = 'none';
    // Validate stored token against server before loading
    fetch('/api/search?mode=ping', { headers: { 'Authorization': existing } })
      .then(r => {
        if (r.status === 401) {
          localStorage.removeItem('coai_auth');
          sessionStorage.removeItem('coai_auth');
          document.getElementById('login-overlay').style.display = 'flex';
        } else {
          initApp();
        }
      })
      .catch(() => {
        // Offline/local — proceed
        initApp();
      });
  }
})();

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Cmd/Ctrl + Enter — run search
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    const btn = document.getElementById('search-btn');
    if (btn && !btn.disabled) runSearch();
    return;
  }
  // Esc — close modal
  if (e.key === 'Escape') {
    document.getElementById('modal-overlay').classList.remove('open');
    return;
  }
});

// ─── SERVICE WORKER ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
