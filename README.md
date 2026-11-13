# Motion Studio

A browser studio for multi-domain physics: wire up parts, watch them move in 3D, check that energy is conserved, rebuild a circuit from photos, connect real hardware and Unreal Engine, and look up or run engineering lab tests. This is Phase 1 of the Engineering Motion Studio blueprint (EMS-ARC-001).

## Run it

Open a terminal in this folder:

```bash
cd "/Users/appler/untitled folder/untitled folder 2/motion-studio"
```

Install once:

```bash
npm install
```

Start the Studio, then open http://localhost:5173:

```bash
npm run dev
```

Run the solver and integration tests:

```bash
npm test
```

Build for production and serve it on http://localhost:8080:

```bash
npm run build
```

```bash
npm run serve
```

Paste one command at a time. zsh does not treat `#` as a comment in a pasted line, so trailing comments break the command.

## What's in it

| Area | What you can do |
|---|---|
| Simulation | Electrical, rotational, translational, thermal and fluid parts in one implicit solver, with an energy ledger that flags integrator error. 40 library parts, from a 555 timer to a rocket thrust chamber. |
| Examples | Nine scenes: motor + flywheel, LED blinker, torsion pendulum, spring–mass–damper, quarter-car suspension, PID robot joint, 3-axis robot arm pick-and-place, hydraulic lift, and a 2 kN LOX/ethanol rocket engine on a test stand. |
| Lab | **Lab** in the top bar: 389 blueprints, test procedures and experiments across 27 engineering branches and 16 teaching labs, and 20 virtual test benches (tensile, Charpy, fatigue, hardness, torsion, spring, Morse, pipe friction, venturi, Reynolds, heat exchanger, hot-fire, wind tunnel, concrete, shake table, bomb calorimeter, GC retention index, bioreactor kLa, FFT, EMC pre-scan). Every run goes to a test log you can download as CSV. |
| Wiring editor | **Edit** mode: drag parts from the Library, click a port and then another to wire them, R rotates, Delete removes. Circuits save in the browser and export as `.ems.json`. |
| Photo to twin | Upload up to four photos; Claude identifies parts, values and connections, asks about what it cannot see, and builds an editable circuit. **Use the sample breadboard** tries the flow without an API key. |
| Hardware | **Connect › Hardware**: USB serial or WebSocket devices speaking EMS Link v1. Draw measured channels over scope traces, drive model parameters from them, and in Assisted mode send ramped, range-checked commands with a heartbeat watchdog. |
| Unreal Engine | **Connect › Unreal Engine**: stream part motion and values through the Remote Control API or the open Twin Stream JSON, and download the scene as glTF with one actor per part. |

Keys: Space run/pause · `.` step 10 ms · `R` reset (rotate in Edit) · `F` frame the selection · Delete removes in Edit · Esc cancels a wire.

## Photo to twin needs an API key

The browser never sees the key. The Studio's own server calls Claude (`claude-opus-5-5`, with structured output and automatic fallback when a request is declined). Set the key in the terminal before starting the server:

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key
```

```bash
npm run dev
```

## Try the integrations without hardware

A simulated motor rig that speaks EMS Link, with a real watchdog:

```bash
node tools/fake-device.mjs
```

Then **Connect › Hardware › WebSocket** to `ws://localhost:8765`. Its status page is http://localhost:8765.

A stand-in for Unreal's Remote Control endpoint that checks each message's shape:

```bash
node tools/mock-engine.mjs
```

Then **Connect › Unreal Engine › Start streaming**. Its status page is http://127.0.0.1:30020.

## How it is built

- `src/sim/` solver core, parts, library, project compiler, built-in scenes. Every part connects through ports carrying an effort (V, rad/s, m/s, K, Pa) and a flow (A, N·m, N, W, kg/s); one balance equation per node gives conservation. Fluid ports use absolute pressure and mass flow; their product is not power, so the ledger counts pumps and cylinders as hydraulic work instead.
- `src/sim/elements-ext.ts` flow sources, square-root (orifice and valve) flow, gyrators for pumps and cylinders, gravity on robot links, a digital PID, and the thrust chamber: injectors, a combustion time lag (which can chug), c* from mixture ratio, a choked de Laval nozzle and Bartz-style wall heating.
- `src/lab/` the reference library (`data/`), facilities and branches, the virtual benches and the Lab dialog.
- `src/view/viewport.ts` Three.js view and the editor's 3D gestures.
- `src/photo/` photo-to-twin review, draft schema and circuit layout; `server/` the Claude call and production server.
- `src/hw/` EMS Link protocol, transports and the device link; `src/integrations/` the Unreal connector and the Integrations dialog.
- `docs/EMS-LINK.md` the hardware and engine protocols. `arduino/ems_telemetry/` a reference device.

## Not built yet

- L1–L3 fidelity levels, a chemical-kinetics domain, FMI 3.0 import. Fluid parts are incompressible except where a fluid volume adds compliance.
- The robot arm uses an independent-joint model (a parallelogram arm, where gravity loads decouple); it leaves out the inertia coupling between joints.
- Lab bench results come from physics models with seeded scatter. Use them to learn the method, not to certify a part.
- The Unreal connector has been checked against `tools/mock-engine.mjs`, not yet a live Unreal Editor.
- The hardware link has been checked against `tools/fake-device.mjs`; test with your own board before trusting it with anything that can hurt someone.
