# EMS Link v1 and Twin Stream

Two small, open protocols so any device or engine can connect to Motion Studio.

- **EMS Link** connects hardware (Arduino, ESP32, Raspberry Pi, a PLC gateway, a ROS 2 or Node-RED bridge) over USB serial or a WebSocket. Telemetry flows in; commands flow out only under the rules below.
- **Twin Stream** sends the simulation's state out to an engine (a custom Unreal plugin, Unity, Omniverse, or anything that listens on a WebSocket). For stock Unreal Engine, Studio can also talk to the Remote Control API directly.

## EMS Link v1

One JSON object per line, UTF-8, ending in `\n`. Over a WebSocket, each message is one line. USB serial runs at 115200 baud unless you choose otherwise.

### Device to Studio

| Message | Meaning |
|---|---|
| `{"hello":{"device":"rig-1","firmware":"1.2","watchdog_ms":1000,"channels":[{"key":"rpm","unit":"rpm"}],"commands":[{"key":"pwm","min":0,"max":255,"rate":120,"safe":0,"unit":"duty"}]}}` | Introduce yourself. Send on boot and whenever Studio sends `{"hello":…}`. `commands` is optional; without it the device is read-only. |
| `{"v":{"rpm":871.2,"temp":31.4}}` | One telemetry sample. Any number of channels. 20–100 Hz is typical. |
| `{"ack":42}` or `{"ack":42,"ok":false,"reason":"out of range"}` | Reply to each command or heartbeat by its `seq`. |
| `{"event":"watchdog tripped","level":"warn"}` | Anything worth logging. A `warn` that mentions the watchdog or safe values disarms Studio. |

Plain `rpm:871.2,temp:31.4` lines are also accepted as telemetry, so a minimal sketch can skip JSON. Such a device is read-only.

### Studio to device

| Message | Meaning |
|---|---|
| `{"hello":{"host":"motion-studio","protocol":"ems-link/1"}}` | Sent on connect. Reply with your hello. |
| `{"cmd":{"pwm":96},"seq":42,"ttl":600}` | Set one or more commands. `ttl` is how long the value stays valid without a newer message, in ms. |
| `{"hb":43}` | Heartbeat when no value changed. Acknowledge it like a command. |
| `{"disarm":true}` | Return every command to its `safe` value now. |

### Rules a device must follow

Studio enforces these too, but the device is the last line of defence, so it must check them itself:

1. Reject any command outside `[min, max]` with `"ok":false`.
2. Reject a change larger than `rate` × the time since the last accepted command.
3. If no command or heartbeat arrives for `watchdog_ms`, set every command to `safe` and send a `warn` event.
4. Treat `{"disarm":true}` as an immediate return to `safe`.
5. Never let this link be the only way to stop the machine. A hardware stop must work with Studio, the computer and the network switched off.

### What Studio does

- **Observe** mode only reads. **Assisted** mode can send, after you confirm the hardware stop is within reach and press Arm.
- Every 200 ms while armed, Studio sends either the next step of a ramp toward your setpoint (never faster than `rate`) or a heartbeat, each with `ttl` 600 ms.
- Five unacknowledged messages in a row disarm the link.
- Telemetry channels can be drawn over any scope trace, or drive any model parameter (hardware in the loop). Values are in the parameter's display unit, for example V, Ω or °C.

`tools/fake-device.mjs` is a complete reference device: a simulated motor rig with a watchdog. `arduino/ems_telemetry/ems_telemetry.ino` is the same thing on real hardware.

## Twin Stream v1

Studio sends one frame per update, at the rate you choose (10–60 Hz):

```json
{ "type": "ems.frame", "version": 1, "t": 12.345, "parts": { "M1": { "EMS_shaft_angle": 128.4, "EMS_shaft_rpm": 2607 }, "D1": { "EMS_brightness": 0.82 } } }
```

`parts` is keyed by the actor name from the bindings table, and each value by the property name. Angles are in degrees, integrated in Studio so they stay continuous; speeds are in rpm, temperatures in °C, brightness from 0 to 1.

## Unreal Engine Remote Control

With the Remote Control API plugin enabled, Studio writes properties on actors in the open level through Unreal's WebSocket server (default `ws://127.0.0.1:30020`). Each write is:

```json
{ "MessageName": "http", "Parameters": { "RequestId": 7, "Url": "/remote/object/property", "Verb": "PUT",
  "Body": { "objectPath": "/Game/Maps/Studio.Studio:PersistentLevel.M1", "access": "WRITE_ACCESS",
            "propertyName": "EMS_shaft_angle", "propertyValue": { "EMS_shaft_angle": 128.4 } } } }
```

Give each actor a float variable per property and use it in the actor's Blueprint. The message shape follows the Remote Control API documentation and has been checked against `tools/mock-engine.mjs`, not yet against a live editor; the Last message preview in Studio shows exactly what is sent.
