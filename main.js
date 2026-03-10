/**
 * Smart Bus Seat Monitor — Web Dashboard  v4.0
 * No Firebase SDK · No API key · Plain fetch() REST calls
 * Same REST endpoint the ESP32 firmware writes to.
 */

// ── FIREBASE REST BASE ────────────────────────────────────────────────────
const DB        = "https://seat-pressure-monitoring-default-rtdb.asia-southeast1.firebasedatabase.app";
const SEATS_URL = `${DB}/seat_monitor/seats.json`;

// ── CONSTANTS ────────────────────────────────────────────────────────────
const TOTAL_SEATS  = 40;
const SENSOR_SEATS = ["seat_1", "seat_2"];
const SOLD_SEATS   = new Set([3,4,7,9,10,13,14,18,19,22,25,26,30,32,33,37,38]);
const POLL_MS      = 2000;

// ── STATE ────────────────────────────────────────────────────────────────
let seatData = {
  seat_1: { sensor: 0, booked: false, passenger: "", status: "Empty" },
  seat_2: { sensor: 0, booked: false, passenger: "", status: "Empty" }
};
let prevStates     = {};
let alertDismissed = {};
let selectedSeat   = null;
let unauthSince    = {};  // tracks when each seat entered Unauthorized state

// ── STATUS ENGINE ─────────────────────────────────────────────────────────
function calcStatus(sensor, booked) {
  if (sensor === 1 &&  booked) return "Passenger Verified";
  if (sensor === 1 && !booked) return "Unauthorized Passenger";
  if (sensor === 0 &&  booked) return "Passenger Not Seated";
  return "Empty";
}

// ── BUILD SEAT GRID ───────────────────────────────────────────────────────
function buildGrid() {
  const colLeft  = document.getElementById("col-left");
  const colRight = document.getElementById("col-right");
  if (!colLeft || !colRight) return;
  colLeft.innerHTML  = "";
  colRight.innerHTML = "";
  for (let row = 0; row < 10; row++) {
    colLeft.appendChild(makeRow(row*2+1,  row*2+2));
    colRight.appendChild(makeRow(row*2+21, row*2+22));
  }
  SENSOR_SEATS.forEach((seatId) => {
    document.getElementById(`gs-${seatId}`)
      ?.addEventListener("click", () => openBookingDrawer(seatId));
  });
}

function makeRow(numA, numB) {
  const row = document.createElement("div");
  row.className = "seat-grid-row";
  row.appendChild(makeSeatEl(numA));
  row.appendChild(makeSeatEl(numB));
  return row;
}

function makeSeatEl(num) {
  const seatId   = `seat_${num}`;
  const isSensor = SENSOR_SEATS.includes(seatId);
  const isSold   = SOLD_SEATS.has(num);
  const el       = document.createElement("div");
  el.className   = "gs " + (isSensor ? "gs-sensor gs-sensor-empty"
                           : isSold   ? "gs-sold"
                           :            "gs-available");
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
    ${isSensor ? `<span class="gs-sensor-dot dot-gray" id="dot-gs-${seatId}"></span><span class="gs-timer" id="gs-timer-${seatId}"></span>` : ""}
  `;
  return el;
}

function getPrice(num) {
  return num <= 20 ? (num % 2 === 1 ? "1079" : "494")
                   : (num % 2 === 1 ? "989"  : "719");
}

// ── POLLING LOOP ──────────────────────────────────────────────────────────
async function pollSeats() {
  try {
    const res = await fetch(SEATS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) || {};

    SENSOR_SEATS.forEach((seatId) => {
      const raw       = data[seatId] || {};
      const sensor    = raw.sensor === 1 ? 1 : 0;
      const booked    = raw.booked === true;
      const passenger = typeof raw.passenger === "string" ? raw.passenger : "";
      const newStatus = calcStatus(sensor, booked);

      const prev = prevStates[seatId];
      if (prev && prev.status !== newStatus) {
        addLog(buildLogMessage(seatId, newStatus, passenger), logTypeFor(newStatus));
      }
      if (newStatus !== "Unauthorized Passenger") alertDismissed[seatId] = false;

      seatData[seatId]   = { sensor, booked, passenger, status: newStatus };
      prevStates[seatId] = { sensor, booked, passenger, status: newStatus };

      renderGridSeat(seatId);
      updatePickerBtn(seatId);

      if (newStatus === "Unauthorized Passenger" && !alertDismissed[seatId]) {
        showToastAlert(seatId);
      }
    });

    updateBadge("badge-firebase", "dot-firebase", true);
    updateStats();
  } catch (err) {
    updateBadge("badge-firebase", "dot-firebase", false);
    addLog("Firebase fetch error: " + err.message, "alert");
  }
}

// ── RENDER: GRID SEAT ─────────────────────────────────────────────────────
function renderGridSeat(seatId) {
  const el  = document.getElementById(`gs-${seatId}`);
  const dot = document.getElementById(`dot-gs-${seatId}`);
  if (!el) return;
  const { status } = seatData[seatId];
  // Track unauthorized occupancy start time
  if (status === "Unauthorized Passenger") {
    if (!unauthSince[seatId]) unauthSince[seatId] = Date.now();
  } else {
    delete unauthSince[seatId];
    const timerEl = document.getElementById(`gs-timer-${seatId}`);
    if (timerEl) timerEl.textContent = "";
  }

  el.classList.remove("gs-sensor-empty","gs-sensor-booked","gs-sensor-verified","gs-sensor-unauth");
  const cls = {
    "Empty":                  "gs-sensor-empty",
    "Passenger Not Seated":   "gs-sensor-booked",
    "Passenger Verified":     "gs-sensor-verified",
    "Unauthorized Passenger": "gs-sensor-unauth"
  };
  el.classList.add(cls[status] || "gs-sensor-empty");
  const priceEl = el.querySelector(".gs-price");
  if (priceEl) priceEl.textContent =
    status === "Empty"                ? "IoT"      :
    status === "Passenger Not Seated" ? "Booked"   :
    status === "Passenger Verified"   ? "Verified" : "ALERT";
  if (dot) dot.className = "gs-sensor-dot " + (
    status === "Passenger Verified"     ? "dot-green" :
    status === "Unauthorized Passenger" ? "dot-red"   :
    status === "Passenger Not Seated"   ? "dot-blue"  : "dot-gray"
  );
}

// ── RENDER: DRAWER PICKER BUTTON ──────────────────────────────────────────
function updatePickerBtn(seatId) {
  const statusEl = document.getElementById(`pick-status-${seatId}`);
  const btn      = document.getElementById(`pick-${seatId}`);
  if (!statusEl || !btn) return;
  const { status, booked } = seatData[seatId];
  statusEl.textContent = booked ? status : "Available";
  statusEl.className   = "pick-status " + (
    status === "Passenger Verified"     ? "ps-green" :
    status === "Unauthorized Passenger" ? "ps-red"   :
    status === "Passenger Not Seated"   ? "ps-blue"  : "ps-gray"
  );
  btn.classList.toggle("pick-btn-booked", !!booked);
}

// ── STATS STRIP ───────────────────────────────────────────────────────────
function updateStats() {
  let booked = 0, verified = 0, unauth = 0;
  SENSOR_SEATS.forEach((id) => {
    const s = seatData[id]?.status;
    if (s === "Passenger Not Seated" || s === "Passenger Verified") booked++;
    if (s === "Passenger Verified")     verified++;
    if (s === "Unauthorized Passenger") unauth++;
  });
  _setText("stat-available", SENSOR_SEATS.length - booked);
  _setText("stat-booked",    booked);
  _setText("stat-verified",  verified);
  _setText("stat-unauth",    unauth);
}

// ── BOOKING DRAWER ────────────────────────────────────────────────────────
function openBookingDrawer(seatId) {
  const overlay = document.getElementById("drawer-overlay");
  const drawer  = document.getElementById("booking-drawer");
  if (!overlay) return;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  if (seatId) selectSeat(seatId);
  document.getElementById("passenger-input")?.focus();
}
function closeBookingDrawer() {
  document.getElementById("drawer-overlay")?.classList.remove("open");
  document.getElementById("drawer-overlay")?.setAttribute("aria-hidden", "true");
  document.getElementById("booking-drawer")?.classList.remove("open");
  clearFeedback();
}
function selectSeat(seatId) {
  selectedSeat = seatId;
  document.querySelectorAll(".seat-pick-btn").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.seat === seatId)
  );
  const input = document.getElementById("passenger-input");
  if (input) input.value = seatData[seatId]?.passenger || "";
  clearFeedback();
}

// ── BOOK ──────────────────────────────────────────────────────────────────
async function bookSeat() {
  if (!selectedSeat) { showFeedback("Please select Seat 1 or Seat 2.", "warn"); return; }
  const input = document.getElementById("passenger-input");
  const name  = input?.value.trim() || "";
  if (!name) { showFeedback("Enter the passenger name.", "warn"); return; }
  if (seatData[selectedSeat]?.booked) {
    showFeedback(`Seat ${seatLabel(selectedSeat)} is already booked.`, "warn"); return;
  }
  try {
    const res = await fetch(`${DB}/seat_monitor/seats/${selectedSeat}.json`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ booked: true, passenger: name })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    addLog(`Seat ${seatLabel(selectedSeat)} booked by ${name}`, "info");
    showFeedback(`Seat ${seatLabel(selectedSeat)} booked for ${name} \u2713`, "success");
    if (input) input.value = "";
  } catch (err) { showFeedback("Error: " + err.message, "error"); }
}

// ── CANCEL BOOKING ────────────────────────────────────────────────────────
async function resetSeat() {
  if (!selectedSeat) { showFeedback("Select a seat first.", "warn"); return; }
  const prev = seatData[selectedSeat]?.passenger || "";
  try {
    const res = await fetch(`${DB}/seat_monitor/seats/${selectedSeat}.json`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ booked: false, passenger: "" })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    addLog(`Seat ${seatLabel(selectedSeat)} booking cancelled${prev ? " (was: "+prev+")" : ""}`, "warn");
    showFeedback(`Seat ${seatLabel(selectedSeat)} booking cancelled.`, "warn");
    alertDismissed[selectedSeat] = false;
  } catch (err) { showFeedback("Error: " + err.message, "error"); }
}

// ── TOAST ALERT ───────────────────────────────────────────────────────────
function showToastAlert(seatId) {
  const toast = document.getElementById("alert-toast");
  const msg   = document.getElementById("toast-msg");
  if (!toast) return;
  if (msg) msg.textContent = `Seat ${seatLabel(seatId)} is occupied without a valid booking!`;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(dismissToast, 8000);
}
function dismissToast() {
  document.getElementById("alert-toast")?.classList.remove("visible");
  SENSOR_SEATS.forEach((id) => {
    if (seatData[id]?.status === "Unauthorized Passenger") alertDismissed[id] = true;
  });
}

// ── BADGES ────────────────────────────────────────────────────────────────
function updateBadge(bId, dId, online) {
  document.getElementById(dId)?.setAttribute("class", "badge-dot " + (online ? "dot-online" : "dot-offline"));
  document.getElementById(bId)?.setAttribute("class", "badge "     + (online ? "badge-online" : "badge-offline"));
}

// ── LOG ───────────────────────────────────────────────────────────────────
function addLog(msg, type = "info") {
  const body = document.getElementById("log-body");
  if (!body) return;
  const time  = new Date().toLocaleTimeString("en-US", { hour12: false });
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">[${time}]</span> <span>${escapeHtml(msg)}</span>`;
  body.insertBefore(entry, body.firstChild);
  while (body.children.length > 50) body.removeChild(body.lastChild);
}

// ── FEEDBACK ──────────────────────────────────────────────────────────────
let _ft;
function showFeedback(msg, type = "info") {
  const el = document.getElementById("feedback-msg");
  if (!el) return;
  el.textContent = msg;
  el.className   = `drawer-feedback fb-${type} fb-visible`;
  clearTimeout(_ft);
  _ft = setTimeout(() => { el.className = "drawer-feedback"; el.textContent = ""; }, 4000);
}
function clearFeedback() {
  const el = document.getElementById("feedback-msg");
  if (el) { el.className = "drawer-feedback"; el.textContent = ""; }
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function seatLabel(id)   { return id === "seat_1" ? "1" : "2"; }
function _setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function escapeHtml(s) {
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}
function buildLogMessage(seatId, status, passenger) {
  const n = seatLabel(seatId);
  if (status === "Passenger Verified")      return `Passenger verified in Seat ${n}${passenger ? " ("+passenger+")" : ""}`;
  if (status === "Unauthorized Passenger")  return `WARNING: Unauthorized passenger in Seat ${n}!`;
  if (status === "Passenger Not Seated")    return `Seat ${n} booked but passenger not seated yet`;
  return `Seat ${n} is now empty`;
}
function logTypeFor(status) {
  if (status === "Unauthorized Passenger") return "alert";
  if (status === "Passenger Verified")     return "success";
  if (status === "Passenger Not Seated")   return "warn";
  return "info";
}

// ── DOM READY ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  buildGrid();
  updateBadge("badge-firebase", "dot-firebase", false);
  updateBadge("badge-esp32",    "dot-esp32",    false);
  updateStats();
  addLog("Dashboard loaded. Fetching sensor data...", "info");

  document.getElementById("btn-open-booking")?.addEventListener("click", () => openBookingDrawer(null));
  document.getElementById("btn-close-drawer")?.addEventListener("click", closeBookingDrawer);
  document.getElementById("drawer-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeBookingDrawer();
  });
  document.querySelectorAll(".seat-pick-btn").forEach((btn) =>
    btn.addEventListener("click", () => selectSeat(btn.dataset.seat))
  );
  document.getElementById("btn-book")?.addEventListener("click", bookSeat);
  document.getElementById("btn-reset")?.addEventListener("click", resetSeat);
  document.getElementById("btn-clear-log")?.addEventListener("click", () => {
    const b = document.getElementById("log-body"); if (b) b.innerHTML = "";
  });
  document.getElementById("btn-dismiss-alert")?.addEventListener("click", dismissToast);
  document.getElementById("passenger-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") bookSeat();
  });

  pollSeats();
  setInterval(pollSeats, POLL_MS);

  // Update unauthorized duration display every second
  setInterval(() => {
    SENSOR_SEATS.forEach((id) => {
      if (!unauthSince[id]) return;
      const el = document.getElementById(`gs-timer-${id}`);
      if (!el) return;
      const secs = Math.floor((Date.now() - unauthSince[id]) / 1000);
      const m = String(Math.floor(secs / 60)).padStart(2, "0");
      const s = String(secs % 60).padStart(2, "0");
      el.textContent = m + ":" + s;
    });
  }, 1000);
});
