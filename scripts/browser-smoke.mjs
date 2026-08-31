import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fs_constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIRECTORY);
const OUTPUT_DIRECTORY = join(PROJECT_ROOT, "tmp");
const SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-desktop.png");
const PATIENT_SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-patient.png");
const TRENDS_SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-trends.png");
const BOUND_SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-bound.png");
const RECORDS_SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-records.png");
const RESULT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-result.json");
const DESKTOP_VIEWPORT = Object.freeze({ width: 1440, height: 1000 });
const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
const DEFAULT_TIMEOUT_MS = 30_000;

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function appendProcessOutput(target, chunk) {
  target.value = `${target.value}${chunk.toString()}`.slice(-40_000);
}

async function isExecutable(path) {
  if (!path) return false;
  return access(path, fs_constants.X_OK).then(() => true, () => false);
}

async function findChrome() {
  const platform_candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
    win32: [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
        : null,
      process.env.PROGRAMFILES
        ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
        : null,
      process.env["PROGRAMFILES(X86)"]
        ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
        : null,
    ],
  };
  const candidates = [
    process.env.CHROME_PATH,
    ...(platform_candidates[process.platform] ?? []),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error(
    "No Chrome executable found. Set CHROME_PATH to an installed Chrome or Chromium binary.",
  );
}

async function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "Could not reserve a local port.");
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function spawnManaged(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    cwd: PROJECT_ROOT,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  child.stdout_output = { value: "" };
  child.stderr_output = { value: "" };
  child.stdout.on("data", (chunk) => appendProcessOutput(child.stdout_output, chunk));
  child.stderr.on("data", (chunk) => appendProcessOutput(child.stderr_output, chunk));
  return child;
}

async function stopManaged(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const sendSignal = (signal) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };

  sendSignal("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    wait(3_000).then(() => false),
  ]);
  if (!graceful) {
    sendSignal("SIGKILL");
    await Promise.race([exited, wait(2_000)]);
  }
}

async function waitForHttp(url, child, timeout_ms = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout_ms;
  let last_error = null;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(
        `Process exited before ${url} was ready.\n${child.stderr_output.value}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last_error = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last_error = error;
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${last_error?.message ?? "no response"}`);
}

async function waitForChromeTarget(port, child) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited during startup.\n${child.stderr_output.value}`);
    }
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // Chrome's debugging endpoint is expected to refuse connections briefly.
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for Chrome at ${endpoint}.`);
}

class DevToolsClient {
  constructor(socket) {
    this.socket = socket;
    this.next_id = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener("message", async (event) => {
      const raw_data = typeof event.data === "string"
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(raw_data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      (this.listeners.get(message.method) ?? []).forEach((listener) => {
        listener(message.params ?? {});
      });
    });

    socket.addEventListener("close", () => {
      this.pending.forEach(({ reject }) => reject(new Error("Chrome DevTools connection closed.")));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools.")), { once: true });
    });
    return new DevToolsClient(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.next_id;
    this.next_id += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text;
      throw new Error(`Browser evaluation failed: ${description}`);
    }
    return response.result.value;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.socket.addEventListener("close", resolve, { once: true });
      this.socket.close();
      setTimeout(resolve, 500);
    });
  }
}

async function waitForCondition(client, expression, description, timeout_ms = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function click(client, selector) {
  const serialized_selector = JSON.stringify(selector);
  await client.evaluate(`(() => {
    const element = document.querySelector(${serialized_selector});
    if (!element) throw new Error("Missing element: " + ${serialized_selector});
    if (element.disabled) throw new Error("Disabled element: " + ${serialized_selector});
    element.click();
    return true;
  })()`);
}

async function selectCategory(client, category) {
  await click(client, `[data-category="${category}"]`);
  const category_state = await client.evaluate(`(() => {
    const button = document.querySelector('[data-category="${category}"]');
    const list = document.querySelector('[data-action-list="${category}"]');
    return {
      selected: button?.getAttribute("aria-selected"),
      active: button?.classList.contains("is-active"),
      visible: list ? !list.hidden : false,
    };
  })()`);
  assert.deepEqual(category_state, { selected: "true", active: true, visible: true });
}

async function performAction(client, action_id) {
  await click(client, `[data-action="${action_id}"]`);
  const pressed = await client.evaluate(
    `document.querySelector('[data-action="${action_id}"]')?.getAttribute("aria-pressed")`,
  );
  assert.equal(pressed, "true", `${action_id} should be marked complete.`);
}

async function inspectViewport(client, label, expected_viewport) {
  const layout = await client.evaluate(`(() => {
    const selectors = [".topbar", ".patient-panel", ".monitor-panel", ".action-dock"];
    const elements = selectors.map((selector) => {
      const element = document.querySelector(selector);
      const rectangle = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        visible: style.display !== "none" && style.visibility !== "hidden",
        left: Math.round(rectangle.left * 10) / 10,
        right: Math.round(rectangle.right * 10) / 10,
        top: Math.round(rectangle.top * 10) / 10,
        bottom: Math.round(rectangle.bottom * 10) / 10,
      };
    });
    const root = document.documentElement;
    const body = document.body;
    return {
      inner_width: window.innerWidth,
      inner_height: window.innerHeight,
      document_width: root.scrollWidth,
      document_height: root.scrollHeight,
      body_width: body.scrollWidth,
      body_height: body.scrollHeight,
      horizontal_overflow: Math.max(root.scrollWidth, body.scrollWidth) > window.innerWidth + 1,
      vertical_overflow: Math.max(root.scrollHeight, body.scrollHeight) > window.innerHeight + 1,
      elements,
    };
  })()`);

  assert.equal(layout.inner_width, expected_viewport.width, `${label} viewport width should match.`);
  assert.equal(layout.inner_height, expected_viewport.height, `${label} viewport height should match.`);
  assert.equal(layout.horizontal_overflow, false, `${label} must not have page-level horizontal overflow.`);
  assert.equal(layout.vertical_overflow, false, `${label} must not have page-level vertical overflow.`);
  layout.elements.filter(({ visible }) => visible).forEach(({ selector, left, right }) => {
    assert(left >= -1, `${selector} extends left of the ${label} viewport.`);
    assert(right <= expected_viewport.width + 1, `${selector} extends right of the ${label} viewport.`);
  });
  return layout;
}

function describeConsoleArgument(argument) {
  return argument.value === undefined
    ? argument.description ?? argument.type
    : typeof argument.value === "string"
      ? argument.value
      : JSON.stringify(argument.value);
}

async function runSmoke(client, app_url, report) {
  const page_errors = report.page_errors;
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    page_errors.push({
      source: "exception",
      text: exceptionDetails.exception?.description ?? exceptionDetails.text,
    });
  });
  client.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type === "error" || type === "assert") {
      page_errors.push({
        source: `console.${type}`,
        text: args.map(describeConsoleArgument).join(" "),
      });
    }
  });
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
  ]);
  await client.send("Emulation.setDeviceMetricsOverride", {
    ...DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send("Page.navigate", { url: app_url });
  await waitForCondition(
    client,
    `document.readyState === "complete" && Boolean(document.querySelector("#begin-button"))`,
    "the Rohy scenario brief",
  );
  await client.evaluate(`document.fonts?.ready ?? Promise.resolve()`);
  await waitForCondition(
    client,
    `Boolean(document.querySelector("#scene-root canvas")) || !document.querySelector("#webgl-fallback")?.hidden`,
    "the 3D scene or its fallback",
  );
  await wait(2_000);
  report.avatar_diagnostics = await client.evaluate(`({
    state: document.querySelector("#scene-root")?.dataset.avatarReady,
    resources: performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes("avatarsdk") || entry.name.includes("scene.js"))
      .map((entry) => ({ name: entry.name, duration: entry.duration, transferSize: entry.transferSize })),
  })`);
  await waitForCondition(
    client,
    `["true", "fallback"].includes(document.querySelector("#scene-root")?.dataset.avatarReady)`,
    "the patient avatar load result",
  );
  assert.equal(
    await client.evaluate(`document.querySelector("#scene-root")?.dataset.avatarReady`),
    "true",
    "The rigged full-body patient avatar should load without using the procedural fallback.",
  );

  const initial_state = await client.evaluate(`({
    title: document.title,
    objective_count: document.querySelector("#objective-count")?.textContent.trim(),
    score: document.querySelector("#score-value")?.textContent.trim(),
    oxygen_saturation: document.querySelector("#vital-oxygen_saturation [data-vital-value]")?.textContent.trim(),
    canvas_count: document.querySelectorAll("#scene-root canvas").length,
    fallback_hidden: document.querySelector("#webgl-fallback")?.hidden,
  })`);
  assert.equal(initial_state.title, "Rohy Patient Room");
  assert.equal(initial_state.objective_count, "0 / 4");
  assert.equal(initial_state.score, "000");
  assert.equal(initial_state.oxygen_saturation, "86");
  assert.equal(initial_state.canvas_count, 1, "The Three.js patient room should render a canvas.");
  assert.equal(initial_state.fallback_hidden, true, "The WebGL fallback should remain hidden.");
  report.checks.push("3D room rendered with baseline clinical state");

  await click(client, "#begin-button");
  await waitForCondition(client, `document.querySelector("#brief-modal")?.hidden === true`, "the room entry transition");
  assert.equal(
    await client.evaluate(`document.querySelector("#pause-button")?.getAttribute("aria-label")`),
    "Pause simulation",
  );
  report.checks.push("entered the patient room and started the simulation");

  const time_before_pause = await client.evaluate(`document.querySelector("#case-time")?.textContent`);
  await click(client, "#pause-button");
  assert.equal(
    await client.evaluate(`document.querySelector("#pause-button")?.getAttribute("aria-label")`),
    "Resume simulation",
  );
  await wait(1_100);
  assert.equal(
    await client.evaluate(`document.querySelector("#case-time")?.textContent`),
    time_before_pause,
    "Scenario time should remain fixed while paused.",
  );
  await click(client, "#pause-button");
  await click(client, "#sound-button");
  assert.equal(
    await client.evaluate(`document.querySelector("#sound-button")?.getAttribute("aria-pressed")`),
    "true",
  );
  await click(client, "#settings-button");
  assert.equal(
    await client.evaluate(`document.querySelector(".simulator")?.classList.contains("is-high-contrast")`),
    true,
  );
  report.checks.push("pause, sound, and high-contrast dashboard controls responded");

  await selectCategory(client, "assess");
  await performAction(client, "observe_breathing");
  await performAction(client, "auscultate");
  await selectCategory(client, "investigate");
  await performAction(client, "attach_monitor");
  await selectCategory(client, "treat");
  await performAction(client, "position_upright");
  await performAction(client, "apply_oxygen");

  const clinical_state = await client.evaluate(`({
    objective_count: document.querySelector("#objective-count")?.textContent.trim(),
    complete_objectives: document.querySelectorAll("#objective-list .objective.is-complete").length,
    score: document.querySelector("#score-value")?.textContent.trim(),
    oxygen_saturation: document.querySelector("#vital-oxygen_saturation [data-vital-value]")?.textContent.trim(),
    respiratory_rate: document.querySelector("#vital-respiratory_rate [data-vital-value]")?.textContent.trim(),
    status: document.querySelector(".simulator")?.dataset.status,
    timeline_count: document.querySelectorAll("#timeline-list .timeline-event").length,
  })`);
  assert.deepEqual(clinical_state, {
    objective_count: "3 / 4",
    complete_objectives: 3,
    score: "065",
    oxygen_saturation: "93",
    respiratory_rate: "25",
    status: "stabilizing",
    timeline_count: 4,
  });
  report.clinical_state = clinical_state;
  report.checks.push("assessment, investigation, and treatment actions updated score, objectives, timeline, and vitals");

  assert.equal(
    await client.evaluate(`document.querySelectorAll('a[href="#"]').length`),
    0,
    "The interface must not contain dead placeholder links.",
  );
  assert.match(
    await client.evaluate(`document.querySelector("#last-reading")?.textContent ?? ""`),
    /^Last reading · \d{2}:\d{2}$/,
    "The monitor footer must show the scenario time of the last reading.",
  );

  await click(client, "#trend-button");
  await waitForCondition(
    client,
    `document.querySelector("#trends-modal")?.classList.contains("is-visible")`,
    "the vital trends modal",
  );
  const trends_state = await client.evaluate(`({
    hidden: document.querySelector("#trends-modal")?.hidden,
    rows: document.querySelectorAll("#trends-body .trend-row").length,
    empty_paths: [...document.querySelectorAll("#trends-body .trend-line")]
      .filter((path) => !path.getAttribute("d")).length,
    spo2_severity: document.querySelector('#trends-body [data-trend="oxygen_saturation"]')?.dataset.severity,
  })`);
  assert.deepEqual(trends_state, {
    hidden: false,
    rows: 4,
    empty_paths: 0,
    spo2_severity: "warning",
  });
  await wait(350);
  const trends_screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(TRENDS_SCREENSHOT_PATH, Buffer.from(trends_screenshot.data, "base64"));
  await click(client, "#trends-close");
  await waitForCondition(
    client,
    `document.querySelector("#trends-modal")?.hidden === true`,
    "the vital trends modal to close",
  );
  report.checks.push("vital trends modal opened with four populated sparklines and closed");

  await click(client, "#timeline-button");
  const expanded_timeline = await client.evaluate(`({
    expanded: document.querySelector(".activity-panel")?.classList.contains("is-expanded"),
    label: document.querySelector("#timeline-button")?.textContent,
    events: document.querySelectorAll("#timeline-list .timeline-event").length,
  })`);
  assert.equal(expanded_timeline.expanded, true, "Expand must open the full clinical timeline.");
  assert.equal(expanded_timeline.label, "Collapse");
  assert.equal(
    expanded_timeline.events,
    6,
    "The expanded timeline must show the arrival event plus all five performed actions.",
  );
  await click(client, "#timeline-button");
  const collapsed_timeline = await client.evaluate(`({
    expanded: document.querySelector(".activity-panel")?.classList.contains("is-expanded"),
    label: document.querySelector("#timeline-button")?.textContent,
    events: document.querySelectorAll("#timeline-list .timeline-event").length,
  })`);
  assert.deepEqual(collapsed_timeline, { expanded: false, label: "Expand", events: 4 });
  report.checks.push("clinical timeline expanded to the full event history and collapsed back");

  await click(client, '[data-camera="patient"]');
  await wait(750);
  const patient_screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(PATIENT_SCREENSHOT_PATH, Buffer.from(patient_screenshot.data, "base64"));
  report.checks.push("rigged full-body patient loaded and patient camera evidence was captured");

  for (const camera of ["monitor", "equipment", "overview"]) {
    await click(client, `[data-camera="${camera}"]`);
    assert.equal(
      await client.evaluate(`document.querySelector('[data-camera="${camera}"]')?.classList.contains("is-active")`),
      true,
      `${camera} camera preset should become active.`,
    );
    await wait(120);
  }
  report.checks.push("patient, monitor, equipment, and overview camera presets responded");

  await click(client, "#dashboard-button");
  assert.deepEqual(
    await client.evaluate(`({
      enabled: document.querySelector(".simulator")?.classList.contains("is-dashboard"),
      pressed: document.querySelector("#dashboard-button")?.getAttribute("aria-pressed"),
    })`),
    { enabled: true, pressed: "true" },
  );
  await click(client, "#dashboard-button");
  assert.deepEqual(
    await client.evaluate(`({
      enabled: document.querySelector(".simulator")?.classList.contains("is-dashboard"),
      pressed: document.querySelector("#dashboard-button")?.getAttribute("aria-pressed"),
    })`),
    { enabled: false, pressed: "false" },
  );
  report.checks.push("simplified dashboard toggled on and returned to the interactive room");

  await wait(750);
  report.viewports.desktop = await inspectViewport(client, "desktop", DESKTOP_VIEWPORT);
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
  report.checks.push("desktop viewport has no page-level overflow and screenshot was captured");

  await client.send("Emulation.setDeviceMetricsOverride", {
    ...MOBILE_VIEWPORT,
    screenWidth: MOBILE_VIEWPORT.width,
    screenHeight: MOBILE_VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await wait(250);
  report.viewports.mobile = await inspectViewport(client, "mobile", MOBILE_VIEWPORT);
  report.checks.push("mobile viewport has no page-level overflow");

  await client.send("Emulation.setDeviceMetricsOverride", {
    ...DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const bound_state = await client.evaluate(`(async () => {
    const { mountPatientRoom } = await import("/src/main.js");
    const host = document.createElement("div");
    host.id = "bound-host";
    host.style.cssText = "position:fixed;inset:0;z-index:999;";
    document.body.appendChild(host);
    const events = [];
    const room = mountPatientRoom(host, {
      mode: "bound",
      waveform: "host",
      chrome: "room",
      patient: {
        name: "Aino Testinen",
        initials: "AT",
        age: 61,
        pronouns: "she/her",
        speaker: "AINO",
        case_title: "Palpitations at rest",
        location: "Rohy · Live case",
        presenting_concern: "Palpitations and lightheadedness",
        allergies: "No known drug allergy",
        // background deliberately omitted: bound mode must show a neutral
        // placeholder, never the standalone demo patient's history.
      },
      records: [
        {
          title: "History",
          entries: [
            { label: "Chief complaint", value: "Palpitations and lightheadedness" },
            { label: "PMH", value: "Hypertension; type 2 diabetes" },
            { label: "Allergies", value: "No known drug allergy" },
          ],
        },
        { title: "Home medications", entries: [{ label: "Metformin", value: "1000 mg PO BID" }] },
      ],
      treatments: {
        available: [
          { name: "Oxygen", detail: "Nasal cannula · 2 L/min", treatment_type: "oxygen" },
          { name: "Metoprolol", detail: "IV · 5 mg", treatment_type: "medication" },
        ],
      },
      on_event: (event) => events.push(event),
    });
    window.__bound_room = room;
    window.__bound_events = events;
    room.update(
      { heart_rate: 88, oxygen_saturation: 97, respiratory_rate: 14, systolic: 122, diastolic: 78, temperature: 36.9 },
      null,
      30,
      { rhythm: "Atrial fibrillation" },
    );
    room.addTimelineEvent("Oxygen 2 L/min started.", "action", 30);
    return {
      hr: host.querySelector("#vital-heart_rate [data-vital-value]")?.textContent,
      spo2_severity: host.querySelector("#vital-oxygen_saturation")?.dataset.severity,
      status: host.querySelector(".simulator")?.dataset.status,
      time: host.querySelector("#case-time")?.textContent,
      case_title: host.querySelector(".case-heading h1")?.textContent,
      has_patient_panel: Boolean(host.querySelector(".patient-panel")),
      has_timeline: Boolean(host.querySelector(".activity-panel")),
      has_action_dock: Boolean(host.querySelector(".action-dock")),
      has_brief_modal: Boolean(host.querySelector("#brief-modal")),
      has_sound_button: Boolean(host.querySelector("#sound-button")),
      has_dashboard_button: Boolean(host.querySelector("#dashboard-button")),
      has_scene_labels: Boolean(host.querySelector(".scene-label")),
      has_monitor_panel: Boolean(host.querySelector(".monitor-panel")),
      has_camera_controls: Boolean(host.querySelector(".camera-controls")),
      has_brand: Boolean(host.querySelector(".brand")),
      case_heading_present: Boolean(host.querySelector(".case-heading h1")),
      caption_hidden: host.querySelector("#patient-caption")?.hidden,
      status_event_emitted: events.some((event) => event.type === "status"),
      host_canvas: room.ecg_canvas instanceof HTMLCanvasElement,
      internal_wave_absent: !host.querySelector("#ecg-path"),
      rhythm_label: host.querySelector("#rhythm-label")?.textContent,
    };
  })()`);
  assert.deepEqual(bound_state, {
    hr: "88",
    spo2_severity: "normal",
    status: "stable",
    time: "00:30",
    case_title: "Palpitations at rest",
    has_patient_panel: false,
    has_timeline: false,
    has_action_dock: false,
    has_brief_modal: false,
    has_sound_button: false,
    has_dashboard_button: false,
    has_scene_labels: false,
    has_monitor_panel: true,
    has_camera_controls: true,
    has_brand: false,
    case_heading_present: true,
    caption_hidden: true,
    status_event_emitted: true,
    host_canvas: true,
    internal_wave_absent: true,
    rhythm_label: "Atrial fibrillation",
  });

  await waitForCondition(
    client,
    `document.querySelector("#bound-host #scene-root")?.dataset.avatarReady === "true"`,
    "the bound room's avatar",
  );
  await client.evaluate(`window.__bound_room.say("The fluttering in my chest has eased a little.")`);
  assert.deepEqual(
    await client.evaluate(`({
      caption_hidden: document.querySelector("#bound-host #patient-caption")?.hidden,
      caption_text: document.querySelector("#bound-host #patient-caption p")?.textContent,
    })`),
    {
      caption_hidden: false,
      caption_text: "“The fluttering in my chest has eased a little.”",
    },
  );
  const treatments_state = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    window.__bound_room.openTreatments();
    host.querySelector('.treatment-order[data-order-index="0"]').click();
    const order_events = window.__bound_events.filter((event) => event.type === "order_request");
    window.__bound_room.setActiveTreatments([
      { name: "Oxygen", detail: "Nasal cannula · 2 L/min", status: "administered" },
    ]);
    const state = {
      order_event_count: order_events.length,
      ordered_name: order_events[0]?.treatment?.name,
      ordered_type: order_events[0]?.treatment?.treatment_type,
      active_rows: host.querySelectorAll("#treatments-body .treatment-row--administered").length,
      button_label: host.querySelector("#treatments-button")?.textContent,
    };
    host.querySelector("#treatments-close").click();
    return state;
  })()`);
  assert.deepEqual(treatments_state, {
    order_event_count: 1,
    ordered_name: "Oxygen",
    ordered_type: "oxygen",
    active_rows: 1,
    button_label: "Treatments (1)",
  });

  await client.evaluate(`document.querySelector("#bound-host #records-button").click()`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #records-modal")?.classList.contains("is-visible")`,
    "the medical records modal",
  );
  const records_state = await client.evaluate(`({
    sections: [...document.querySelectorAll("#bound-host .records-section h3")].map((h) => h.textContent),
    chief_complaint: [...document.querySelectorAll("#bound-host .records-list dd")][0]?.textContent,
  })`);
  assert.deepEqual(records_state, {
    sections: ["History", "Home medications"],
    chief_complaint: "Palpitations and lightheadedness",
  });
  await wait(400);
  const records_screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(RECORDS_SCREENSHOT_PATH, Buffer.from(records_screenshot.data, "base64"));
  await client.evaluate(`document.querySelector("#bound-host #records-close").click()`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #records-modal")?.hidden === true`,
    "the medical records modal to close",
  );
  report.checks.push("bound records and treatments panels showed host data, emitted an order, and tracked the active order");

  await wait(600);
  const bound_screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(BOUND_SCREENSHOT_PATH, Buffer.from(bound_screenshot.data, "base64"));

  const disposed_clean = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    window.__bound_room.dispose();
    const clean = host.innerHTML === "" && !host.classList.contains("rohy3d-root");
    host.remove();
    delete window.__bound_room;
    return clean;
  })()`);
  assert.equal(disposed_clean, true, "Bound-mode dispose must leave the host element empty.");
  report.checks.push("bound mode kept only live-data chrome (no demo controls, labels, or parked caption), mirrored rhythm and ECG canvas, said a line on demand, and disposed cleanly");

  await wait(150);
  assert.deepEqual(page_errors, [], `Page errors were reported:\n${JSON.stringify(page_errors, null, 2)}`);
  report.checks.push("no uncaught exceptions or console errors were reported");
}

async function main() {
  const started_at = new Date();
  const report = {
    name: "Rohy patient-room browser smoke test",
    passed: false,
    started_at: started_at.toISOString(),
    finished_at: null,
    duration_ms: null,
    app_url: null,
    chrome_path: null,
    artifacts: {
      screenshot: relative(PROJECT_ROOT, SCREENSHOT_PATH),
      patient_screenshot: relative(PROJECT_ROOT, PATIENT_SCREENSHOT_PATH),
      trends_screenshot: relative(PROJECT_ROOT, TRENDS_SCREENSHOT_PATH),
      result: relative(PROJECT_ROOT, RESULT_PATH),
    },
    checks: [],
    clinical_state: null,
    avatar_diagnostics: null,
    viewports: {},
    page_errors: [],
    error: null,
  };
  let vite_process = null;
  let chrome_process = null;
  let chrome_profile = null;
  let client = null;
  let cleanup_started = false;

  const cleanup = async () => {
    if (cleanup_started) return;
    cleanup_started = true;
    await client?.close().catch(() => {});
    await stopManaged(chrome_process).catch(() => {});
    await stopManaged(vite_process).catch(() => {});
    if (chrome_profile?.startsWith(join(tmpdir(), "rohy-browser-smoke-"))) {
      await rm(chrome_profile, { recursive: true, force: true }).catch(() => {});
    }
  };
  const handle_signal = (signal) => {
    cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", handle_signal);
  process.once("SIGTERM", handle_signal);

  try {
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
    const vite_port = await getOpenPort();
    const chrome_port = await getOpenPort();
    const chrome_path = await findChrome();
    const vite_path = join(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");
    assert(await isExecutable(process.execPath), "The current Node executable is unavailable.");
    assert(await access(vite_path).then(() => true, () => false), "Vite is not installed. Run npm install first.");

    const app_url = `http://127.0.0.1:${vite_port}/`;
    report.app_url = app_url;
    report.chrome_path = chrome_path;
    vite_process = spawnManaged(process.execPath, [
      vite_path,
      "--host",
      "127.0.0.1",
      "--port",
      String(vite_port),
      "--strictPort",
    ]);
    await waitForHttp(app_url, vite_process);

    chrome_profile = await mkdtemp(join(tmpdir(), "rohy-browser-smoke-"));
    chrome_process = spawnManaged(chrome_path, [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-features=MediaRouter,OptimizationHints,Translate",
      "--disable-sync",
      "--enable-unsafe-swiftshader",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-sandbox",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${chrome_port}`,
      `--user-data-dir=${chrome_profile}`,
      `--window-size=${DESKTOP_VIEWPORT.width},${DESKTOP_VIEWPORT.height}`,
      "about:blank",
    ]);
    const target = await waitForChromeTarget(chrome_port, chrome_process);
    client = await DevToolsClient.connect(target.webSocketDebuggerUrl);
    await runSmoke(client, app_url, report);
    report.passed = true;
  } catch (error) {
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    process.exitCode = 1;
  } finally {
    await cleanup();
    process.removeListener("SIGINT", handle_signal);
    process.removeListener("SIGTERM", handle_signal);
    const finished_at = new Date();
    report.finished_at = finished_at.toISOString();
    report.duration_ms = finished_at.getTime() - started_at.getTime();
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
    await writeFile(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (report.passed) {
    console.log(`Browser smoke test passed (${report.duration_ms} ms).`);
    console.log(`Screenshot: ${report.artifacts.screenshot}`);
    console.log(`Result: ${report.artifacts.result}`);
  } else {
    console.error(`Browser smoke test failed: ${report.error?.message ?? "unknown error"}`);
    console.error(`Result: ${report.artifacts.result}`);
  }
}

await main();
