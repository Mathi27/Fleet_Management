#include <WiFi.h>
#include <HTTPClient.h>
#define WIFI_SSID "ssid podanum."
#define WIFI_PASSWORD "password podanum"
String firebaseHost = "----enter api key-----";
const int sensorPin = 34;
const int Led = 2;
const int Buzzer = 4;

void setup() {

  Serial.begin(115200);

  pinMode(Led, OUTPUT);
  pinMode(Buzzer, OUTPUT);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting");

  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(500);
  }

  Serial.println();
  Serial.println("WiFi Connected");
}

void loop() {

  int value = analogRead(sensorPin);

  Serial.print("Pressure Value: ");
  Serial.println(value);

  String status;

  if(value > 1000){
    digitalWrite(Led,HIGH);
    digitalWrite(Buzzer,HIGH);
    status = "Person Present";
  }
  else{
    digitalWrite(Led,LOW);
    digitalWrite(Buzzer,LOW);
    status = "No Person";
  }

  if(WiFi.status()== WL_CONNECTED){

    HTTPClient http;

    String url = firebaseHost + "/seat_monitor.json";

    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    String json = "{\"pressure_value\":" + String(value) + ",\"status\":\"" + status + "\"}";

    int httpResponseCode = http.PUT(json);
    Serial.print("Firebase Response: ");
    Serial.println(httpResponseCode);
    http.end();
  }
  delay(1000);
}