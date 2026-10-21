// Физическая кнопка «Взять номер» для ВетОчереди.
// Плата: любая ESP32. Кнопка между GPIO 4 и GND, светодиод — встроенный (GPIO 2).
// По нажатию отправляет POST /api/button/<ключ>; номер появляется на табло и на сайте.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

const char* WIFI_SSID = "ClinicWiFi";
const char* WIFI_PASS = "password";
// Ссылку с ключом берите в разделе «Настройки и кнопки» кабинета клиники.
const char* BUTTON_URL = "https://your-server.example/api/button/PUT_BUTTON_KEY_HERE";

const int BUTTON_PIN = 4;
const int LED_PIN = 2;

void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(ms);
    digitalWrite(LED_PIN, LOW); delay(ms);
  }
}

void connectWifi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { blink(1, 100); }
}

bool pressButton() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  WiFiClientSecure client;
  // Для простоты сертификат не проверяется. В продакшене укажите корневой сертификат:
  // client.setCACert(ROOT_CA);
  client.setInsecure();
  HTTPClient http;
  http.begin(client, BUTTON_URL);
  int code = http.POST("");
  Serial.printf("HTTP %d: %s\n", code, http.getString().c_str()); // {"number":"007",...}
  http.end();
  return code == 200;
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  connectWifi();
  blink(3, 80);
}

void loop() {
  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(30); // антидребезг
    if (digitalRead(BUTTON_PIN) == LOW) {
      if (pressButton()) blink(1, 600); else blink(5, 80);
      while (digitalRead(BUTTON_PIN) == LOW) delay(10);
    }
  }
}
