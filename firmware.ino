#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ── WIFI ──────────────────────────────────────────────────────────
#define WIFI_SSID     " "
#define WIFI_PASSWORD " "

// ── PINS ──────────────────────────────────────────────────────────
#define SEAT1_PIN 34
#define SEAT2_PIN 35

// RGB LED 1 (seat 1) – common-cathode
#define LED1_R 25
#define LED1_G 26
#define LED1_B 27

// RGB LED 2 (seat 2) – common-cathode
#define LED2_R 14
#define LED2_G 12
#define LED2_B 13

// Buzzer (active, low-trigger or use tone())
#define BUZZER_PIN 32

// ── THRESHOLDS / TIMING ───────────────────────────────────────────
#define PRESSURE_THRESHOLD 1000
#define SENSOR_INTERVAL_MS 2000   // sensor read + push every 2 s
#define ALERT_INTERVAL_MS  1000   // poll alert commands every 1 s

// ── FIREBASE BASE URL ─────────────────────────────────────────────
const String DB = "https://seat-pressure-monitoring-default-rtdb.asia-southeast1.firebasedatabase.app";

unsigned long lastSensor = 0;
unsigned long lastAlert  = 0;

// ──────────────────────────────────────────────────────────────────
// WiFi
// ──────────────────────────────────────────────────────────────────
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) { Serial.print("."); delay(500); }
  Serial.println();
  Serial.print("IP: "); Serial.println(WiFi.localIP());
}

// ──────────────────────────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────────────────────────
void httpPUT(const String& url, const String& body) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int code = http.PUT(body);
  Serial.printf("PUT %s -> %d\n", url.c_str(), code);
  http.end();
}

String httpGET(const String& url) {
  if (WiFi.status() != WL_CONNECTED) return "null";
  HTTPClient http;
  http.begin(url);
  int code = http.GET();
  String payload = "null";
  if (code == 200) payload = http.getString();
  http.end();
  return payload;
}

// ──────────────────────────────────────────────────────────────────
// LED helpers  (color: 0=off 1=green 2=blue 3=red)
// ──────────────────────────────────────────────────────────────────
void setLED(uint8_t r, uint8_t g, uint8_t b, int color) {
  // common-cathode: HIGH = on
  bool R = false, G = false, B = false;
  if      (color == 1) G = true;          // green
  else if (color == 2) B = true;          // blue
  else if (color == 3) { R = true; }      // red
  // color 0 = all off
  digitalWrite(r, R);
  digitalWrite(g, G);
  digitalWrite(b, B);
}

void setBuzzer(bool on) {
  if (on) tone(BUZZER_PIN, 1000);   // 1 kHz alert tone
  else    noTone(BUZZER_PIN);
}

// ──────────────────────────────────────────────────────────────────
// setup
// ──────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  pinMode(LED1_R, OUTPUT); pinMode(LED1_G, OUTPUT); pinMode(LED1_B, OUTPUT);
  pinMode(LED2_R, OUTPUT); pinMode(LED2_G, OUTPUT); pinMode(LED2_B, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // Start with everything off
  setLED(LED1_R, LED1_G, LED1_B, 0);
  setLED(LED2_R, LED2_G, LED2_B, 0);
  setBuzzer(false);

  connectWiFi();
}

// ──────────────────────────────────────────────────────────────────
// loop
// ──────────────────────────────────────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();

  unsigned long now = millis();

  // ── Sensor push (every 2 s) ────────────────────────────────────
  if (now - lastSensor >= SENSOR_INTERVAL_MS) {
    lastSensor = now;

    int raw1 = analogRead(SEAT1_PIN);
    int raw2 = analogRead(SEAT2_PIN);
    int s1   = raw1 >= PRESSURE_THRESHOLD ? 1 : 0;
    int s2   = raw2 >= PRESSURE_THRESHOLD ? 1 : 0;

    Serial.printf("Seat1 raw=%d val=%d | Seat2 raw=%d val=%d\n", raw1, s1, raw2, s2);

    httpPUT(DB + "/seat_monitor/seats/seat_1/sensor.json", String(s1));
    httpPUT(DB + "/seat_monitor/seats/seat_2/sensor.json", String(s2));
    httpPUT(DB + "/seat_monitor/esp32/lastSeen.json",       String(now));
  }

  // ── Alert commands poll (every 1 s) ────────────────────────────
  if (now - lastAlert >= ALERT_INTERVAL_MS) {
    lastAlert = now;

    // Web dashboard writes seat_monitor/alerts/{seat_1,seat_2}
    // Each value: { "led": 0-3, "buzzer": true/false }
    String a1 = httpGET(DB + "/seat_monitor/alerts/seat_1.json");
    String a2 = httpGET(DB + "/seat_monitor/alerts/seat_2.json");

    // Parse with ArduinoJson
    StaticJsonDocument<128> doc1, doc2;
    int led1 = 0; bool buz1 = false;
    int led2 = 0; bool buz2 = false;

    if (deserializeJson(doc1, a1) == DeserializationError::Ok) {
      led1 = doc1["led"]    | 0;
      buz1 = doc1["buzzer"] | false;
    }
    if (deserializeJson(doc2, a2) == DeserializationError::Ok) {
      led2 = doc2["led"]    | 0;
      buz2 = doc2["buzzer"] | false;
    }

    setLED(LED1_R, LED1_G, LED1_B, led1);
    setLED(LED2_R, LED2_G, LED2_B, led2);
    setBuzzer(buz1 || buz2);   // buzzer on if either seat signals alert

    Serial.printf("Alerts -> S1 led=%d buz=%d | S2 led=%d buz=%d\n",
                  led1, (int)buz1, led2, (int)buz2);
  }
}
