/**
 * Smart Bus Seat Monitor — Web Dashboard  v5.0
 * Route-based auto-unallocate | RGB LED + Buzzer via Firebase
 * Plain fetch() REST — no SDK, no API key
 */

// ── FIREBASE REST BASE ─────────────────────────────────────────────────────
const DB        = "https://seat-pressure-monitoring-default-rtdb.asia-southeast1.firebasedatabase.app";
const SEATS_URL = `${DB}/seat_monitor/seats.json`;
const ROUTE_URL = `${DB}/seat_monitor/route.json`;

// ── ROUTE STOPS ────────────────────────────────────────────────────────────
const STOPS = [
  "Coimbatore",   // 0
  "Erode",        // 1
  "Salem",        // 2
  "Krishnagiri",  // 3
  "Chennai"       // 4
];
const NO_BOARD_GRACE = 2; // auto-unallocate if passenger hasn't boarded within this many stops

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const SENSOR_SEATS = ["seat_1", "seat_2"];
const SOLD_SEATS   = new Set([3,4,7,9,10,13,14,18,19,22,25,26,30,32,33,37,38]);
const POLL_MS      = 2000;

// LED color codes written to Firebase for the ESP32
const LED = { OFF: 0, GREEN: 1, BLUE: 2, RED: 3 };

// ── STATE ──────────────────────────────────────────────────────────────────
let seatData = {
  seat_1: { sensor: 0, booked: false, passenger: "", fromStop: 0, toStop: 4, status: "Empty" },
  seat_2: { sensor: 0, booked: false, passenger: "", fromStop: 0, toStop: 4, status: "Empty" }
};
let prevStates     = {};
let alertDismissed = {};
let selectedSeat   = null;
let unauthSince    = {};
let currentStop    = 0;   // index into STOPS[], updated by the slider
let sleeperMode    = false; // when true, BOTH sensors must read 1 for "verified"

// ── STATUS ENGINE ──────────────────────────────────────────────────────────
function calcStatus(sensor, booked, fromStop = 0) {
  if (sensor === 1 && booked) {
    if (currentStop < fromStop) return "Early Boarding"; // seated before their boarding stop
    return "Passenger Verified";
  }
  if (sensor === 1 && !booked) return "Unauthorized Passenger";
  if (sensor === 0 && booked)  return "Passenger Not Seated";
  return "Empty";
}

// Returns { led, buzzer } for the ESP32 based on seat status
function alertPayload(status) {
  switch (status) {
    case "Passenger Verified":     return { led: LED.GREEN, buzzer: false };
    case "Passenger Not Seated":   return { led: LED.BLUE,  buzzer: false };
    case "Unauthorized Passenger": return { led: LED.RED,   buzzer: true  };
    case "Early Boarding":         return { led: LED.RED,   buzzer: true  };
    default:                       return { led: LED.OFF,   buzzer: false };
  }
}

// ── BUILD SEAT GRID ────────────────────────────────────────────────────────
function buildGrid() {
  const colLeft  = document.getElementById("col-left");
  const colRight = document.getElementById("col-right");
  if (!colLeft || !colRight) return;
  colLeft.innerHTML  = "";
  colRight.innerHTML = "";

  if (sleeperMode) {
    // Row 0: single wide berth card (seats 1+2 combined)
    colLeft.appendChild(makeSleeperBerth());
    // Rows 1-9: normal seats 3-20
    for (let row = 1; row < 10; row++) {
      colLeft.appendChild(makeRow(row*2+1, row*2+2));
    }
  } else {
    for (let row = 0; row < 10; row++) {
      colLeft.appendChild(makeRow(row*2+1, row*2+2));
    }
    // Attach click handlers to individual IoT seats
    SENSOR_SEATS.forEach((sid) => {
      document.getElementById(`gs-${sid}`)
        ?.addEventListener("click", () => handleSeatClick(sid));
    });
  }

  for (let row = 0; row < 10; row++) {
    colRight.appendChild(makeRow(row*2+21, row*2+22));
  }

  if (sleeperMode) {
    document.getElementById("gs-berth")?.addEventListener("click", () => handleSeatClick("seat_1"));
  }
}

// Single tall berth card for sleeper mode (replaces the seat_1 + seat_2 row)
function makeSleeperBerth() {
  const wrap = document.createElement("div");
  wrap.className = "sleeper-berth-row";
  const el = document.createElement("div");
  el.className = "gs gs-sensor gs-sensor-empty sleeper-berth";
  el.id = "gs-berth";
  el.innerHTML = `
    <svg class="gs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <rect x="2" y="7" width="20" height="10" rx="2"/>
      <path d="M2 12h20M6 7V5M18 7V5"/>
    </svg>
    <span class="gs-num">Berth</span>
    <span class="gs-num" style="font-size:0.6rem;opacity:0.7">1 &amp; 2</span>
    <span class="gs-price" id="berth-price">IoT</span>
    <span class="gs-sensor-dot dot-gray" id="dot-gs-seat_1"></span>
    <div class="berth-sensors">
      <span class="berth-s" id="berth-s1" title="Sensor 1">S1</span>
      <span class="berth-s" id="berth-s2" title="Sensor 2">S2</span>
    </div>
    <span class="gs-timer" id="gs-timer-seat_1"></span>
  `;
  wrap.appendChild(el);
  return wrap;
}

function makeRow(a, b) {
  const row = document.createElement("div");
  row.className = "seat-grid-row";
  row.appendChild(makeSeatEl(a));
  row.appendChild(makeSeatEl(b));
  return row;
}

function makeSeatEl(num) {
  const seatId   = `seat_${num}`;
  const isSensor = SENSOR_SEATS.includes(seatId);
  const isSold   = SOLD_SEATS.has(num);
  const el       = document.createElement("div");
  el.className   = "gs " + (isSensor ? "gs-sensor gs-sensor-empty"
                           : isSold   ? "gs-sold" : "gs-available");
  el.id          = `gs-${seatId}`;
  el.dataset.seat = seatId;
  const label = isSensor ? (num === 1 ? "1" : "2") : num;
  const price = isSold ? "Sold" : isSensor ? "IoT" : "\u20b9" + getPrice(num);
  el.innerHTML = `
    <svg class="gs-icon" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <path d="M5 10V6a7 7 0 0114 0v4"/>
      <path d="M3 14h18v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4z"/>
    </svg>
    <span class="gs-num">${label}</span>
    <span class="gs-price">${price}</span>
    ${isSensor ? `<span class="gs-sensor-dot dot-gray" id="dot-gs-${seatId}"></span>
                  <span class="gs-timer" id="gs-timer-${seatId}"></span>` : ""}
  `;
  return el;
}

function getPrice(num) {
  return num <= 20 ? (num % 2 === 1 ? "1079" : "494")
                   : (num % 2 === 1 ? "989"  : "719");
}

// ── SEAT CLICK HANDLER ────────────────────────────────────────────────────
// If seat is booked → show details panel. If free → show booking form.
function handleSeatClick(sid) {
  const d = seatData[sid];
  if (d && d.booked) {
    openDetailsDrawer(sid);
  } else {
    openBookingDrawer(sid);
  }
}

// ── ROUTE SLIDER ───────────────────────────────────────────────────────────
function buildRouteSlider() {
  const track = document.getElementById("stop-track");
  if (!track) return;
  track.innerHTML = "";
  STOPS.forEach((name, i) => {
    const dot = document.createElement("div");
    dot.className = "route-stop" + (i <= currentStop ? " route-stop-passed" : "")
                  + (i === currentStop ? " route-stop-current" : "");
    dot.dataset.index = i;
    dot.innerHTML = `<span class="route-dot"></span><span class="route-label">${name}</span>`;
    dot.addEventListener("click", () => changeStop(i));
    track.appendChild(dot);
  });

  const pct = STOPS.length > 1 ? (currentStop / (STOPS.length - 1)) * 100 : 0;
  const progress = document.getElementById("route-progress");
  if (progress) progress.style.width = pct + "%";

  const slider = document.getElementById("stop-slider");
  if (slider) slider.value = currentStop;

  const lbl = document.getElementById("current-stop-label");
  if (lbl) lbl.textContent = STOPS[currentStop];
}

function changeStop(idx) {
  if (idx < 0 || idx >= STOPS.length) return;
  const prev = currentStop;
  currentStop = idx;
  buildRouteSlider();
  addLog(`Bus is now at stop: ${STOPS[idx]}`, "info");

  // Push new stop to Firebase so other clients stay in sync
  fetch(`${DB}/seat_monitor/route/currentStop.json`, {
    method:  "PUT",
    headers: { "Content-Type": "application/json" },
    body:    String(idx)
  }).catch(() => {});

  // Check boarding grace: auto-unallocate any booked seat whose fromStop
  // was <= (currentStop - NO_BOARD_GRACE) and sensor still = 0
  if (idx > prev) checkNoBoardUnallocate();
}

async function checkNoBoardUnallocate() {
  const unitsToCheck = sleeperMode ? ["seat_1"] : SENSOR_SEATS;
  unitsToCheck.forEach(async (sid) => {
    const d = seatData[sid];
    if (!d.booked || d.sensor === 1) return;
    const graceMissed = currentStop >= (d.fromStop + NO_BOARD_GRACE);
    if (!graceMissed) return;
    const graceName = STOPS[d.fromStop + NO_BOARD_GRACE - 1] || `stop ${d.fromStop + NO_BOARD_GRACE}`;
    addLog(`Auto-releasing ${sleeperMode ? "Berth 1-2" : `Seat ${seatLabel(sid)}`}: ${d.passenger || "passenger"} missed boarding by ${NO_BOARD_GRACE} stops (last grace: ${graceName})`, "alert");
    showToastAlert(sid, "missed");
    pushAlertCommand(sid, "Unauthorized Passenger");
    if (sleeperMode) pushAlertCommand("seat_2", "Unauthorized Passenger");
    const seatsToReset = sleeperMode ? ["seat_1", "seat_2"] : [sid];
    try {
      await Promise.all(seatsToReset.map(s =>
        fetch(`${DB}/seat_monitor/seats/${s}.json`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ booked: false, passenger: "", fromStop: 0, toStop: STOPS.length - 1, autoUnallocated: true })
        })
      ));
      setTimeout(() => {
        seatsToReset.forEach(s => pushAlertCommand(s, "Empty"));
      }, 3000);
    } catch (e) { console.error(e); }
  });
}

// ── MODE TOGGLE (Seater ↔ Sleeper) ────────────────────────────────────────────
function toggleMode() {
  sleeperMode = !sleeperMode;
  const busWrapper = document.querySelector(".bus-wrapper");
  if (busWrapper) busWrapper.classList.toggle("sleeper-mode", sleeperMode);

  const modeLabel = document.getElementById("bus-mode-label");
  if (modeLabel) modeLabel.textContent = sleeperMode
    ? "Sleeper Mode — Berth 1-2 requires both sensors ON"
    : "Seater Mode — individual sensor per seat";

  document.querySelectorAll(".mode-pill-opt").forEach(btn => {
    btn.classList.toggle("active",
      (btn.dataset.mode === "seater"  && !sleeperMode) ||
      (btn.dataset.mode === "sleeper" && sleeperMode)
    );
  });

  // Update the drawer seat picker label
  const sleeperHint = document.getElementById("sleeper-mode-hint");
  const seatPickRow = document.getElementById("seat-pick-row");
  if (sleeperHint) sleeperHint.style.display = sleeperMode ? "" : "none";
  if (seatPickRow) {
    if (sleeperMode) {
      // In sleeper mode the only bookable unit is the berth (stored on seat_1)
      document.querySelectorAll(".seat-pick-btn").forEach(b => b.style.display = "none");
      document.getElementById("pick-berth")?.removeAttribute("style");
    } else {
      document.querySelectorAll(".seat-pick-btn").forEach(b => b.style.display = "");
      document.getElementById("pick-berth")?.style.setProperty("display","none");
    }
  }

  addLog(`Mode switched to: ${sleeperMode ? "Sleeper (berth 1-2, both sensors required)" : "Seater (independent sensors)"}`, "info");
  buildGrid();         // rebuild grid to show/hide berth card
  SENSOR_SEATS.forEach(sid => { if (seatData[sid]) renderGridSeat(sid); });
  renderBerth();       // update berth card if visible
  updateStats();
}

// ── POLLING LOOP ───────────────────────────────────────────────────────────
async function pollSeats() {
  try {
    const [seatsRes, routeRes] = await Promise.all([
      fetch(SEATS_URL),
      fetch(ROUTE_URL)
    ]);
    if (!seatsRes.ok) throw new Error(`HTTP ${seatsRes.status}`);
    const data  = (await seatsRes.json()) || {};
    const route = routeRes.ok ? (await routeRes.json()) : null;

    // Sync current stop from Firebase if another client changed it
    if (route && typeof route.currentStop === "number" && route.currentStop !== currentStop) {
      currentStop = route.currentStop;
      buildRouteSlider();
    }

    if (sleeperMode) {
      // ── SLEEPER: treat as one berth unit, stored on seat_1 ──────────────
      const r1 = data.seat_1 || {};
      const rawS1 = r1.sensor === 1 ? 1 : 0;
      const rawS2 = (data.seat_2 || {}).sensor === 1 ? 1 : 0;
      const bothOn = rawS1 === 1 && rawS2 === 1;
      const booked    = r1.booked === true;
      const passenger = typeof r1.passenger === "string" ? r1.passenger : "";
      const fromStop  = typeof r1.fromStop === "number"  ? r1.fromStop  : 0;
      const toStop    = typeof r1.toStop   === "number"  ? r1.toStop    : STOPS.length - 1;
      const newStatus = calcStatus(bothOn ? 1 : 0, booked, fromStop);

      const prev = prevStates["seat_1"];
      if (prev && prev.status !== newStatus) {
        addLog(buildLogMessage("berth", newStatus, passenger, fromStop), logTypeFor(newStatus));
        pushAlertCommand("seat_1", newStatus);
        pushAlertCommand("seat_2", newStatus);
      }
      if (newStatus !== "Unauthorized Passenger" && newStatus !== "Early Boarding") {
        alertDismissed["seat_1"] = false;
      }
      seatData["seat_1"]   = { sensor: bothOn ? 1 : 0, rawS1, rawS2, booked, passenger, fromStop, toStop, status: newStatus };
      prevStates["seat_1"] = { ...seatData["seat_1"] };
      seatData["seat_2"]   = { sensor: rawS2, booked: false, passenger: "", fromStop: 0, toStop: STOPS.length-1, status: "Empty" };

      renderBerth();
      if ((newStatus === "Unauthorized Passenger" || newStatus === "Early Boarding") && !alertDismissed["seat_1"]) {
        showToastAlert("berth", newStatus === "Early Boarding" ? "early" : "unauthorized");
      }
    } else {
      SENSOR_SEATS.forEach((sid) => {
        const raw       = data[sid] || {};
        const sensor    = raw.sensor === 1 ? 1 : 0;
        const booked    = raw.booked === true;
        const passenger = typeof raw.passenger === "string" ? raw.passenger : "";
        const fromStop  = typeof raw.fromStop === "number"  ? raw.fromStop  : 0;
        const toStop    = typeof raw.toStop   === "number"  ? raw.toStop    : STOPS.length - 1;
        const newStatus = calcStatus(sensor, booked, fromStop);

        const prev = prevStates[sid];
        if (prev && prev.status !== newStatus) {
          addLog(buildLogMessage(sid, newStatus, passenger, fromStop), logTypeFor(newStatus));
          pushAlertCommand(sid, newStatus);
        }
        if (newStatus !== "Unauthorized Passenger" && newStatus !== "Early Boarding") alertDismissed[sid] = false;

        seatData[sid]   = { sensor, booked, passenger, fromStop, toStop, status: newStatus };
        prevStates[sid] = { sensor, booked, passenger, fromStop, toStop, status: newStatus };

        renderGridSeat(sid);
        updatePickerBtn(sid);

        if ((newStatus === "Unauthorized Passenger" || newStatus === "Early Boarding") && !alertDismissed[sid]) {
          showToastAlert(sid, newStatus === "Early Boarding" ? "early" : "unauthorized");
        }
      });
    }

    updateBadge("badge-firebase", "dot-firebase", true);
    updateStats();
  } catch (err) {
    updateBadge("badge-firebase", "dot-firebase", false);
    addLog("Firebase fetch error: " + err.message, "alert");
  }
}

// Push LED colour + buzzer command to Firebase for the ESP32 to read
function pushAlertCommand(sid, status) {
  const payload = alertPayload(status);
  fetch(`${DB}/seat_monitor/alerts/${sid}.json`, {
    method:  "PUT",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload)
  }).catch(() => {});
}

// ── RENDER: GRID SEAT ──────────────────────────────────────────────────────
function renderGridSeat(sid) {
  const el  = document.getElementById(`gs-${sid}`);
  const dot = document.getElementById(`dot-gs-${sid}`);
  if (!el) return;
  const { status, fromStop, toStop } = seatData[sid];

  if (status === "Unauthorized Passenger" || status === "Early Boarding") {
    if (!unauthSince[sid]) unauthSince[sid] = Date.now();
  } else {
    delete unauthSince[sid];
    const t = document.getElementById(`gs-timer-${sid}`);
    if (t) t.textContent = "";
  }

  el.classList.remove("gs-sensor-empty","gs-sensor-booked","gs-sensor-verified","gs-sensor-unauth","gs-sensor-early","gs-sensor-past");
  const cls = {
    "Empty":                  "gs-sensor-empty",
    "Passenger Not Seated":   "gs-sensor-booked",
    "Passenger Verified":     "gs-sensor-verified",
    "Unauthorized Passenger": "gs-sensor-unauth",
    "Early Boarding":         "gs-sensor-early"
  };
  el.classList.add(cls[status] || "gs-sensor-empty");

  // Grey out if bus has passed this booking's destination
  if (seatData[sid].booked && toStop < currentStop) {
    el.classList.add("gs-sensor-past");
  }

  const priceEl = el.querySelector(".gs-price");
  if (priceEl) {
    if (seatData[sid].booked) {
      priceEl.textContent = status === "Early Boarding"
        ? "EARLY!"
        : `${STOPS[fromStop].slice(0,3)}→${STOPS[toStop].slice(0,3)}`;
    } else {
      priceEl.textContent = status === "Empty" ? "IoT" : "ALERT";
    }
  }

  if (dot) dot.className = "gs-sensor-dot " + (
    status === "Passenger Verified"     ? "dot-green" :
    status === "Unauthorized Passenger" ? "dot-red"   :
    status === "Early Boarding"         ? "dot-red"   :
    status === "Passenger Not Seated"   ? "dot-blue"  : "dot-gray"
  );
}

// ── RENDER: SLEEPER BERTH CARD ─────────────────────────────────────────────
function renderBerth() {
  const el = document.getElementById("gs-berth");
  if (!el) return;
  const d = seatData["seat_1"];
  if (!d) return;
  const { status, fromStop, toStop, rawS1 = 0, rawS2 = 0 } = d;

  if (status === "Unauthorized Passenger" || status === "Early Boarding") {
    if (!unauthSince["seat_1"]) unauthSince["seat_1"] = Date.now();
  } else {
    delete unauthSince["seat_1"];
    const t = document.getElementById("gs-timer-seat_1");
    if (t) t.textContent = "";
  }

  el.classList.remove("gs-sensor-empty","gs-sensor-booked","gs-sensor-verified","gs-sensor-unauth","gs-sensor-early","gs-sensor-past");
  const cls = {
    "Empty":                  "gs-sensor-empty",
    "Passenger Not Seated":   "gs-sensor-booked",
    "Passenger Verified":     "gs-sensor-verified",
    "Unauthorized Passenger": "gs-sensor-unauth",
    "Early Boarding":         "gs-sensor-early"
  };
  el.classList.add(cls[status] || "gs-sensor-empty");
  if (d.booked && toStop < currentStop) el.classList.add("gs-sensor-past");

  const priceEl = document.getElementById("berth-price");
  if (priceEl) {
    priceEl.textContent = d.booked
      ? (status === "Early Boarding" ? "EARLY!" : `${STOPS[fromStop].slice(0,3)}→${STOPS[toStop].slice(0,3)}`)
      : (status === "Empty" ? "IoT" : "ALERT");
  }

  // Sensor indicator dots inside berth card
  const s1el = document.getElementById("berth-s1");
  const s2el = document.getElementById("berth-s2");
  if (s1el) s1el.className = "berth-s " + (rawS1 ? "berth-s-on" : "");
  if (s2el) s2el.className = "berth-s " + (rawS2 ? "berth-s-on" : "");

  const dot = document.getElementById("dot-gs-seat_1");
  if (dot) dot.className = "gs-sensor-dot " + (
    status === "Passenger Verified"     ? "dot-green" :
    status === "Unauthorized Passenger" ? "dot-red"   :
    status === "Early Boarding"         ? "dot-red"   :
    status === "Passenger Not Seated"   ? "dot-blue"  : "dot-gray"
  );

  // Sync the berth button in the drawer picker
  const pickBtn = document.getElementById("pick-berth");
  const pickSt  = document.getElementById("pick-status-berth");
  if (pickSt) pickSt.textContent = d.booked ? status : "Available";
  if (pickSt) pickSt.className = "pick-status " + (
    status === "Passenger Verified"     ? "ps-green" :
    status === "Unauthorized Passenger" ? "ps-red"   :
    status === "Passenger Not Seated"   ? "ps-blue"  : "ps-gray"
  );
  if (pickBtn) pickBtn.classList.toggle("pick-btn-booked", !!d.booked);
}

// ── RENDER: DRAWER PICKER ──────────────────────────────────────────────────
function updatePickerBtn(sid) {
  const statusEl = document.getElementById(`pick-status-${sid}`);
  const btn      = document.getElementById(`pick-${sid}`);
  if (!statusEl || !btn) return;
  const { status, booked } = seatData[sid];
  statusEl.textContent = booked ? status : "Available";
  statusEl.className   = "pick-status " + (
    status === "Passenger Verified"     ? "ps-green" :
    status === "Unauthorized Passenger" ? "ps-red"   :
    status === "Passenger Not Seated"   ? "ps-blue"  : "ps-gray"
  );
  btn.classList.toggle("pick-btn-booked", !!booked);
}

// ── STATS ──────────────────────────────────────────────────────────────────
function updateStats() {
  let booked = 0, verified = 0, unauth = 0;
  const units = sleeperMode ? ["seat_1"] : SENSOR_SEATS; // sleeper: 1 bookable unit
  units.forEach((id) => {
    const s = seatData[id]?.status;
    if (s === "Passenger Not Seated" || s === "Passenger Verified") booked++;
    if (s === "Passenger Verified")     verified++;
    if (s === "Unauthorized Passenger") unauth++;
  });
  const total = sleeperMode ? 1 : SENSOR_SEATS.length;
  _setText("stat-available", total - booked);
  _setText("stat-booked",    booked);
  _setText("stat-verified",  verified);
  _setText("stat-unauth",    unauth);
}

// ── BOOKING DRAWER ─────────────────────────────────────────────────────────
function openBookingDrawer(sid) {
  const overlay = document.getElementById("drawer-overlay");
  const drawer  = document.getElementById("booking-drawer");
  if (!overlay) return;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  drawer.classList.remove("drawer-details-mode");
  document.getElementById("drawer-h2").textContent = sleeperMode ? "Book Berth" : "Book a Seat";
  document.getElementById("view-booking").style.display = "";
  document.getElementById("view-details").style.display = "none";
  const sidToUse = sleeperMode ? "seat_1" : sid;
  if (sidToUse) selectSeat(sidToUse);
  populateStopDropdowns();
  document.getElementById("passenger-input")?.focus();
}

// Open drawer in DETAILS mode (booked seat clicked)
function openDetailsDrawer(sid) {
  const overlay = document.getElementById("drawer-overlay");
  const drawer  = document.getElementById("booking-drawer");
  if (!overlay) return;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  drawer.classList.add("open", "drawer-details-mode");
  document.getElementById("view-booking").style.display = "none";
  document.getElementById("view-details").style.display = "";
  selectedSeat = sid;

  const d = seatData[sid];
  const label = sleeperMode ? "Berth 1-2" : `Seat ${seatLabel(sid)}`;
  document.getElementById("drawer-h2").textContent = label + " — Details";

  _setText("detail-label",     label);
  _setText("detail-passenger", d?.passenger || "—");
  _setText("detail-from",      STOPS[d?.fromStop] || "—");
  _setText("detail-to",        STOPS[d?.toStop]   || "—");
  _setText("detail-status",    d?.status          || "—");

  const statusEl = document.getElementById("detail-status");
  if (statusEl) {
    statusEl.className = "detail-status-badge " + (
      d?.status === "Passenger Verified"     ? "dsb-green" :
      d?.status === "Unauthorized Passenger" ? "dsb-red"   :
      d?.status === "Early Boarding"         ? "dsb-orange" :
      d?.status === "Passenger Not Seated"   ? "dsb-blue"  : "dsb-gray"
    );
  }
  clearFeedback();
}

function closeBookingDrawer() {
  document.getElementById("drawer-overlay")?.classList.remove("open");
  document.getElementById("drawer-overlay")?.setAttribute("aria-hidden","true");
  document.getElementById("booking-drawer")?.classList.remove("open");
  clearFeedback();
}

function selectSeat(sid) {
  selectedSeat = sid;
  document.querySelectorAll(".seat-pick-btn, #pick-berth").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.seat === sid)
  );
  const input = document.getElementById("passenger-input");
  if (input) input.value = ""; // always blank for new booking

  // Pre-fill stops
  const from = document.getElementById("from-stop");
  const to   = document.getElementById("to-stop");
  if (from) from.value = currentStop;
  if (to)   to.value   = STOPS.length - 1;
  clearFeedback();
}

function populateStopDropdowns() {
  ["from-stop","to-stop"].forEach((elId, isTo) => {
    const sel = document.getElementById(elId);
    if (!sel) return;
    sel.innerHTML = "";
    STOPS.forEach((name, i) => {
      const opt  = document.createElement("option");
      opt.value  = i;
      opt.text   = `${i+1}. ${name}`;
      if (!isTo && i < currentStop) opt.disabled = true; // can't book from past stop
      sel.appendChild(opt);
    });
    sel.value = isTo ? (STOPS.length - 1) : currentStop;
  });
}

// ── BOOK ───────────────────────────────────────────────────────────────────
async function bookSeat() {
  const seatsToBook = sleeperMode ? ["seat_1", "seat_2"] : [selectedSeat];
  if (!selectedSeat) { showFeedback(sleeperMode ? "Select the berth." : "Please select Seat 1 or Seat 2.", "warn"); return; }
  const input    = document.getElementById("passenger-input");
  const name     = input?.value.trim() || "";
  const fromEl   = document.getElementById("from-stop");
  const toEl     = document.getElementById("to-stop");
  const fromStop = fromEl ? Number(fromEl.value) : currentStop;
  const toStop   = toEl   ? Number(toEl.value)   : STOPS.length - 1;

  if (!name) { showFeedback("Enter the passenger name.", "warn"); return; }
  if (fromStop >= toStop) { showFeedback("Destination must be after boarding stop.", "warn"); return; }
  if (fromStop < currentStop) { showFeedback(`Bus has already passed ${STOPS[fromStop]}.`, "warn"); return; }
  if (seatData["seat_1"]?.booked) {
    showFeedback(sleeperMode ? "Berth is already booked." : `Seat ${seatLabel(selectedSeat)} is already booked.`, "warn"); return;
  }
  try {
    await Promise.all(seatsToBook.map(sid =>
      fetch(`${DB}/seat_monitor/seats/${sid}.json`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ booked: true, passenger: name, fromStop, toStop, autoUnallocated: false })
      })
    ));
    const unitLabel = sleeperMode ? "Berth 1-2" : `Seat ${seatLabel(selectedSeat)}`;
    addLog(`${unitLabel} booked: ${name} | ${STOPS[fromStop]} → ${STOPS[toStop]}`, "info");
    showFeedback(`${unitLabel} booked for ${name} (${STOPS[fromStop]}→${STOPS[toStop]}) ✓`, "success");
    if (input) input.value = "";
  } catch (err) { showFeedback("Error: " + err.message, "error"); }
}

// ── CANCEL BOOKING ─────────────────────────────────────────────────────────
async function resetSeat() {
  if (!selectedSeat) { showFeedback("Select a seat first.", "warn"); return; }
  const seatsToReset = sleeperMode ? ["seat_1", "seat_2"] : [selectedSeat];
  const prev = seatData["seat_1"]?.passenger || "";
  try {
    await Promise.all(seatsToReset.map(sid =>
      fetch(`${DB}/seat_monitor/seats/${sid}.json`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ booked: false, passenger: "", fromStop: 0, toStop: STOPS.length-1, autoUnallocated: false })
      })
    ));
    seatsToReset.forEach(sid => pushAlertCommand(sid, "Empty"));
    seatsToReset.forEach(sid => { alertDismissed[sid] = false; });
    const unitLabel = sleeperMode ? "Berth 1-2" : `Seat ${seatLabel(selectedSeat)}`;
    addLog(`${unitLabel} booking cancelled${prev ? " (was: "+prev+")" : ""}`, "warn");
    showFeedback(`${unitLabel} booking cancelled.`, "warn");
    closeBookingDrawer();
  } catch (err) { showFeedback("Error: " + err.message, "error"); }
}

// ── TOAST ALERT ────────────────────────────────────────────────────────────
function showToastAlert(sid, type = "unauthorized") {
  const toast = document.getElementById("alert-toast");
  const msg   = document.getElementById("toast-msg");
  const title = document.getElementById("toast-title");
  if (!toast) return;
  const unitLabel = (sid === "berth" || sleeperMode) ? "Berth 1-2" : `Seat ${seatLabel(sid)}`;
  const messages = {
    unauthorized: `${unitLabel} is occupied without a valid booking!`,
    early:        `${unitLabel}: Passenger is seated before their boarding stop!`,
    missed:       `${unitLabel}: Booking auto-released — passenger missed boarding by ${NO_BOARD_GRACE} stops.`
  };
  const titles = {
    unauthorized: "Unauthorized Passenger",
    early:        "Early Boarding Alert",
    missed:       "Booking Auto-Released"
  };
  if (title) title.textContent = titles[type] || titles.unauthorized;
  if (msg)   msg.textContent   = messages[type] || messages.unauthorized;
  toast.className = "alert-toast visible" + (type === "missed" ? " toast-warn" : "");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(dismissToast, 8000);
}
function dismissToast() {
  document.getElementById("alert-toast")?.classList.remove("visible");
  SENSOR_SEATS.forEach((id) => {
    const s = seatData[id]?.status;
    if (s === "Unauthorized Passenger" || s === "Early Boarding") alertDismissed[id] = true;
  });
}

// ── BADGES ─────────────────────────────────────────────────────────────────
function updateBadge(bId, dId, online) {
  document.getElementById(dId)?.setAttribute("class","badge-dot "+(online?"dot-online":"dot-offline"));
  document.getElementById(bId)?.setAttribute("class","badge "    +(online?"badge-online":"badge-offline"));
}

// ── LOG ────────────────────────────────────────────────────────────────────
function addLog(msg, type = "info") {
  const body = document.getElementById("log-body");
  if (!body) return;
  const time  = new Date().toLocaleTimeString("en-US",{hour12:false});
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">[${time}]</span> <span>${escapeHtml(msg)}</span>`;
  body.insertBefore(entry, body.firstChild);
  while (body.children.length > 50) body.removeChild(body.lastChild);
}

// ── FEEDBACK ───────────────────────────────────────────────────────────────
let _ft;
function showFeedback(msg, type = "info") {
  const el = document.getElementById("feedback-msg");
  if (!el) return;
  el.textContent = msg;
  el.className   = `drawer-feedback fb-${type} fb-visible`;
  clearTimeout(_ft);
  _ft = setTimeout(() => { el.className = "drawer-feedback"; el.textContent = ""; }, 5000);
}
function clearFeedback() {
  const el = document.getElementById("feedback-msg");
  if (el) { el.className = "drawer-feedback"; el.textContent = ""; }
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function seatLabel(id)   { return id === "seat_1" ? "1" : "2"; }
function _setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function escapeHtml(s) {
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}
function buildLogMessage(sid, status, passenger, fromStop) {
  const n = sid === "berth" ? "Berth 1-2" : `Seat ${seatLabel(sid)}`;
  if (status === "Passenger Verified")      return `Passenger verified in ${n}${passenger ? " ("+passenger+")" : ""}`;
  if (status === "Unauthorized Passenger")  return `⚠ Unauthorized passenger in ${n}! LED=RED, Buzzer ON`;
  if (status === "Early Boarding")          return `⚠ Early boarding in ${n}! Seated before stop ${STOPS[fromStop] || fromStop} | LED=RED, Buzzer ON`;
  if (status === "Passenger Not Seated")    return `${n} booked but passenger not seated (LED=BLUE)`;
  return `${n} is now empty (LED=OFF)`;
}
function logTypeFor(status) {
  if (status === "Unauthorized Passenger") return "alert";
  if (status === "Early Boarding")         return "alert";
  if (status === "Passenger Verified")     return "success";
  if (status === "Passenger Not Seated")   return "warn";
  return "info";
}

// ── DOM READY ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  buildGrid();
  buildRouteSlider();
  updateBadge("badge-firebase","dot-firebase",false);
  updateBadge("badge-esp32",   "dot-esp32",   false);
  updateStats();
  addLog("Dashboard loaded. Fetching sensor data...", "info");

  // Route slider (range input)
  const rangeSlider = document.getElementById("stop-slider");
  if (rangeSlider) {
    rangeSlider.min   = 0;
    rangeSlider.max   = STOPS.length - 1;
    rangeSlider.value = currentStop;
    rangeSlider.addEventListener("input", (e) => changeStop(Number(e.target.value)));
  }

  // Mode toggle (Seater ↔ Sleeper)
  document.getElementById("mode-btn-seater")?.addEventListener("click",  () => { if (sleeperMode)  toggleMode(); });
  document.getElementById("mode-btn-sleeper")?.addEventListener("click", () => { if (!sleeperMode) toggleMode(); });

  document.getElementById("btn-open-booking")?.addEventListener("click", () => {
    // Header button: open booking if nothing is booked, else open details for already booked
    if (sleeperMode) {
      handleSeatClick("seat_1");
    } else {
      // Open booking for the first available seat, or details if all booked
      const free = SENSOR_SEATS.find(sid => !seatData[sid]?.booked);
      if (free) openBookingDrawer(free);
      else      openDetailsDrawer(SENSOR_SEATS[0]);
    }
  });
  document.getElementById("btn-close-drawer")?.addEventListener("click", closeBookingDrawer);
  document.getElementById("drawer-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeBookingDrawer();
  });
  document.querySelectorAll(".seat-pick-btn").forEach((btn) =>
    btn.addEventListener("click", () => selectSeat(btn.dataset.seat))
  );
  document.getElementById("btn-book")?.addEventListener("click", bookSeat);
  document.getElementById("btn-reset")?.addEventListener("click", resetSeat);
  document.getElementById("btn-cancel-detail")?.addEventListener("click", resetSeat);
  document.getElementById("btn-close-detail")?.addEventListener("click", closeBookingDrawer);
  document.getElementById("btn-clear-log")?.addEventListener("click", () => {
    const b = document.getElementById("log-body"); if (b) b.innerHTML = "";
  });
  document.getElementById("btn-dismiss-alert")?.addEventListener("click", dismissToast);
  document.getElementById("passenger-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") bookSeat();
  });

  // Validate from/to stop selection
  document.getElementById("from-stop")?.addEventListener("change", () => {
    const from = document.getElementById("from-stop");
    const to   = document.getElementById("to-stop");
    if (to && Number(from.value) >= Number(to.value)) to.value = Number(from.value) + 1;
  });

  pollSeats();
  setInterval(pollSeats, POLL_MS);

  // Unauthorized duration ticker (every second)
  setInterval(() => {
    SENSOR_SEATS.forEach((id) => {
      if (!unauthSince[id]) return;
      const el = document.getElementById(`gs-timer-${id}`);
      if (!el) return;
      const secs = Math.floor((Date.now() - unauthSince[id]) / 1000);
      el.textContent = `${String(Math.floor(secs/60)).padStart(2,"0")}:${String(secs%60).padStart(2,"0")}`;
    });
  }, 1000);
});
