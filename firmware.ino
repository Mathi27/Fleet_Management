#include <WiFi.h>
#include <HTTPClient.h>

#define WIFI_SSID "ANISH"
#define WIFI_PASSWORD "12345678"

#define SEAT1_PIN 34
#define SEAT2_PIN 35

#define PRESSURE_THRESHOLD 1000
#define UPDATE_INTERVAL 2000

String firebaseSeat1 = "https://seat-pressure-monitoring-default-rtdb.asia-southeast1.firebasedatabase.app/seat_monitor/seats/seat_1/sensor.json";
String firebaseSeat2 = "https://seat-pressure-monitoring-default-rtdb.asia-southeast1.firebasedatabase.app/seat_monitor/seats/seat_2/sensor.json";

unsigned long lastUpdate = 0;

void connectWiFi()
{
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting");

  while (WiFi.status() != WL_CONNECTED)
  {
    Serial.print(".");
    delay(500);
  }

  Serial.println();
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void sendToFirebase(String url, int value)
{
  if (WiFi.status() == WL_CONNECTED)
  {
    HTTPClient http;

    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    String data = String(value);

    int httpResponseCode = http.PUT(data);

    Serial.print("HTTP Response: ");
    Serial.println(httpResponseCode);

    http.end();
  }
}

void setup()
{
  Serial.begin(115200);

  connectWiFi();
}

void loop()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    connectWiFi();
  }

  unsigned long now = millis();

  if (now - lastUpdate < UPDATE_INTERVAL) return;

  lastUpdate = now;

  int raw1 = analogRead(SEAT1_PIN);
  int raw2 = analogRead(SEAT2_PIN);

  int seat1 = raw1 >= PRESSURE_THRESHOLD ? 1 : 0;
  int seat2 = raw2 >= PRESSURE_THRESHOLD ? 1 : 0;

  Serial.print("Seat1: ");
  Serial.print(raw1);
  Serial.print("  Seat2: ");
  Serial.println(raw2);

  sendToFirebase(firebaseSeat1, seat1);
  sendToFirebase(firebaseSeat2, seat2);
}