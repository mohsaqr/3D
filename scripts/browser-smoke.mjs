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
const WHEEL_SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-wheel.png");
const EXAM_WHEEL_SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-exam-wheel.png");
const FINDING_SCREENSHOT_PATH = join(OUTPUT_DIRECTORY, "rohy-browser-smoke-finding.png");
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

  await client.evaluate(`document.querySelector("#view-wheel").dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }))`);
  assert.deepEqual(
    await client.evaluate(`({
      open: document.querySelector("#view-wheel")?.classList.contains("is-open"),
      expanded: document.querySelector("#view-wheel-hub")?.getAttribute("aria-expanded"),
    })`),
    { open: true, expanded: "true" },
    "Hovering the view wheel must expand the radial menu.",
  );
  await wait(400);
  const wheel_screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(WHEEL_SCREENSHOT_PATH, Buffer.from(wheel_screenshot.data, "base64"));
  await click(client, '[data-camera="airway"]');
  await wait(80);
  assert.deepEqual(
    await client.evaluate(`({
      open: document.querySelector("#view-wheel")?.classList.contains("is-open"),
      active: document.querySelector("#view-wheel")?.dataset.active,
      label: document.querySelector("#view-wheel-label")?.textContent,
    })`),
    { open: false, active: "airway", label: "Airway" },
    "Choosing a wedge must select the view, update the hub, and close the wheel.",
  );
  await client.evaluate(`document.querySelector("#view-wheel-hub").click()`);
  assert.deepEqual(
    await client.evaluate(`({
      active: document.querySelector("#view-wheel")?.dataset.active,
      label: document.querySelector("#view-wheel-label")?.textContent,
      next: document.querySelector("#view-wheel-next")?.textContent,
      aria: document.querySelector("#view-wheel-hub")?.getAttribute("aria-label"),
    })`),
    {
      active: "monitor",
      label: "Monitor",
      next: "Equipment \u203a",
      aria: "Next camera view: Equipment",
    },
    "Clicking the central node must navigate and name the view it goes to next.",
  );
  await client.evaluate(`document.querySelector("#view-wheel-hub").click()`);
  assert.equal(
    await client.evaluate(`document.querySelector("#view-wheel")?.dataset.active`),
    "equipment",
    "Repeated hub clicks must keep cycling the views.",
  );
  await client.evaluate(`document.querySelector("#view-wheel").dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }))`);
  await client.evaluate(`document.querySelector("#view-wheel").dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }))`);
  await wait(450);
  assert.equal(
    await client.evaluate(`document.querySelector("#view-wheel")?.classList.contains("is-open")`),
    false,
    "Leaving the wheel must collapse it.",
  );
  report.checks.push("view wheel opens on hover, wedges select, and the central node cycles views");

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
    // Mimic Rohy's embedding geometry exactly: the mount host stops 72px
    // above the viewport bottom, where the host's own fixed room navigator
    // sits. A full-viewport host would hide every bottom-edge collision.
    const navigator_band = document.createElement("div");
    navigator_band.id = "bound-navigator";
    navigator_band.style.cssText = "position:fixed;inset:auto 0 0 0;height:72px;z-index:1000;background:#0b1020;";
    document.body.appendChild(navigator_band);
    const host = document.createElement("div");
    host.id = "bound-host";
    host.style.cssText = "position:fixed;inset:0 0 72px 0;z-index:999;";
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
      body_regions: [
        {
          id: "chestAnterior",
          label: "Anterior chest",
          center: [0, 1.5, -0.9],
          size: [1.2, 0.8, 1.6],
          exams: [
            { id: "inspection", label: "Inspect", hint: "Look" },
            { id: "palpation", label: "Palpate", hint: "Feel" },
            { id: "percussion", label: "Percuss", hint: "Tap" },
            { id: "auscultation", label: "Auscultate", hint: "Listen" },
          ],
        },
        {
          id: "abdomen",
          label: "Abdomen",
          center: [0, 1.45, 0.5],
          size: [0.9, 0.5, 0.9],
          exams: [
            { id: "inspection", label: "Inspect", hint: "Look" },
            { id: "palpation", label: "Palpate", hint: "Feel" },
            {
              id: "special",
              label: "Special",
              hint: "Maneuvers",
              tests: ["Murphy's sign", "Rebound tenderness", "Shifting dullness"],
            },
          ],
        },
      ],
      on_exam: ({ region_id, exam_id, test }) => {
        if (region_id === "chestAnterior" && exam_id === "auscultation") {
          return {
            finding: "Irregularly irregular heart sounds with a variable first heart sound; no murmur, rub, or gallop. Vesicular breath sounds throughout all zones with no added sounds. Vocal resonance is normal and symmetrical.",
            abnormal: true,
            audio: [
              { label: "Heart sounds", url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=" },
              { label: "Breath sounds", url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=" },
            ],
          };
        }
        if (region_id === "chestAnterior" && exam_id === "percussion") {
          // Deliberately longer than the card body so the scroll cue paths
          // (is-scrollable / is-at-end) are exercised.
          return {
            finding: Array.from({ length: 9 }, () =>
              "Percussion note is resonant throughout all lung zones bilaterally with no areas of dullness or hyper-resonance. Cardiac dullness is present in the normal distribution and is not displaced.").join(" "),
            abnormal: false,
          };
        }
        if (test) {
          return { finding: test + " is negative.", abnormal: false };
        }
        return { finding: "No abnormality detected on " + exam_id + ".", abnormal: false };
      },
      nav_actions: [
        { id: "examine", label: "Examine", hint: "Body regions", color: "#7ee0c0" },
        { id: "records", label: "Records", hint: "Chart", color: "#ffb84a" },
      ],
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
      has_camera_controls: Boolean(host.querySelector(".view-wheel")),
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
  const region_click = await client.evaluate(`(async () => {
    const host = document.querySelector("#bound-host");
    window.__bound_room.focusPreset("patient");
    await new Promise((resolve) => setTimeout(resolve, 950));
    const canvas = host.querySelector("#scene-root canvas");
    const bounds = canvas.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cursor = canvas.style.cursor;
    const hover_label = host.querySelector("#region-hover-label");
    const hover_state = { hidden: hover_label?.hidden, text: hover_label?.textContent };
    canvas.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
    const region_events = window.__bound_events.filter(
      (event) => event.type === "selection" && event.kind === "region",
    );
    return { cursor, hover_state, region_ids: region_events.map((event) => event.id) };
  })()`);
  assert.equal(region_click.cursor, "pointer", "Hovering a body region must show a pointer cursor.");
  assert.deepEqual(
    region_click.hover_state,
    { hidden: false, text: "Anterior chest" },
    "Hovering must show the in-room region label.",
  );
  assert.deepEqual(
    region_click.region_ids,
    ["chestAnterior"],
    "Clicking the patient's chest must report the host-supplied region id.",
  );
  report.checks.push("body-region collider hover and click reported the examined region");

  await waitForCondition(
    client,
    `document.querySelector("#bound-host #exam-layer")?.classList.contains("is-open")`,
    "the exam wheel to bloom at the click point",
  );
  const exam_wheel_state = await client.evaluate(`(() => {
    const wheel = document.querySelector("#bound-host #exam-wheel");
    return {
      wedges: wheel.querySelectorAll("[data-exam]").length,
      hub_kicker: wheel.querySelector("#exam-wheel-hub small")?.textContent,
      hub_label: wheel.querySelector("#exam-wheel-hub strong")?.textContent,
      positioned: wheel.style.left !== "" && wheel.style.top !== "",
      open_event: window.__bound_events.some(
        (event) => event.type === "exam_open" && event.region_id === "chestAnterior",
      ),
    };
  })()`);
  assert.deepEqual(exam_wheel_state, {
    wedges: 4,
    hub_kicker: "EXAMINE",
    hub_label: "Anterior chest",
    positioned: true,
    open_event: true,
  }, "Clicking the chest must bloom a four-technique exam wheel at the click point.");
  await wait(450);
  const exam_wheel_screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(EXAM_WHEEL_SCREENSHOT_PATH, Buffer.from(exam_wheel_screenshot.data, "base64"));

  await client.evaluate(`document.querySelector('#bound-host [data-exam="auscultation"]').click()`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #finding-card")?.classList.contains("is-visible")`,
    "the finding card",
  );
  const finding_state = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    const card = host.querySelector("#finding-card");
    return {
      kicker: card.querySelector(".finding-card__kicker")?.textContent.trim(),
      severity: card.dataset.severity,
      abnormal_flag: Boolean(card.querySelector(".finding-card__flag")),
      finding_text: card.querySelector(".finding-card__body p")?.textContent.includes("Irregularly irregular"),
      audio_chips: [...card.querySelectorAll(".audio-chip .audio-chip__label")].map((chip) => chip.textContent),
      wheel_closed: !host.querySelector("#exam-layer")?.classList.contains("is-open"),
      exam_event: window.__bound_events.some(
        (event) => event.type === "exam" && event.exam_id === "auscultation" && event.abnormal === true,
      ),
      log: window.__bound_room.getExamLog(),
    };
  })()`);
  assert.deepEqual(finding_state, {
    kicker: "Anterior chest · Auscultate",
    severity: "abnormal",
    abnormal_flag: true,
    finding_text: true,
    audio_chips: ["Heart sounds", "Breath sounds"],
    wheel_closed: true,
    exam_event: true,
    log: [{ region_id: "chestAnterior", exam_id: "auscultation", test: null, abnormal: true }],
  }, "Committing auscultation must present the abnormal finding with its audio chips.");
  await wait(400);
  const finding_screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(FINDING_SCREENSHOT_PATH, Buffer.from(finding_screenshot.data, "base64"));
  report.checks.push("exam wheel bloomed on the chest, auscultation presented an abnormal finding card with audio chips");

  await client.evaluate(`window.__bound_room.openExamWheel("chestAnterior")`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #exam-layer")?.classList.contains("is-open")`,
    "the reopened exam wheel",
  );
  assert.equal(
    await client.evaluate(
      `Boolean(document.querySelector('#bound-host [data-exam="auscultation"] .exam-wheel__done--abnormal'))`,
    ),
    true,
    "The reopened wheel must show an amber done-tick on the performed auscultation wedge.",
  );
  // The hub steps to the next body region rather than dead-ending.
  const hub_step = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    const hub = host.querySelector("#exam-wheel-hub");
    const before = hub.querySelector("strong").textContent;
    const next_hint = hub.querySelector(".exam-wheel__hub-next")?.textContent.trim();
    const press = (type, x, y) => hub.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, clientX: x, clientY: y, bubbles: true,
    }));
    const box = hub.getBoundingClientRect();
    press("pointerdown", box.left + 10, box.top + 10);
    press("pointerup", box.left + 10, box.top + 10);
    hub.click();
    return {
      before,
      next_hint,
      after: host.querySelector("#exam-wheel-hub strong").textContent,
      still_open: host.querySelector("#exam-layer").classList.contains("is-open"),
    };
  })()`);
  assert.equal(hub_step.before, "Anterior chest");
  assert.equal(hub_step.after, "Abdomen", "The hub must step to the next region, not close.");
  assert.equal(hub_step.next_hint, "Abdomen \u203a", "The hub must name where it goes next.");
  assert.equal(hub_step.still_open, true, "Stepping regions keeps the wheel open.");
  report.checks.push("exam wheel hub steps to the next body region and names it");

  // Dragging the hub moves the wheel off the patient and it stays put.
  const drag_state = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    const wheel = host.querySelector("#exam-wheel");
    const hub = host.querySelector("#exam-wheel-hub");
    const before = { left: wheel.style.left, top: wheel.style.top };
    const box = hub.getBoundingClientRect();
    const press = (type, x, y) => hub.dispatchEvent(new PointerEvent(type, {
      pointerId: 2, clientX: x, clientY: y, bubbles: true,
    }));
    press("pointerdown", box.left + 10, box.top + 10);
    press("pointermove", box.left + 190, box.top + 40);
    const dragging = host.querySelector("#exam-wheel").classList.contains("is-moved");
    press("pointerup", box.left + 190, box.top + 40);
    // Browsers fire a click after a drag; it must not step the region.
    hub.click();
    const moved = { left: wheel.style.left, top: wheel.style.top };
    const region_after_drag = host.querySelector("#exam-wheel-hub strong").textContent;
    return { before, dragging, moved, region_after_drag };
  })()`);
  assert.notEqual(drag_state.moved.left, drag_state.before.left, "Dragging the hub must move the wheel.");
  assert.equal(drag_state.dragging, true, "The wheel marks itself once moved.");
  assert.equal(
    drag_state.region_after_drag,
    "Abdomen",
    "A drag must not also be read as a region step.",
  );
  report.checks.push("exam wheel drags to a new position and a drag never counts as a click");

  await client.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitForCondition(
    client,
    `!document.querySelector("#bound-host #exam-layer")?.classList.contains("is-open")`,
    "the exam wheel to close on Escape",
  );
  assert.equal(
    await client.evaluate(
      `window.__bound_events.filter((event) => event.type === "exam_close").length >= 2`,
    ),
    true,
    "Both wheel visits must emit exam_close.",
  );

  await client.evaluate(`window.__bound_room.openExamWheel("abdomen")`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #exam-layer")?.classList.contains("is-open")`,
    "the abdomen exam wheel",
  );
  assert.equal(
    await client.evaluate(
      `document.querySelector('#bound-host [data-exam="special"] .exam-wheel__badge')?.textContent`,
    ),
    "3",
    "The special wedge must badge its three named tests.",
  );
  await client.evaluate(`document.querySelector('#bound-host [data-exam="special"]').click()`);
  const sub_ring_state = await client.evaluate(`(() => {
    const wheel = document.querySelector("#bound-host #exam-wheel");
    return {
      hub_kicker: wheel.querySelector("#exam-wheel-hub small")?.textContent,
      wedges: wheel.querySelectorAll("[data-exam]").length,
      has_back: Boolean(wheel.querySelector("[data-back]")),
      first_test: wheel.querySelector("[data-test]")?.dataset.test,
    };
  })()`);
  assert.deepEqual(sub_ring_state, {
    hub_kicker: "SPECIAL TESTS",
    wedges: 4,
    has_back: true,
    first_test: "Murphy's sign",
  }, "The special wedge must morph the wheel into the named-tests sub-ring.");
  await client.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert.equal(
    await client.evaluate(
      `document.querySelector("#bound-host #exam-wheel-hub small")?.textContent`,
    ),
    "EXAMINE",
    "Escape must back out of the sub-ring to the technique ring.",
  );
  await client.evaluate(`document.querySelector('#bound-host [data-exam="special"]').click()`);
  await client.evaluate(`document.querySelector('#bound-host [data-test="Murphy\\u0027s sign"]').click()`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #finding-card .finding-card__kicker")?.textContent.includes("Murphy")`,
    "the special-test finding card",
  );
  const special_finding = await client.evaluate(`(() => {
    const card = document.querySelector("#bound-host #finding-card");
    return {
      kicker: card.querySelector(".finding-card__kicker")?.textContent.trim(),
      severity: card.dataset.severity,
      abnormal_flag: Boolean(card.querySelector(".finding-card__flag")),
    };
  })()`);
  assert.deepEqual(special_finding, {
    kicker: "Abdomen · Murphy's sign",
    severity: "normal",
    abnormal_flag: false,
  }, "A named special test must replace the technique word on the card and show no abnormal flag.");
  await client.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #finding-card")?.hidden === true`,
    "the finding card to close on Escape",
  );
  report.checks.push("special tests sub-ring navigated (badge, back wedge, Escape layering) and a named test presented its card");

  await client.evaluate(`window.__bound_room.openExamWheel("chestAnterior")`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #exam-layer")?.classList.contains("is-open")`,
    "the exam wheel for the long-finding check",
  );
  await client.evaluate(`document.querySelector('#bound-host [data-exam="percussion"]').click()`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #finding-card")?.classList.contains("is-scrollable")`,
    "the long finding to raise the scroll cue",
  );
  const long_finding_state = await client.evaluate(`(() => {
    const card = document.querySelector("#bound-host #finding-card");
    const body = card.querySelector(".finding-card__body");
    const scrollable_before = card.classList.contains("is-scrollable");
    const at_end_before = card.classList.contains("is-at-end");
    body.scrollTop = body.scrollHeight;
    body.dispatchEvent(new Event("scroll"));
    return {
      scrollable_before,
      at_end_before,
      at_end_after: card.classList.contains("is-at-end"),
      body_focusable: body.tabIndex === 0,
    };
  })()`);
  assert.deepEqual(long_finding_state, {
    scrollable_before: true,
    at_end_before: false,
    at_end_after: true,
    body_focusable: true,
  }, "A long finding must show the scroll cue and lift it at the end of the text.");
  report.checks.push("long findings scroll inside the card with a fade cue that lifts at the end");

  // The finding must stay fully inside the mount host at every window
  // height — anything below the host's bottom edge is hidden behind the
  // embedding app's navigator and cannot be read or scrolled to.
  const fit_measurements = [];
  for (const height of [1000, 820, 700, 620]) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: DESKTOP_VIEWPORT.width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait(220);
    fit_measurements.push(await client.evaluate(`(() => {
      const host = document.querySelector("#bound-host").getBoundingClientRect();
      const card = document.querySelector("#bound-host #finding-card").getBoundingClientRect();
      const body = document.querySelector("#bound-host .finding-card__body");
      return {
        viewport_height: window.innerHeight,
        overflow_below_host: Math.round(card.bottom - host.bottom),
        overflow_above_host: Math.round(host.top - card.top),
        body_visible_height: Math.round(body.getBoundingClientRect().height),
        stage_overflow: Math.round(
          document.querySelector("#bound-host .stage").getBoundingClientRect().bottom - host.bottom,
        ),
      };
    })()`));
  }
  report.finding_card_fit = fit_measurements;
  fit_measurements.forEach((measurement) => {
    assert.ok(
      measurement.overflow_below_host <= 0,
      `At ${measurement.viewport_height}px the finding card hangs ${measurement.overflow_below_host}px below the mount host (hidden behind the host's navigator): ${JSON.stringify(measurement)}`,
    );
    assert.ok(
      measurement.overflow_above_host <= 0,
      `At ${measurement.viewport_height}px the finding card is clipped at the top of the mount host: ${JSON.stringify(measurement)}`,
    );
    assert.ok(
      measurement.body_visible_height >= 40,
      `At ${measurement.viewport_height}px the finding text area collapsed to ${measurement.body_visible_height}px.`,
    );
  });
  await client.send("Emulation.setDeviceMetricsOverride", {
    ...DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait(200);
  report.checks.push("finding card stays inside the mount host at 1000/820/700/620px window heights");
  await client.evaluate(`document.querySelector("#bound-host #finding-close").click()`);

  await client.evaluate(`(() => {
    window.__bound_room.emphasizeRegion("chestAnterior");
    window.__bound_room.focusRegion([0, 1.5, -0.6]);
    window.__bound_room.markRegion("chestAnterior", "abnormal");
    window.__bound_room.react("wince");
    window.__bound_room.emphasizeRegion(null);
    return true;
  })()`);
  report.checks.push("region emphasis and camera focus APIs executed without errors");

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

  // findings: "host" — the room runs the wheel and still marks/reacts, but
  // renders no finding card, because the host presents findings in its own
  // richer surface (in Rohy: FindingDisplay with its auscultation points).
  const host_findings_state = await client.evaluate(`(async () => {
    const { mountPatientRoom } = await import("/src/main.js");
    const host = document.createElement("div");
    host.id = "host-findings";
    host.style.cssText = "position:fixed;inset:0 0 72px 0;z-index:998;visibility:hidden;";
    document.body.appendChild(host);
    const events = [];
    const room = mountPatientRoom(host, {
      mode: "bound",
      chrome: "room",
      findings: "host",
      body_regions: [{
        id: "abdomen",
        label: "Abdomen",
        center: [0, 1.45, 0.5],
        size: [0.9, 0.5, 0.9],
        exams: [{ id: "palpation", label: "Palpate", hint: "Feel" }],
      }],
      on_exam: () => ({ finding: "Soft and non-tender.", abnormal: false }),
      nav_actions: [
        { id: "examine", label: "Examine", hint: "Body regions", color: "#7ee0c0" },
        { id: "records", label: "Records", hint: "Chart", color: "#ffb84a" },
      ],
      on_event: (event) => events.push(event),
    });
    room.openExamWheel("abdomen");
    host.querySelector('[data-exam="palpation"]').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const state = {
      card_absent: host.querySelector("#finding-card") === null,
      exam_emitted: events.some((event) => event.type === "exam" && event.exam_id === "palpation"),
      logged: room.getExamLog().length,
    };
    room.dispose();
    host.remove();
    return state;
  })()`);
  assert.deepEqual(host_findings_state, {
    card_absent: true,
    exam_emitted: true,
    logged: 1,
  }, 'findings: "host" must suppress the room card while still performing and reporting the exam.');
  report.checks.push('findings: "host" suppresses the room finding card while exams still perform, log, and emit');

  // The wheel is a navigator, not a camera stepper: destinations sit on it
  // beside the views, and "examine" opens the examination wheel itself.
  const nav_state = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    return {
      views: host.querySelectorAll("[data-camera]").length,
      destinations: [...host.querySelectorAll("[data-nav]")].map((node) => node.dataset.nav),
    };
  })()`);
  assert.deepEqual(nav_state, { views: 5, destinations: ["examine", "records"] },
    "The navigation wheel must carry destinations beside the camera views.");

  await client.evaluate(`document.querySelector('#bound-host [data-nav="records"]').click()`);
  assert.equal(
    await client.evaluate(`window.__bound_events.some((event) => event.type === "nav" && event.id === "records")`),
    true,
    "A destination wedge must report itself so the host can open it.",
  );

  await client.evaluate(`document.querySelector('#bound-host [data-nav="examine"]').click()`);
  await waitForCondition(
    client,
    `document.querySelector("#bound-host #exam-layer")?.classList.contains("is-open")`,
    "the examination wheel opened from the navigation wheel",
  );
  await client.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  report.checks.push("navigation wheel carries destinations and opens the examination wheel");

  // The monitor can be moved out of the way and stays where it is put.
  const monitor_drag = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    const panel = host.querySelector(".monitor-panel");
    const handle = host.querySelector(".monitor-header");
    const before = panel.getBoundingClientRect().left;
    const box = handle.getBoundingClientRect();
    const press = (type, x, y) => handle.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    press("pointerdown", box.left + 20, box.top + 10);
    press("pointermove", box.left - 260, box.top + 120);
    press("pointerup", box.left - 260, box.top + 120);
    return {
      moved_left: Math.round(panel.getBoundingClientRect().left),
      before: Math.round(before),
      inside: panel.getBoundingClientRect().left >= host.getBoundingClientRect().left - 1,
    };
  })()`);
  assert.ok(monitor_drag.moved_left < monitor_drag.before - 100,
    `Dragging the monitor header must move the panel: ${JSON.stringify(monitor_drag)}`);
  assert.equal(monitor_drag.inside, true, "A dragged panel must stay on the stage.");
  report.checks.push("monitor panel drags by its header and stays on the stage");

  // A host that docks a working surface on the left can hand that side to
  // its own panel; navigation steps across instead of hiding underneath.
  const wheelLeft = () => client.evaluate(
    `Math.round(document.querySelector("#bound-host #view-wheel").getBoundingClientRect().left)`,
  );
  const nav_at_rest = await wheelLeft();
  await client.evaluate(`window.__bound_room.setNavSide("right")`);
  // The move is animated, so measure once it has settled.
  await wait(400);
  const nav_handed_over = await wheelLeft();
  assert.ok(
    nav_handed_over > nav_at_rest + 400,
    `setNavSide("right") must move the wheel across: ${nav_at_rest} -> ${nav_handed_over}`,
  );
  await client.evaluate(`window.__bound_room.setNavSide("left")`);
  await wait(400);
  assert.equal(await wheelLeft(), nav_at_rest, "Giving the side back returns the wheel.");
  assert.equal(
    await client.evaluate(`(() => {
      try { window.__bound_room.setNavSide("middle"); return false; } catch { return true; }
    })()`),
    true,
    "An unknown side must be refused, not guessed.",
  );
  report.checks.push("navigation wheel hands its side over and takes it back");

  // The wheel moves by hand too, and a hand-placed wheel stops taking
  // side instructions — the learner's placement wins.
  const wheel_drag = await client.evaluate(`(() => {
    const host = document.querySelector("#bound-host");
    const wheel = host.querySelector("#view-wheel");
    const hub = host.querySelector("#view-wheel-hub");
    const active_before = wheel.dataset.active;
    const before = Math.round(wheel.getBoundingClientRect().top);
    const box = hub.getBoundingClientRect();
    const press = (type, x, y) => hub.dispatchEvent(new PointerEvent(type, {
      pointerId: 9, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    press("pointerdown", box.left + 10, box.top + 10);
    press("pointermove", box.left + 30, box.top - 180);
    press("pointerup", box.left + 30, box.top - 180);
    hub.click();
    const after = Math.round(wheel.getBoundingClientRect().top);
    const active_after = wheel.dataset.active;
    // A side instruction must not move a wheel the learner placed.
    window.__bound_room.setNavSide("right");
    return {
      before,
      after,
      moved_left_after_side: Math.round(wheel.getBoundingClientRect().left),
      left_before_side: Math.round(wheel.getBoundingClientRect().left),
      stepped: active_before !== active_after,
    };
  })()`);
  assert.ok(wheel_drag.after < wheel_drag.before - 100,
    `Dragging the hub must move the navigation wheel: ${JSON.stringify(wheel_drag)}`);
  assert.equal(wheel_drag.stepped, false, "A drag must not also step the view.");
  assert.equal(
    wheel_drag.moved_left_after_side,
    wheel_drag.left_before_side,
    "A hand-placed wheel ignores side instructions.",
  );
  report.checks.push("navigation wheel drags by its hub and then keeps its place");

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
