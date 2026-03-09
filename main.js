// --- STATE MANAGEMENT ---
let currentLocIdx = 0;
let selectedSeatId = null;
const TOTAL_SEATS = 20;

// Initialize 20 seats
let seats = Array.from({ length: TOTAL_SEATS }, (_, i) => ({
    id: i + 1,
    isBooked: false,
    isOccupied: false,
    boardingLocIdx: 1, // Default Saravanampati
    status: 'AVAILABLE'
}));

const locNames = ["Gandhipuram", "Saravanampati", "Erode", "Salem", "Chennai"];

// --- DOM ELEMENTS ---
const container = document.getElementById('seats-container');
const logContainer = document.getElementById('log-container');
const controlsDiv = document.getElementById('seat-controls');

const locSelect = document.getElementById('current-location');
const boardSelect = document.getElementById('boarding-point');
const toggleBooked = document.getElementById('toggle-booked');
const toggleOccupied = document.getElementById('toggle-occupied');

// --- FIREBASE PREPARATION STUBS ---
/* When you connect RTDB, you will listen to a path like `bus_1/seats`.
  Instead of manual toggles, Firebase will call a function like this:
  
  onValue(ref(db, 'bus_1/seats'), (snapshot) => {
      const data = snapshot.val();
      // Map Firebase data to our 'seats' array
      seats.forEach(seat => {
          if(data[`seat_${seat.id}`]) {
              seat.isOccupied = data[`seat_${seat.id}`].sensor_state === 'HIGH';
          }
      });
      updateAllSeats();
  });
*/

// --- CORE LOGIC ---
function initBusLayout() {
    container.innerHTML = '';
    seats.forEach((seat, index) => {
        const seatDiv = document.createElement('div');
        seatDiv.className = `seat ${getSeatClasses(seat)}`;
        seatDiv.innerText = seat.id;
        seatDiv.id = `seat-${seat.id}`;
        
        // Event Listener for selection
        seatDiv.addEventListener('click', () => selectSeat(seat.id));
        
        container.appendChild(seatDiv);

        // Add aisle gap every 2 seats
        if ((index + 1) % 4 === 2) {
            const aisle = document.createElement('div');
            container.appendChild(aisle);
        }
    });
}

function getSeatClasses(seat) {
    if (seat.status === 'ALERT') return 'alert';
    if (seat.isOccupied) return 'occupied';
    if (seat.isBooked) return 'booked';
    return '';
}

function evaluateLogic(seat) {
    let oldStatus = seat.status;
    
    if (seat.isBooked && seat.isOccupied) {
        if (currentLocIdx < seat.boardingLocIdx) {
            seat.status = 'ALERT';
            if(oldStatus !== 'ALERT') logEvent(`🚨 ALERT: Seat ${seat.id} occupied BEFORE boarding point (${locNames[seat.boardingLocIdx]}).`, 'alert');
        } else {
            seat.status = 'VALID';
            if(oldStatus !== 'VALID') logEvent(`✅ Valid Boarding: Passenger in Seat ${seat.id}. Timer started.`, 'valid');
        }
    } else if (!seat.isBooked && seat.isOccupied) {
        seat.status = 'ALERT';
        if(oldStatus !== 'ALERT') logEvent(`🚨 CRITICAL: Unauthorized passenger in unbooked Seat ${seat.id}.`, 'alert');
    } else if (seat.isBooked && !seat.isOccupied && currentLocIdx > seat.boardingLocIdx) {
        seat.status = 'NO_SHOW';
        if(oldStatus !== 'NO_SHOW') logEvent(`⚠️ FLAG: Seat ${seat.id} booked but empty after boarding point.`, '');
    } else {
        seat.status = 'AVAILABLE';
    }
}

function updateAllSeats() {
    seats.forEach(seat => evaluateLogic(seat));
    initBusLayout();
    if (selectedSeatId) selectSeat(selectedSeatId);
}

function selectSeat(id) {
    selectedSeatId = id;
    const seat = seats.find(s => s.id === id);
    
    document.querySelectorAll('.seat').forEach(el => el.classList.remove('selected'));
    document.getElementById(`seat-${id}`).classList.add('selected');
    
    controlsDiv.style.opacity = '1';
    controlsDiv.style.pointerEvents = 'auto';
    document.getElementById('selected-seat-label').innerText = `Seat ${id}`;
    
    // Populate form
    boardSelect.value = seat.boardingLocIdx;
    toggleBooked.checked = seat.isBooked;
    toggleOccupied.checked = seat.isOccupied;
}

function updateSeatData() {
    if (!selectedSeatId) return;
    const seat = seats.find(s => s.id === selectedSeatId);
    
    const wasOccupied = seat.isOccupied;
    
    seat.boardingLocIdx = parseInt(boardSelect.value);
    seat.isBooked = toggleBooked.checked;
    seat.isOccupied = toggleOccupied.checked;

    if (!wasOccupied && seat.isOccupied) logEvent(`Hardware: Sensor on Seat ${seat.id} triggered HIGH.`, '');
    if (wasOccupied && !seat.isOccupied) logEvent(`Hardware: Sensor on Seat ${seat.id} triggered LOW.`, '');

    updateAllSeats();
}

function updateBusLocation() {
    currentLocIdx = parseInt(locSelect.value);
    logEvent(`📍 GPS Update: Bus arrived at ${locNames[currentLocIdx]}`, 'valid');
    updateAllSeats();
}

function logEvent(msg, type) {
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
    const el = document.createElement('div');
    el.className = `log-entry ${type ? 'log-' + type : ''}`;
    el.innerHTML = `<strong>[${time}]</strong> ${msg}`;
    logContainer.prepend(el);
}

// --- EVENT LISTENERS ---
locSelect.addEventListener('change', updateBusLocation);
boardSelect.addEventListener('change', updateSeatData);
toggleBooked.addEventListener('change', updateSeatData);
toggleOccupied.addEventListener('change', updateSeatData);

// --- INITIALIZATION ---
initBusLayout();