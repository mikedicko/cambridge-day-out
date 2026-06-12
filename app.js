/* ── Cambridge Day Out ── app logic ── */
(() => {
  const $ = (id) => document.getElementById(id);

  /* ── Small helpers ── */
  const toMins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const fmtRange = (s) => `${s.start} – ${s.end}`;
  const stopById = (id) => STOPS.find((s) => s.id === id);
  const prevStop = (id) => { const i = STOPS.findIndex((s) => s.id === id); return i > 0 ? STOPS[i - 1] : null; };

  // Direct keyless embed endpoints (what maps.google.com?output=embed 301s to —
  // the redirect hop carries X-Frame-Options, the final document doesn't).
  const mapsEmbed = (q) => `https://www.google.com/maps/embed?origin=mfe&pb=!1m3!2m1!1s${encodeURIComponent(q)}!6i16`;
  const mapsRouteEmbed = (points) => {
    const groups = points.map((p) => `!4m1!2s${encodeURIComponent(p)}`).join('');
    return `https://www.google.com/maps/embed?origin=mfe&pb=!1m${points.length * 2 + 2}!4m${points.length * 2 + 1}!3e2${groups}`;
  };
  const mapsDirections = (from, to) =>
    `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=walking`;
  const mapsFullRoute = () => {
    const pts = STOPS.map((s) => s.mapQuery);
    const origin = pts[0], destination = pts[pts.length - 1];
    const waypoints = pts.slice(1, -1).join('|');
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&waypoints=${encodeURIComponent(waypoints)}&travelmode=walking`;
  };

  /* ── Local state (localStorage) ── */
  const LS = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  };
  let doneMap = LS.get('done', {});       // stopId -> true (manual override)
  let notesMap = LS.get('notes', {});     // stopId -> string
  let confettiFired = LS.get('confettiFired', false);

  /* ── IndexedDB for photos & tickets ──
     Stored as ArrayBuffer + mime type (more reliable than Blob on older iOS Safari). */
  const DB_NAME = 'cambridge-day';
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.createObjectStore('media', { keyPath: 'id', autoIncrement: true });
        store.createIndex('byStop', 'stopId');
        store.createIndex('byKind', 'kind');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function addMedia(stopId, kind, file) {
    const buf = await file.arrayBuffer();
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').add({ stopId, kind, type: file.type, name: file.name, buf, ts: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function getMedia(filter = {}) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readonly');
      const req = tx.objectStore('media').getAll();
      req.onsuccess = () => {
        let items = req.result;
        if (filter.stopId) items = items.filter((m) => m.stopId === filter.stopId);
        if (filter.kind) items = items.filter((m) => m.kind === filter.kind);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  }
  async function deleteMedia(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  const mediaURL = (m) => URL.createObjectURL(new Blob([m.buf], { type: m.type }));

  /* ── Status engine ── */
  // 'done' | 'now' | 'next' | 'upcoming'
  function computeStatus() {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const isTripDay = todayStr === TRIP.date;
    const afterTripDay = todayStr > TRIP.date;
    const mins = now.getHours() * 60 + now.getMinutes();

    const statuses = {};
    let nextAssigned = false;
    STOPS.forEach((s) => {
      if (doneMap[s.id]) { statuses[s.id] = 'done'; return; }
      if (afterTripDay) { statuses[s.id] = 'done'; return; }
      if (!isTripDay) { statuses[s.id] = !nextAssigned ? ((nextAssigned = true), 'next') : 'upcoming'; return; }
      if (mins >= toMins(s.end)) statuses[s.id] = 'done';
      else if (mins >= toMins(s.start)) statuses[s.id] = 'now';
      else statuses[s.id] = !nextAssigned ? ((nextAssigned = true), 'next') : 'upcoming';
    });
    return statuses;
  }

  /* ── Hero / now card ── */
  let heroStopId = null;
  function renderHero(statuses) {
    const nowCard = $('nowCard');
    const nowId = STOPS.find((s) => statuses[s.id] === 'now');
    const nextStop = STOPS.find((s) => statuses[s.id] === 'next');
    heroStopId = (nowId || nextStop || {}).id || null;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    if (nowId) {
      nowCard.hidden = false;
      $('nowLabel').textContent = '● HAPPENING NOW';
      $('nowTitle').textContent = `${nowId.emoji} ${nowId.name}`;
      $('nowTime').textContent = `until ${nowId.end}`;
    } else if (nextStop) {
      nowCard.hidden = false;
      $('nowLabel').textContent = 'UP NEXT';
      $('nowTitle').textContent = `${nextStop.emoji} ${nextStop.name}`;
      if (todayStr === TRIP.date) {
        const diff = toMins(nextStop.start) - (now.getHours() * 60 + now.getMinutes());
        const h = Math.floor(diff / 60), m = diff % 60;
        $('nowTime').textContent = diff > 0 ? `in ${h ? h + 'h ' : ''}${m}m · at ${nextStop.start}` : `at ${nextStop.start}`;
      } else {
        const tripDate = new Date(TRIP.date + 'T00:00:00');
        const days = Math.ceil((tripDate - now) / 86400000);
        $('nowTime').textContent = days === 1 ? `tomorrow at ${nextStop.start} — get excited!` : `at ${nextStop.start}`;
      }
    } else {
      nowCard.hidden = false;
      $('nowLabel').textContent = 'THAT’S A WRAP';
      $('nowTitle').textContent = '🥂 What a day';
      $('nowTime').textContent = 'Check the Memories tab';
    }

    const doneCount = STOPS.filter((s) => statuses[s.id] === 'done').length;
    $('progressFill').style.width = `${(doneCount / STOPS.length) * 100}%`;
    $('progressText').textContent = `${doneCount}/${STOPS.length} stops`;

    if (doneCount === STOPS.length && !confettiFired) {
      confettiFired = true; LS.set('confettiFired', true);
      confetti();
    }
  }

  /* ── Timeline ── */
  let mediaCounts = {}; // stopId -> {photos, tickets}
  async function refreshMediaCounts() {
    const all = await getMedia();
    mediaCounts = {};
    all.forEach((m) => {
      mediaCounts[m.stopId] = mediaCounts[m.stopId] || { photo: 0, ticket: 0 };
      mediaCounts[m.stopId][m.kind]++;
    });
  }

  function renderTimeline() {
    const statuses = computeStatus();
    renderHero(statuses);
    const ol = $('timeline');
    ol.innerHTML = '';
    STOPS.forEach((s, i) => {
      const li = document.createElement('li');
      const st = statuses[s.id];
      li.className = `stop ${st}`;
      const counts = mediaCounts[s.id] || { photo: 0, ticket: 0 };
      const pills = [];
      if (st === 'now') pills.push('<span class="pill pill-now">NOW</span>');
      if (s.booked) pills.push(`<span class="pill pill-booked">🎟 ${s.bookedLabel || 'Booked'}</span>`);
      if (st === 'done') pills.push('<span class="pill pill-done">✓ Done</span>');
      if (counts.ticket) pills.push(`<span class="pill pill-media">🎟 ${counts.ticket}</span>`);
      if (counts.photo) pills.push(`<span class="pill pill-media">📷 ${counts.photo}</span>`);
      li.innerHTML = `
        ${s.walk ? `<div class="walk-chip">🚶 ${s.walk}</div>` : ''}
        <div class="stop-dot">${st === 'done' ? '✓' : i + 1}</div>
        <button class="stop-card" data-stop="${s.id}">
          <div class="stop-emoji">${s.emoji}</div>
          <div class="stop-info">
            <div class="stop-time">${fmtRange(s)}</div>
            <div class="stop-name">${s.name}</div>
            ${pills.length ? `<div class="stop-meta">${pills.join('')}</div>` : ''}
          </div>
          <div class="stop-chevron">›</div>
        </button>`;
      ol.appendChild(li);
    });
    ol.querySelectorAll('.stop-card').forEach((btn) =>
      btn.addEventListener('click', () => openSheet(btn.dataset.stop))
    );
  }

  /* ── Route view ── */
  function renderRoute() {
    $('routeMap').src = mapsRouteEmbed(STOPS.map((s) => s.mapQuery));
    $('openRouteBtn').href = mapsFullRoute();
    const ol = $('routeList');
    ol.innerHTML = '';
    STOPS.forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="route-num">${i + 1}</span> <span>${s.emoji} ${s.name}</span> <span class="route-time">${s.start}</span>`;
      ol.appendChild(li);
    });
  }

  /* ── Memories ── */
  async function renderMemories() {
    const photos = await getMedia({ kind: 'photo' });
    const grid = $('memoriesGrid');
    grid.innerHTML = '';
    $('memoriesEmpty').hidden = photos.length > 0;
    const byStop = {};
    photos.forEach((p) => { (byStop[p.stopId] = byStop[p.stopId] || []).push(p); });
    STOPS.forEach((s) => {
      const items = byStop[s.id];
      if (!items) return;
      const group = document.createElement('div');
      group.className = 'mem-group';
      group.innerHTML = `<div class="mem-group-title">${s.emoji} ${s.name}</div><div class="mem-group-photos"></div>`;
      const photosEl = group.querySelector('.mem-group-photos');
      items.forEach((m) => {
        const b = document.createElement('button');
        b.className = 'mem-thumb';
        const img = document.createElement('img');
        img.src = mediaURL(m);
        img.alt = s.name;
        b.appendChild(img);
        b.addEventListener('click', () => openViewer(m));
        photosEl.appendChild(b);
      });
      grid.appendChild(group);
    });
  }

  /* ── Scroll lock (iOS background scroll bleed) ── */
  let lockScrollY = 0;
  function lockBody() {
    lockScrollY = window.scrollY;
    document.body.style.top = `-${lockScrollY}px`;
    document.body.classList.add('locked');
  }
  function unlockBody() {
    document.body.classList.remove('locked');
    document.body.style.top = '';
    window.scrollTo(0, lockScrollY);
  }

  /* ── Bottom sheet ── */
  let currentStopId = null;
  async function openSheet(stopId) {
    currentStopId = stopId;
    const s = stopById(stopId);
    $('sheetPhotoImg').src = `images/${s.id}.jpg`;
    $('sheetPhotoImg').alt = s.name;
    $('sheetPhotoCredit').textContent = (typeof IMAGE_CREDITS !== 'undefined' && IMAGE_CREDITS[s.id]) ? `📷 ${IMAGE_CREDITS[s.id]}` : '';
    $('sheetEmoji').textContent = s.emoji;
    $('sheetTitle').textContent = s.name;
    $('sheetTime').textContent = fmtRange(s);

    const badges = [];
    if (s.booked) badges.push(`<span class="pill pill-booked">🎟 ${s.bookedLabel || 'Booked'}</span>`);
    if (s.walk) badges.push(`<span class="pill pill-media">🚶 ${s.walk}</span>`);
    $('sheetBadges').innerHTML = badges.join('');

    $('sheetDesc').textContent = s.desc;
    $('tipsList').innerHTML = s.tips.map((t) => `<li>${t}</li>`).join('');

    $('stopMap').src = mapsEmbed(s.mapQuery);
    const prev = prevStop(stopId);
    $('directionsBtn').href = prev ? mapsDirections(prev.mapQuery, s.mapQuery)
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.mapQuery)}`;
    $('websiteBtn').hidden = !s.website;
    if (s.website) $('websiteBtn').href = s.website;

    $('ticketsSection').hidden = !s.hasTickets;
    $('notesInput').value = notesMap[stopId] || '';
    updateDoneBtn();
    await Promise.all([renderTicketGrid(), renderPhotoGrid()]);

    $('sheetScroll').scrollTop = 0;
    $('sheetBackdrop').hidden = false;
    $('sheet').hidden = false;
    lockBody();
    requestAnimationFrame(() => {
      $('sheetBackdrop').classList.add('open');
      $('sheet').classList.add('open');
    });
  }
  function closeSheet() {
    $('sheetBackdrop').classList.remove('open');
    $('sheet').classList.remove('open');
    $('sheet').style.transform = '';
    $('stopMap').src = 'about:blank';
    unlockBody();
    setTimeout(() => { $('sheetBackdrop').hidden = true; $('sheet').hidden = true; }, 300);
    refreshAll();
  }

  /* ── Swipe-to-dismiss on the sheet ── */
  (function sheetSwipe() {
    const sheet = $('sheet');
    const scroll = $('sheetScroll');
    let startY = 0, dy = 0, dragging = false;
    sheet.addEventListener('touchstart', (e) => {
      if (scroll.scrollTop > 2) return; // only when scrolled to top
      startY = e.touches[0].clientY;
      dy = 0;
      dragging = true;
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      dy = e.touches[0].clientY - startY;
      if (dy > 0 && scroll.scrollTop <= 0) {
        sheet.classList.add('dragging');
        sheet.style.transform = `translateY(${dy}px)`;
      }
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      if (dy > 110) { closeSheet(); }
      else { sheet.style.transform = ''; }
      dy = 0;
    });
  })();
  function updateDoneBtn() {
    const isDone = !!doneMap[currentStopId];
    const btn = $('doneBtn');
    btn.textContent = isDone ? '↩︎ Mark as not done' : '✓ Mark as done';
    btn.classList.toggle('undone', isDone);
  }

  async function renderTicketGrid() {
    const s = stopById(currentStopId);
    const grid = $('ticketGrid');
    grid.innerHTML = '';
    if (!s.hasTickets) return;
    const tickets = await getMedia({ stopId: currentStopId, kind: 'ticket' });
    tickets.forEach((m) => {
      const b = document.createElement('button');
      if (m.type.startsWith('image/')) {
        b.className = 'ticket-thumb img-ticket';
        const img = document.createElement('img');
        img.src = mediaURL(m); img.alt = 'Ticket';
        b.appendChild(img);
      } else {
        b.className = 'ticket-thumb';
        b.innerHTML = `<span class="ticket-icon">📄</span><span class="ticket-name">${m.name || 'Ticket PDF'}</span>`;
      }
      b.addEventListener('click', () => openViewer(m));
      grid.appendChild(b);
    });
  }
  async function renderPhotoGrid() {
    const grid = $('photoGrid');
    grid.innerHTML = '';
    const photos = await getMedia({ stopId: currentStopId, kind: 'photo' });
    photos.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'photo-thumb';
      const img = document.createElement('img');
      img.src = mediaURL(m); img.alt = 'Photo';
      b.appendChild(img);
      b.addEventListener('click', () => openViewer(m));
      grid.appendChild(b);
    });
  }

  /* ── Viewer ── */
  let viewerItem = null, viewerLocked = false;
  function openViewer(m) {
    viewerItem = m;
    const body = $('viewerBody');
    body.innerHTML = '';
    if (m.type === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.src = mediaURL(m);
      body.appendChild(frame);
    } else {
      const img = document.createElement('img');
      img.src = mediaURL(m);
      body.appendChild(img);
    }
    if (!document.body.classList.contains('locked')) { lockBody(); viewerLocked = true; }
    $('viewer').hidden = false;
  }
  function closeViewer() {
    $('viewer').hidden = true; $('viewerBody').innerHTML = ''; viewerItem = null;
    if (viewerLocked) { unlockBody(); viewerLocked = false; }
  }

  /* ── Confetti ── */
  function confetti() {
    const layer = $('confettiLayer');
    const colors = ['#c9a227', '#1e4d3b', '#c4663d', '#e8d49a', '#7fb069'];
    for (let i = 0; i < 90; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti';
      piece.style.left = `${(i * 37) % 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = `${2.2 + (i % 5) * 0.45}s`;
      piece.style.animationDelay = `${(i % 10) * 0.12}s`;
      layer.appendChild(piece);
    }
    setTimeout(() => { layer.innerHTML = ''; }, 6000);
  }

  /* ── Tabs ── */
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      ['viewToday', 'viewMap', 'viewMemories'].forEach((v) => { $(v).hidden = v !== tab.dataset.view; });
      $('hero').style.display = tab.dataset.view === 'viewToday' ? '' : 'none';
      if (tab.dataset.view === 'viewMemories') renderMemories();
      window.scrollTo(0, 0);
    });
  });

  /* ── Events ── */
  $('nowCard').addEventListener('click', () => { if (heroStopId) openSheet(heroStopId); });
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('viewerClose').addEventListener('click', closeViewer);
  $('viewerDelete').addEventListener('click', async () => {
    if (!viewerItem) return;
    if (!confirm('Delete this?')) return;
    await deleteMedia(viewerItem.id);
    closeViewer();
    await refreshMediaCounts();
    if (!$('sheet').hidden) { renderTicketGrid(); renderPhotoGrid(); }
    if (!$('viewMemories').hidden) renderMemories();
  });
  $('doneBtn').addEventListener('click', () => {
    if (doneMap[currentStopId]) delete doneMap[currentStopId];
    else doneMap[currentStopId] = true;
    LS.set('done', doneMap);
    updateDoneBtn();
  });
  $('notesInput').addEventListener('input', (e) => {
    notesMap[currentStopId] = e.target.value;
    LS.set('notes', notesMap);
  });
  $('ticketInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) await addMedia(currentStopId, 'ticket', f);
    e.target.value = '';
    await refreshMediaCounts();
    renderTicketGrid();
  });
  $('photoInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) await addMedia(currentStopId, 'photo', f);
    e.target.value = '';
    await refreshMediaCounts();
    renderPhotoGrid();
  });

  /* ── Install hint (iOS Safari, not yet installed) ── */
  (function installHint() {
    const dismissed = LS.get('installHintDismissed', false);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isiOS && !isStandalone && !dismissed) $('installHint').hidden = false;
    $('installHintClose').addEventListener('click', () => {
      $('installHint').hidden = true;
      LS.set('installHintDismissed', true);
    });
  })();

  /* ── Hero date ── */
  (function heroDate() {
    const d = new Date(TRIP.date + 'T12:00:00');
    $('heroKicker').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  })();

  /* ── Boot ── */
  async function refreshAll() {
    await refreshMediaCounts();
    renderTimeline();
  }
  renderRoute();
  refreshAll();
  setInterval(() => renderTimeline(), 60 * 1000); // live status updates

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
