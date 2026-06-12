/* ── Cambridge Day Out ── app logic ──
   Shared backend: Firestore (photos with notes, tickets, done-state sync live
   between both phones). Offline persistence queues writes until signal returns. */
(() => {
  const $ = (id) => document.getElementById(id);

  /* ── Install gate ─────────────────────────────────────────────── */
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const devBypass = /[?&]dev=1/.test(location.search);
  if (!isStandalone && !devBypass) {
    document.addEventListener('DOMContentLoaded', () => {
      $('gate').hidden = false;
      $('hero').style.display = 'none';
      document.querySelector('main').style.display = 'none';
      $('tabbar').style.display = 'none';

      const ua = navigator.userAgent;
      const isiOS = /iphone|ipad|ipod/i.test(ua);
      const isAndroid = /android/i.test(ua);
      const steps = $('gateSteps');
      if (isiOS) {
        steps.innerHTML = `
          <div class="gate-step"><span class="gate-step-num">1</span> Open this page in Safari</div>
          <div class="gate-step"><span class="gate-step-num">2</span> Tap the Share button</div>
          <div class="gate-step"><span class="gate-step-num">3</span> Tap “Add to Home Screen”</div>
          <div class="gate-step"><span class="gate-step-num">4</span> Open Cambridge from your home screen</div>`;
      } else if (isAndroid) {
        steps.innerHTML = `
          <div class="gate-step"><span class="gate-step-num">1</span> Open this page in Chrome</div>
          <div class="gate-step"><span class="gate-step-num">2</span> Open the browser menu</div>
          <div class="gate-step"><span class="gate-step-num">3</span> Tap “Add to Home screen”</div>
          <div class="gate-step"><span class="gate-step-num">4</span> Open Cambridge from your home screen</div>`;
        // Chrome may offer the native install prompt — use it if so
        window.addEventListener('beforeinstallprompt', (e) => {
          e.preventDefault();
          const btn = $('gateInstallBtn');
          btn.hidden = false;
          btn.addEventListener('click', () => e.prompt());
        });
      } else {
        steps.innerHTML = `<div class="gate-step">This app is made for your phone — open it there to install.</div>`;
        $('gateQr').hidden = false;
        $('gateQrImg').src = 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=' + encodeURIComponent(location.href);
      }
    });
    // Still register the SW so installs precache while reading instructions
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
    return; // app itself never boots in browser mode
  }

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
    const waypoints = pts.slice(1, -1).join('|');
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(pts[0])}&destination=${encodeURIComponent(pts[pts.length - 1])}&waypoints=${encodeURIComponent(waypoints)}&travelmode=walking`;
  };

  const LS = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  };
  let confettiFired = LS.get('confettiFired', false);

  /* ── Shared store (Firestore) ─────────────────────────────────── */
  let db = null, tripRef = null;
  let allMedia = [];    // [{id, stopId, kind, type, name, data, caption, by, ts}]
  let allReviews = [];  // [{id, stopId, name, text, ts}]
  let doneMap = {};     // stopId -> true
  let arrivedMap = {};  // stopId -> true (either phone confirmed arrival)
  let userName = LS.get('userName', '');

  function initFirebase() {
    try {
      firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
      tripRef = db.collection('trips').doc(TRIP.syncId);

      tripRef.collection('media').orderBy('ts').onSnapshot((snap) => {
        allMedia = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        synced = true;
        renderTimeline();
        if (!$('sheet').hidden) { renderTicketGrid(); renderPhotoGrid(); }
        if (!$('viewMemories').hidden) renderMemories();
      }, () => {});

      tripRef.collection('state').doc('shared').onSnapshot((snap) => {
        const d = snap.data() || {};
        doneMap = d.done || {};
        arrivedMap = d.arrived || {};
        renderTimeline();
        if (!$('sheet').hidden) updateDoneBtn();
      }, () => {});

      tripRef.collection('reviews').orderBy('ts').onSnapshot((snap) => {
        allReviews = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!$('viewMemories').hidden) renderMemories();
      }, () => {});
    } catch (e) {
      db = null; // itinerary, maps & tips still work without the backend
    }
  }

  const getMedia = (filter = {}) => allMedia.filter((m) =>
    (!filter.stopId || m.stopId === filter.stopId) && (!filter.kind || m.kind === filter.kind));

  function saveShared(patch) {
    if (!tripRef) return;
    // mergeFields (not merge:true) so map fields are REPLACED — otherwise
    // deleting a key (un-marking done) never reaches the server.
    tripRef.collection('state').doc('shared').set(patch, { mergeFields: Object.keys(patch) }).catch(() => {});
  }

  /* ── Image compression (keeps docs under Firestore's 1MB cap) ── */
  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
  async function compressImage(file, maxDim = 1280, quality = 0.72) {
    const { img, url } = await loadImageFile(file);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    let out = canvas.toDataURL('image/jpeg', quality);
    if (out.length > 900000) out = canvas.toDataURL('image/jpeg', 0.5);
    return out;
  }
  const readAsDataURL = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  async function addMedia(stopId, kind, file) {
    if (!tripRef) { alert('No connection to the shared album yet — try again in a moment.'); return; }
    let data, type, caption = '';
    if (file.type === 'application/pdf') {
      data = await readAsDataURL(file);
      type = 'application/pdf';
      if (data.length > 900000) {
        alert('That PDF is too big to share — take a screenshot of the ticket and add that instead.');
        return;
      }
    } else {
      data = await compressImage(file);
      type = 'image/jpeg';
      if (data.length > 980000) { alert('That photo is too large — try a smaller one.'); return; }
      if (kind === 'photo') {
        const c = await promptCaption(data);
        if (c === null) return; // cancelled
        caption = c;
      }
    }
    await tripRef.collection('media').add({ stopId, kind, type, name: file.name || '', data, caption, by: userName, ts: Date.now() });
  }

  /* Review modal — asked once per person per stop when marking it done */
  function maybePromptReview(stopId) {
    if (!tripRef || !userName) return;
    if (allReviews.some((r) => r.stopId === stopId && r.name === userName)) return;
    const s = stopById(stopId);
    $('reviewEmoji').textContent = s.emoji;
    $('reviewTitle').textContent = `What did you think of ${s.place || s.name}?`;
    $('reviewInput').value = '';
    $('reviewModal').hidden = false;
    const close = () => {
      $('reviewModal').hidden = true;
      $('reviewSave').onclick = $('reviewSkip').onclick = null;
    };
    $('reviewSave').onclick = () => {
      const text = $('reviewInput').value.trim();
      if (text) tripRef.collection('reviews').add({ stopId, name: userName, text, ts: Date.now() }).catch(() => {});
      close();
    };
    $('reviewSkip').onclick = close;
  }

  /* Photo note modal — resolves with the note text ('' for none) or null on cancel */
  function promptCaption(dataURL) {
    return new Promise((resolve) => {
      $('captionPreview').src = dataURL;
      $('captionInput').value = '';
      $('captionModal').hidden = false;
      const done = (val) => {
        $('captionModal').hidden = true;
        $('captionSave').onclick = $('captionCancel').onclick = null;
        resolve(val);
      };
      $('captionSave').onclick = () => done($('captionInput').value.trim());
      $('captionCancel').onclick = () => done(null);
    });
  }
  async function deleteMedia(id) {
    if (tripRef) await tripRef.collection('media').doc(id).delete();
  }

  /* ── Status engine ── */
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
      // Confirmed arrival pins the stop to 'now' (even if you got there early)
      if (arrivedMap[s.id] && (!isTripDay || mins < toMins(s.end))) { statuses[s.id] = 'now'; return; }
      if (!isTripDay) { statuses[s.id] = !nextAssigned ? ((nextAssigned = true), 'next') : 'upcoming'; return; }
      if (mins >= toMins(s.end)) statuses[s.id] = 'done';
      else if (mins >= toMins(s.start)) statuses[s.id] = 'now';
      else statuses[s.id] = !nextAssigned ? ((nextAssigned = true), 'next') : 'upcoming';
    });
    return statuses;
  }

  /* ── Arrival check-in ───────────────────────────────────────────
     When a stop's start time passes and nobody has confirmed arrival,
     ask. "Not yet" snoozes the question for 10 minutes (per device). */
  let arrivalAskId = null;
  function checkArrival(statuses) {
    const banner = $('arriveBanner');
    const candidate = STOPS.find((s) => statuses[s.id] === 'now' && !arrivedMap[s.id]);
    const snooze = LS.get('arriveSnooze', {});
    const show = candidate
      && (!snooze[candidate.id] || Date.now() >= snooze[candidate.id])
      && $('sheet').hidden // don't interrupt reading a stop
      && $('nameModal').hidden && $('reviewModal').hidden;
    if (show) {
      arrivalAskId = candidate.id;
      $('arriveEmoji').textContent = candidate.emoji;
      $('arriveText').textContent = `Have you arrived at ${candidate.place || candidate.name}?`;
      banner.hidden = false;
    } else if (!candidate || (arrivalAskId && (!stopById(arrivalAskId) || arrivedMap[arrivalAskId]))) {
      banner.hidden = true;
      arrivalAskId = null;
    }
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
      $('nowTime').textContent = nowId.nowLine ? `${nowId.nowLine} · until ${nowId.end}` : `until ${nowId.end}`;
    } else if (nextStop) {
      nowCard.hidden = false;
      const idx = STOPS.indexOf(nextStop);
      const walking = idx > 0 && statuses[STOPS[idx - 1].id] === 'done';
      $('nowLabel').textContent = walking ? '🚶 ON THE WAY TO' : 'UP NEXT';
      $('nowTitle').textContent = `${nextStop.emoji} ${nextStop.name}`;
      if (walking) {
        $('nowTime').textContent = nextStop.walkLine || `at ${nextStop.start}`;
      } else if (todayStr === TRIP.date) {
        const diff = toMins(nextStop.start) - (now.getHours() * 60 + now.getMinutes());
        const h = Math.floor(diff / 60), m = diff % 60;
        const when = diff > 0 ? `in ${h ? h + 'h ' : ''}${m}m` : `at ${nextStop.start}`;
        $('nowTime').textContent = nextStop.tease ? `${when} — ${nextStop.tease}` : when;
      } else {
        const tripDate = new Date(TRIP.date + 'T00:00:00');
        const days = Math.ceil((tripDate - now) / 86400000);
        const when = days === 1 ? `tomorrow at ${nextStop.start}` : `at ${nextStop.start}`;
        $('nowTime').textContent = nextStop.tease ? `${when} — ${nextStop.tease}` : when;
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
  function mediaCountsFor(stopId) {
    const counts = { photo: 0, ticket: 0 };
    allMedia.forEach((m) => { if (m.stopId === stopId) counts[m.kind] = (counts[m.kind] || 0) + 1; });
    return counts;
  }

  function renderTimeline() {
    const statuses = computeStatus();
    renderHero(statuses);
    checkArrival(statuses);
    // Walking detection: previous stop finished (by the clock, or either of you
    // marked it done) and the next one hasn't started — you're between stops.
    let walkingToIdx = -1;
    STOPS.forEach((s, i) => {
      if (i > 0 && statuses[s.id] === 'next' && statuses[STOPS[i - 1].id] === 'done') walkingToIdx = i;
    });

    const ol = $('timeline');
    ol.innerHTML = '';
    STOPS.forEach((s, i) => {
      const li = document.createElement('li');
      const st = statuses[s.id];
      const isWalkingTo = i === walkingToIdx;
      const isWalkingFrom = i === walkingToIdx - 1;
      li.className = `stop ${st}${isWalkingTo ? ' walking' : ''}${isWalkingFrom ? ' trail-active' : ''}`;
      const counts = mediaCountsFor(s.id);
      const pills = [];
      if (st === 'now') pills.push(arrivedMap[s.id]
        ? '<span class="pill pill-now">📍 ARRIVED</span>'
        : '<span class="pill pill-now">NOW</span>');
      if (s.booked) pills.push(`<span class="pill pill-booked">🎟 ${s.bookedLabel || 'Booked'}</span>`);
      if (st === 'done') pills.push('<span class="pill pill-done">✓ Done</span>');
      if (counts.ticket) pills.push(`<span class="pill pill-media">🎟 ${counts.ticket}</span>`);
      if (counts.photo) pills.push(`<span class="pill pill-media">📷 ${counts.photo}</span>`);
      const chip = isWalkingTo
        ? `<div class="walk-chip walking">🚶 On the way${s.walk ? ` — ${s.walk}` : '…'}</div>`
        : (s.walk ? `<div class="walk-chip">🚶 ${s.walk}</div>` : '');
      const trail = i < STOPS.length - 1
        ? `<div class="steps-trail" aria-hidden="true">${'<span>👣</span>'.repeat(5)}</div>`
        : '';
      li.innerHTML = `
        ${chip}
        <div class="stop-dot">${st === 'done' ? '✓' : i + 1}</div>
        ${trail}
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
  function renderMemories() {
    const photos = getMedia({ kind: 'photo' });
    const grid = $('memoriesGrid');
    grid.innerHTML = '';
    $('memoriesEmpty').hidden = photos.length > 0 || allReviews.length > 0;
    const byStop = {};
    photos.forEach((p) => { (byStop[p.stopId] = byStop[p.stopId] || []).push(p); });
    const reviewsByStop = {};
    allReviews.forEach((r) => { (reviewsByStop[r.stopId] = reviewsByStop[r.stopId] || []).push(r); });
    STOPS.forEach((s) => {
      const items = byStop[s.id] || [];
      const quotes = reviewsByStop[s.id] || [];
      if (!items.length && !quotes.length) return;
      const group = document.createElement('div');
      group.className = 'mem-group';
      group.innerHTML = `<div class="mem-group-title">${s.emoji} ${s.name}</div><div class="mem-quotes"></div><div class="mem-group-photos"></div>`;
      const quotesEl = group.querySelector('.mem-quotes');
      quotes.forEach((r) => {
        const q = document.createElement('div');
        q.className = 'mem-quote';
        q.textContent = `“${r.text}”`;
        const by = document.createElement('span');
        by.className = 'mem-quote-by';
        by.textContent = `— ${r.name}`;
        q.appendChild(by);
        quotesEl.appendChild(q);
      });
      const photosEl = group.querySelector('.mem-group-photos');
      items.forEach((m) => {
        const b = document.createElement('button');
        b.className = 'mem-thumb';
        const img = document.createElement('img');
        img.src = m.data;
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
  function openSheet(stopId) {
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
    updateDoneBtn();
    renderTicketGrid();
    renderPhotoGrid();

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
    renderTimeline();
  }

  /* ── Swipe-to-dismiss on the sheet ── */
  (function sheetSwipe() {
    const sheet = $('sheet');
    const scroll = $('sheetScroll');
    let startY = 0, dy = 0, dragging = false;
    sheet.addEventListener('touchstart', (e) => {
      if (scroll.scrollTop > 2) return;
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

  function renderTicketGrid() {
    const s = stopById(currentStopId);
    const grid = $('ticketGrid');
    grid.innerHTML = '';
    if (!s || !s.hasTickets) return;
    getMedia({ stopId: currentStopId, kind: 'ticket' }).forEach((m) => {
      const b = document.createElement('button');
      if (m.type.startsWith('image/')) {
        b.className = 'ticket-thumb img-ticket';
        const img = document.createElement('img');
        img.src = m.data; img.alt = 'Ticket';
        b.appendChild(img);
      } else {
        b.className = 'ticket-thumb';
        b.innerHTML = `<span class="ticket-icon">📄</span><span class="ticket-name">${m.name || 'Ticket PDF'}</span>`;
      }
      b.addEventListener('click', () => openViewer(m));
      grid.appendChild(b);
    });
  }
  function renderPhotoGrid() {
    const grid = $('photoGrid');
    grid.innerHTML = '';
    getMedia({ stopId: currentStopId, kind: 'photo' }).forEach((m) => {
      const b = document.createElement('button');
      b.className = 'photo-thumb';
      const img = document.createElement('img');
      img.src = m.data; img.alt = 'Photo';
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
      frame.src = m.data;
      body.appendChild(frame);
    } else {
      const img = document.createElement('img');
      img.src = m.data;
      body.appendChild(img);
    }
    $('viewerCaption').textContent = m.caption ? `“${m.caption}”${m.by ? ` — ${m.by}` : ''}` : '';
    $('viewerCaption').hidden = !m.caption;
    if (!document.body.classList.contains('locked')) { lockBody(); viewerLocked = true; }
    $('viewer').hidden = false;
  }
  function closeViewer() {
    $('viewer').hidden = true; $('viewerBody').innerHTML = ''; viewerItem = null;
    if (viewerLocked) { unlockBody(); viewerLocked = false; }
  }

  /* ── Confetti ── */
  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
  $('arriveYes').addEventListener('click', () => {
    if (!arrivalAskId) return;
    arrivedMap[arrivalAskId] = true;
    // Arriving somewhere means every earlier stop is behind you
    const idx = STOPS.findIndex((s) => s.id === arrivalAskId);
    STOPS.slice(0, idx).forEach((s) => { doneMap[s.id] = true; });
    saveShared({ arrived: arrivedMap, done: doneMap });
    $('arriveBanner').hidden = true;
    arrivalAskId = null;
    renderTimeline();
  });
  $('arriveNo').addEventListener('click', () => {
    if (arrivalAskId) {
      const snooze = LS.get('arriveSnooze', {});
      snooze[arrivalAskId] = Date.now() + 10 * 60 * 1000; // ask again in 10 min
      LS.set('arriveSnooze', snooze);
    }
    $('arriveBanner').hidden = true;
  });
  $('nowCard').addEventListener('click', () => { if (heroStopId) openSheet(heroStopId); });
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('viewerClose').addEventListener('click', closeViewer);
  $('viewerDelete').addEventListener('click', async () => {
    if (!viewerItem) return;
    if (!confirm('Delete this for both of you?')) return;
    await deleteMedia(viewerItem.id);
    closeViewer();
  });
  $('doneBtn').addEventListener('click', () => {
    if (doneMap[currentStopId]) {
      // Un-mark: also clear the arrival flag so the stop fully resets
      delete doneMap[currentStopId];
      delete arrivedMap[currentStopId];
      saveShared({ done: doneMap, arrived: arrivedMap });
    } else {
      doneMap[currentStopId] = true;
      saveShared({ done: doneMap });
      maybePromptReview(currentStopId);
    }
    updateDoneBtn();
    renderTimeline();
  });
  $('ticketInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) await addMedia(currentStopId, 'ticket', f);
    e.target.value = '';
    renderTicketGrid();
  });
  $('photoInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) await addMedia(currentStopId, 'photo', f);
    e.target.value = '';
    renderPhotoGrid();
  });

  /* ── First-open name ask ── */
  (function askName() {
    if (userName) return;
    $('nameModal').hidden = false;
    const save = () => {
      const val = $('nameInput').value.trim();
      if (!val) { $('nameInput').focus(); return; }
      userName = val;
      LS.set('userName', userName);
      $('nameModal').hidden = true;
    };
    $('nameSave').addEventListener('click', save);
    $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  })();

  /* ── Hero date ── */
  (function heroDate() {
    const d = new Date(TRIP.date + 'T12:00:00');
    $('heroKicker').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  })();

  /* ── Boot ── */
  initFirebase();
  renderRoute();
  renderTimeline();
  setInterval(() => renderTimeline(), 60 * 1000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
