// EMS Link v1 device for Motion Studio, over USB serial at 115200 baud.
//
// Reads:
//   vc   voltage on the 555 timing capacitor C1, on A0 through a 2:1 divider (two 10 kOhm)
//   rpm  shaft speed from a hall or slotted optical sensor on pin 2, PULSES_PER_REV per turn
// Commands (only when Studio is armed in Assisted mode):
//   pwm  0-255 duty on pin 9, for a motor driver such as an L298N or a MOSFET stage
//
// Safety: commands outside 0-255 or faster than RATE are rejected, and if no command or
// heartbeat arrives for WATCHDOG_MS the PWM output returns to 0 by itself. Your hardware stop
// must still cut motor power without this board. Tie the Arduino GND to the circuit ground.

const uint8_t CAP_PIN = A0;
const float DIVIDER = 2.0;
const float VREF = 5.0;
const uint8_t PULSE_PIN = 2;
const uint8_t PULSES_PER_REV = 1;
const uint8_t PWM_PIN = 9;
const float PWM_SAFE = 0;
const float RATE = 120;                  // largest accepted change per second
const unsigned long WATCHDOG_MS = 1000;
const unsigned long PERIOD_MS = 20;      // 50 telemetry samples per second

volatile unsigned long lastPulseUs = 0;
volatile unsigned long pulsePeriodUs = 0;
float pwm = PWM_SAFE;
unsigned long lastLife = 0;
unsigned long lastCmd = 0;
bool live = false;
String line;

void onPulse() {
  unsigned long now = micros();
  if (lastPulseUs != 0) pulsePeriodUs = now - lastPulseUs;
  lastPulseUs = now;
}

void sendHello() {
  Serial.println(F("{\"hello\":{\"device\":\"arduino-ems\",\"firmware\":\"2.0\",\"watchdog_ms\":1000,"
                   "\"channels\":[{\"key\":\"vc\",\"unit\":\"V\"},{\"key\":\"rpm\",\"unit\":\"rpm\"},{\"key\":\"pwm\",\"unit\":\"duty\"}],"
                   "\"commands\":[{\"key\":\"pwm\",\"min\":0,\"max\":255,\"rate\":120,\"safe\":0,\"unit\":\"duty\"}]}}"));
}

void ack(long seq, bool ok, const char* reason) {
  Serial.print(F("{\"ack\":"));
  Serial.print(seq);
  if (!ok) { Serial.print(F(",\"ok\":false,\"reason\":\"")); Serial.print(reason); Serial.print('"'); }
  Serial.println('}');
}

// Minimal field readers for the few message shapes Studio sends.
bool has(const String& s, const char* key) { return s.indexOf(key) >= 0; }
float numberAfter(const String& s, const char* key) {
  int i = s.indexOf(key);
  return i < 0 ? NAN : s.substring(i + strlen(key)).toFloat();
}

void handle(const String& s) {
  if (has(s, "\"hello\"")) { sendHello(); return; }
  if (has(s, "\"disarm\"")) { pwm = PWM_SAFE; live = false; Serial.println(F("{\"event\":\"disarmed, pwm at safe value\"}")); return; }
  if (has(s, "\"hb\":")) { lastLife = millis(); live = true; ack((long)numberAfter(s, "\"hb\":"), true, ""); return; }
  if (has(s, "\"cmd\"")) {
    long seq = (long)numberAfter(s, "\"seq\":");
    float v = numberAfter(s, "\"pwm\":");
    if (isnan(v)) { ack(seq, true, ""); lastLife = millis(); return; }
    if (v < 0 || v > 255) { ack(seq, false, "pwm out of range"); return; }
    float dt = lastCmd ? (millis() - lastCmd) / 1000.0 : 1.0;
    if (fabs(v - pwm) > RATE * min(dt + 0.1, 1.0)) { ack(seq, false, "change faster than rate limit"); return; }
    pwm = v;
    lastCmd = lastLife = millis();
    live = true;
    ack(seq, true, "");
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PULSE_PIN, INPUT_PULLUP);
  pinMode(PWM_PIN, OUTPUT);
  analogWrite(PWM_PIN, 0);
  attachInterrupt(digitalPinToInterrupt(PULSE_PIN), onPulse, FALLING);
  sendHello();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handle(line); line = ""; }
    else if (line.length() < 200) line += c;
  }

  if (live && millis() - lastLife > WATCHDOG_MS) {
    pwm = PWM_SAFE;
    live = false;
    Serial.println(F("{\"event\":\"watchdog: no heartbeat for 1 s, returned to safe values\",\"level\":\"warn\"}"));
  }
  analogWrite(PWM_PIN, (int)pwm);

  static unsigned long last = 0;
  if (millis() - last < PERIOD_MS) return;
  last = millis();

  noInterrupts();
  unsigned long period = pulsePeriodUs;
  unsigned long sinceLast = micros() - lastPulseUs;
  interrupts();
  float rpm = (period > 0 && sinceLast < 1000000UL) ? 60.0e6 / (float)period / PULSES_PER_REV : 0;
  float vc = analogRead(CAP_PIN) * VREF / 1023.0 * DIVIDER;

  Serial.print(F("{\"v\":{\"vc\":"));
  Serial.print(vc, 3);
  Serial.print(F(",\"rpm\":"));
  Serial.print(rpm, 1);
  Serial.print(F(",\"pwm\":"));
  Serial.print(pwm, 1);
  Serial.println(F("}}"));
}
