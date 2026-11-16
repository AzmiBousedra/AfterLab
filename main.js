/*
  AfterLab CEP panel controller
  - Rich UI interactions (sections, modals, toasts, settings)
  - Bridges HTML UI to ExtendScript host via CSInterface.evalScript
*/

const csInterface = typeof CSInterface === "function" ? new CSInterface() : null;

const ui = {
  mainView: null,
  settingsView: null,
  settingsToggle: null,
  settingsBack: null,
  modalOverlay: null,
  modalTitle: null,
  modalInput: null,
  modalCancel: null,
  modalOk: null,
  toast: null,

  darkModeToggle: null,
  accentSelect: null,
  semanticColorsToggle: null,

  flowEditor: null,
  flowPath: null,
  flowGuideOut: null,
  flowGuideIn: null,
  flowHandle1: null,
  flowHandle2: null,
  flowValues: null,
  flowApplyBtn: null,
  curveButtons: [],
  sectionNavButtons: [],
  tipsPanel: null,
  infoProjectName: null,
  infoCompName: null,
  infoCompSize: null,
  infoFrameRate: null,
  infoLastSaved: null,

  macroButtons: [],
};

const state = {
  isBusy: false,
  semanticFeedbackEnabled: true,
  modalResolver: null,
  flowCurve: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1.0 },
  curveSlots: [null, null, null, null, null, null, null, null],
  draggingHandle: null,
  projectInfoTimer: null,
};

const CURVE_SLOT_STORAGE_KEY = "afterlabCurveSlots.v1";
const THEME_STORAGE_KEY = "afterlabTheme.v1";
const ACCENT_STORAGE_KEY = "afterlabAccent.v1";
const SEMANTIC_FEEDBACK_STORAGE_KEY = "afterlabSemanticFeedback.v1";

const ACCENT_COLORS = {
  blue:   { value: "#007aff", subtle: "rgba(0, 122, 255, 0.14)" },
  purple: { value: "#bf5af2", subtle: "rgba(191, 90, 242, 0.14)" },
  green:  { value: "#30d158", subtle: "rgba(48, 209, 88, 0.14)" },
  orange: { value: "#ff9f0a", subtle: "rgba(255, 159, 10, 0.14)" },
  red:    { value: "#ff453a", subtle: "rgba(255, 69, 58, 0.14)" },
};

const ANCHOR_CELLS = [
  { hPct: 0, vPct: 0, label: "┌", tip: "Top Left" },
  { hPct: 0.5, vPct: 0, label: "┬", tip: "Top Center" },
  { hPct: 1, vPct: 0, label: "┐", tip: "Top Right" },
  { hPct: 0, vPct: 0.5, label: "├", tip: "Middle Left" },
  { hPct: 0.5, vPct: 0.5, label: "┼", tip: "Center" },
  { hPct: 1, vPct: 0.5, label: "┤", tip: "Middle Right" },
  { hPct: 0, vPct: 1, label: "└", tip: "Bottom Left" },
  { hPct: 0.5, vPct: 1, label: "┴", tip: "Bottom Center" },
  { hPct: 1, vPct: 1, label: "┘", tip: "Bottom Right" },
];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function updateProjectInfoUI(data) {
  if (ui.infoProjectName) ui.infoProjectName.textContent = data && data.projectName ? data.projectName : "-";
  if (ui.infoCompName) ui.infoCompName.textContent = data && data.compName ? data.compName : "-";
  if (ui.infoCompSize) ui.infoCompSize.textContent = data && data.compSize ? data.compSize : "-";
  if (ui.infoFrameRate) ui.infoFrameRate.textContent = data && data.frameRate ? data.frameRate : "-";
  if (ui.infoLastSaved) {
    const savedMs = data && typeof data.lastSavedMs === "number" ? data.lastSavedMs : null;
    ui.infoLastSaved.textContent = savedMs ? formatRelativeTime(savedMs) : "Unsaved project";
  }
}

function formatRelativeTime(timestampMs) {
  const deltaMs = Math.max(0, Date.now() - Number(timestampMs));
  const deltaMinutes = Math.floor(deltaMs / 60000);
  if (deltaMinutes < 1) return "just now";
  if (deltaMinutes === 1) return "1 minute ago";
  if (deltaMinutes < 60) return `${deltaMinutes} minutes ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours === 1) return "1 hour ago";
  if (deltaHours < 24) return `${deltaHours} hours ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays === 1) return "1 day ago";
  return `${deltaDays} days ago`;
}

async function refreshProjectInfo() {
  if (!csInterface) {
    updateProjectInfoUI({
      projectName: "Host unavailable",
      compName: "Host unavailable",
      compSize: "Host unavailable",
      frameRate: "-",
      lastSavedMs: null,
    });
    return;
  }
  try {
    const info = await evalHost("getProjectInfo");
    updateProjectInfoUI(info);
  } catch (error) {
    updateProjectInfoUI({
      projectName: "Unavailable",
      compName: "Unavailable",
      compSize: "Unavailable",
      frameRate: "-",
      lastSavedMs: null,
    });
  }
}

function normalizeCurve(curve) {
  if (!curve) return null;
  const x1 = clamp01(Number(curve.x1));
  const y1 = clamp01(Number(curve.y1));
  const x2 = clamp01(Number(curve.x2));
  const y2 = clamp01(Number(curve.y2));
  if (Number.isNaN(x1) || Number.isNaN(y1) || Number.isNaN(x2) || Number.isNaN(y2)) return null;
  return { x1, y1, x2, y2 };
}

function persistCurveSlots() {
  try {
    window.localStorage.setItem(CURVE_SLOT_STORAGE_KEY, JSON.stringify(state.curveSlots));
  } catch (error) {}
}

function loadCurveSlots() {
  try {
    const raw = window.localStorage.getItem(CURVE_SLOT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.length !== state.curveSlots.length) return;
    for (let i = 0; i < state.curveSlots.length; i += 1) {
      state.curveSlots[i] = normalizeCurve(parsed[i]);
    }
  } catch (error) {}
}

function updateCurveButtons() {
  ui.curveButtons.forEach((button, index) => {
    if (!button) return;
    const filled = !!state.curveSlots[index];
    button.classList.toggle("filled", filled);
    button.textContent = `C${index + 1}${filled ? "*" : ""}`;
  });
}

async function applyCurveToKeyframes(curve, label) {
  await runAction("applyFlowEase", {
    x1: curve.x1,
    y1: curve.y1,
    x2: curve.x2,
    y2: curve.y2,
  }, label || "Flow easing applied");
}

function getFlowDisplayRange(curve) {
  const minY = Math.min(0, 1, curve.y1, curve.y2);
  const maxY = Math.max(0, 1, curve.y1, curve.y2);

  // Keep the classic 0..1 view when the curve is in range.
  if (minY >= 0 && maxY <= 1) {
    return { min: 0, max: 1 };
  }

  const span = Math.max(0.001, maxY - minY);
  const pad = Math.max(0.05, span * 0.08);
  return {
    min: minY - pad,
    max: maxY + pad,
  };
}

function toCurveY(y, range) {
  const span = Math.max(0.001, range.max - range.min);
  return (1 - ((y - range.min) / span)) * 100;
}

function fromCurveY(percentY, range) {
  const span = Math.max(0.001, range.max - range.min);
  return range.min + (1 - percentY) * span;
}

function renderFlowEditor() {
  if (!ui.flowEditor || !ui.flowPath || !ui.flowHandle1 || !ui.flowHandle2) return;

  const { x1, y1, x2, y2 } = state.flowCurve;
  const yRange = getFlowDisplayRange(state.flowCurve);

  ui.flowPath.setAttribute("d", `M0,${toCurveY(0, yRange)} C${x1 * 100},${toCurveY(y1, yRange)} ${x2 * 100},${toCurveY(y2, yRange)} 100,${toCurveY(1, yRange)}`);
  if (ui.flowGuideOut) {
    ui.flowGuideOut.setAttribute("x1", "0");
    ui.flowGuideOut.setAttribute("y1", String(toCurveY(0, yRange)));
    ui.flowGuideOut.setAttribute("x2", String(x1 * 100));
    ui.flowGuideOut.setAttribute("y2", String(toCurveY(y1, yRange)));
  }
  if (ui.flowGuideIn) {
    ui.flowGuideIn.setAttribute("x1", "100");
    ui.flowGuideIn.setAttribute("y1", String(toCurveY(1, yRange)));
    ui.flowGuideIn.setAttribute("x2", String(x2 * 100));
    ui.flowGuideIn.setAttribute("y2", String(toCurveY(y2, yRange)));
  }

  ui.flowHandle1.style.left = `${x1 * 100}%`;
  ui.flowHandle1.style.top = `${toCurveY(y1, yRange)}%`;
  ui.flowHandle2.style.left = `${x2 * 100}%`;
  ui.flowHandle2.style.top = `${toCurveY(y2, yRange)}%`;

  if (ui.flowValues) {
    ui.flowValues.textContent = `${x1.toFixed(2)}, ${y1.toFixed(2)}, ${x2.toFixed(2)}, ${y2.toFixed(2)}`;
  }
}

function updateFlowHandleFromPointer(handleName, clientX, clientY) {
  if (!ui.flowEditor) return;
  const rect = ui.flowEditor.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const normalizedX = clamp01((clientX - rect.left) / rect.width);
  const yRange = getFlowDisplayRange(state.flowCurve);
  const normalizedPercentY = clamp01((clientY - rect.top) / rect.height);
  const normalizedY = Math.max(-0.5, Math.min(1.5, fromCurveY(normalizedPercentY, yRange)));

  if (handleName === "h1") {
    state.flowCurve.x1 = normalizedX;
    state.flowCurve.y1 = normalizedY;
  } else if (handleName === "h2") {
    state.flowCurve.x2 = normalizedX;
    state.flowCurve.y2 = normalizedY;
  }

  renderFlowEditor();
}

function bindFlowEditor() {
  if (!ui.flowEditor || !ui.flowHandle1 || !ui.flowHandle2) return;

  const getPoint = (event) => {
    if (event.touches && event.touches.length > 0) {
      return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    if (event.changedTouches && event.changedTouches.length > 0) {
      return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
    }
    return { x: event.clientX, y: event.clientY };
  };

  const distance = (x1, y1, x2, y2) => {
    const dx = x1 - x2;
    const dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const nearestHandle = (clientX, clientY) => {
    const rect = ui.flowEditor.getBoundingClientRect();
    const yRange = getFlowDisplayRange(state.flowCurve);
    const h1x = rect.left + rect.width * state.flowCurve.x1;
    const h1y = rect.top + rect.height * (toCurveY(state.flowCurve.y1, yRange) / 100);
    const h2x = rect.left + rect.width * state.flowCurve.x2;
    const h2y = rect.top + rect.height * (toCurveY(state.flowCurve.y2, yRange) / 100);
    return distance(clientX, clientY, h1x, h1y) <= distance(clientX, clientY, h2x, h2y) ? "h1" : "h2";
  };

  const startDrag = (handleName, event) => {
    event.preventDefault();
    const point = getPoint(event);
    state.draggingHandle = handleName;
    updateFlowHandleFromPointer(handleName, point.x, point.y);
  };

  const moveDrag = (event) => {
    if (!state.draggingHandle) return;
    event.preventDefault();
    const point = getPoint(event);
    updateFlowHandleFromPointer(state.draggingHandle, point.x, point.y);
  };

  const stopDrag = () => {
    state.draggingHandle = null;
  };

  ui.flowHandle1.addEventListener("pointerdown", (event) => startDrag("h1", event));
  ui.flowHandle2.addEventListener("pointerdown", (event) => startDrag("h2", event));
  ui.flowHandle1.addEventListener("mousedown", (event) => startDrag("h1", event));
  ui.flowHandle2.addEventListener("mousedown", (event) => startDrag("h2", event));
  ui.flowHandle1.addEventListener("touchstart", (event) => startDrag("h1", event), { passive: false });
  ui.flowHandle2.addEventListener("touchstart", (event) => startDrag("h2", event), { passive: false });

  ui.flowEditor.addEventListener("mousedown", (event) => {
    if (event.target === ui.flowHandle1 || event.target === ui.flowHandle2) return;
    startDrag(nearestHandle(event.clientX, event.clientY), event);
  });
  ui.flowEditor.addEventListener("touchstart", (event) => {
    if (event.target === ui.flowHandle1 || event.target === ui.flowHandle2) return;
    const point = getPoint(event);
    startDrag(nearestHandle(point.x, point.y), event);
  }, { passive: false });

  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("mousemove", moveDrag);
  window.addEventListener("touchmove", moveDrag, { passive: false });
  window.addEventListener("pointerup", stopDrag);
  window.addEventListener("mouseup", stopDrag);
  window.addEventListener("touchend", stopDrag);
  window.addEventListener("pointercancel", stopDrag);

  renderFlowEditor();
}

function bindCurveButtons() {
  ui.curveButtons = Array.from(document.querySelectorAll(".curve-btn"));
  updateCurveButtons();

  ui.curveButtons.forEach((button, slotIndex) => {
    if (!button) return;
    button.addEventListener("click", async (event) => {
      if (state.isBusy) return;

      if (event.shiftKey) {
        state.curveSlots[slotIndex] = null;
        persistCurveSlots();
        updateCurveButtons();
        showToast(`C${slotIndex + 1} cleared`);
        return;
      }

      if (event.altKey) {
        state.curveSlots[slotIndex] = normalizeCurve(state.flowCurve);
        persistCurveSlots();
        updateCurveButtons();
        showToast(`Saved current curve to C${slotIndex + 1}`);
        return;
      }

      const slotCurve = normalizeCurve(state.curveSlots[slotIndex]);
      if (!slotCurve) {
        showToast(`C${slotIndex + 1} is empty. Alt+click to set.`, "error");
        return;
      }

      state.flowCurve = slotCurve;
      renderFlowEditor();
      await applyCurveToKeyframes(slotCurve, `Applied C${slotIndex + 1} curve`);
    });
  });
}

function startProjectInfoPolling() {
  if (state.projectInfoTimer) {
    window.clearInterval(state.projectInfoTimer);
  }
  state.projectInfoTimer = window.setInterval(() => {
    refreshProjectInfo();
  }, 2000);
}

function showToast(message, type = "info") {
  if (!ui.toast) return;
  ui.toast.textContent = message;

  let normalizedType = type;
  if ((type === "error" || type === "success") && !state.semanticFeedbackEnabled) {
    normalizedType = "info";
  }

  ui.toast.classList.remove("error", "success");
  if (normalizedType === "error") ui.toast.classList.add("error");
  if (normalizedType === "success") ui.toast.classList.add("success");
  ui.toast.classList.add("show");
  window.clearTimeout(showToast._timer);
  showToast._timer = window.setTimeout(() => {
    ui.toast.classList.remove("show");
  }, 2300);
}

function getStoredTheme() {
  try {
    const rawTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return rawTheme === "light" ? "light" : "dark";
  } catch (error) {
    return "dark";
  }
}

function persistTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {}
}

function getStoredAccent() {
  try {
    const rawAccent = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return Object.prototype.hasOwnProperty.call(ACCENT_COLORS, rawAccent) ? rawAccent : "blue";
  } catch (error) {
    return "blue";
  }
}

function persistAccent(accentKey) {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accentKey);
  } catch (error) {}
}

function applyAccent(accentKey) {
  const key = Object.prototype.hasOwnProperty.call(ACCENT_COLORS, accentKey) ? accentKey : "blue";
  const accent = ACCENT_COLORS[key];
  document.documentElement.style.setProperty("--accent", accent.value);
  document.documentElement.style.setProperty("--accent-hover", accent.value);
  document.documentElement.style.setProperty("--accent-subtle", accent.subtle);
  document.documentElement.style.setProperty("--focus-ring", accent.value);
  if (ui.accentSelect) ui.accentSelect.value = key;
  document.querySelectorAll(".swatch[data-accent]").forEach((s) => {
    s.classList.toggle("active", s.dataset.accent === key);
  });
}

function getStoredSemanticFeedback() {
  try {
    const raw = window.localStorage.getItem(SEMANTIC_FEEDBACK_STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "off";
  } catch (error) {
    return true;
  }
}

function persistSemanticFeedback(enabled) {
  try {
    window.localStorage.setItem(SEMANTIC_FEEDBACK_STORAGE_KEY, enabled ? "on" : "off");
  } catch (error) {}
}

function applySemanticFeedback(enabled) {
  state.semanticFeedbackEnabled = !!enabled;
  document.documentElement.setAttribute("data-semantic-feedback", state.semanticFeedbackEnabled ? "on" : "off");
  if (ui.semanticColorsToggle) ui.semanticColorsToggle.checked = state.semanticFeedbackEnabled;
}

function applyTheme(theme) {
  const normalizedTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", normalizedTheme);
  if (ui.darkModeToggle) {
    ui.darkModeToggle.checked = normalizedTheme === "dark";
  }
}

function setBusy(value) {
  state.isBusy = value;
  document.body.style.cursor = value ? "wait" : "default";
}

function escapeForExtendScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function evalHost(functionName, args = {}) {
  return new Promise((resolve, reject) => {
    if (!csInterface) {
      reject(new Error("CSInterface unavailable. Run this as a CEP extension in After Effects."));
      return;
    }

    const payload = JSON.stringify(args || {});
    const escapedPayload = escapeForExtendScript(payload);
    const escapedFnName = String(functionName).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = [
      "(function(){",
      "  try {",
      "    if (typeof $ === 'undefined' || !$._AFTERLAB) {",
      "      return JSON.stringify({ ok: false, error: 'AfterLab host is unavailable. Reload the extension to re-run host/AfterLabHost.jsx.' });",
      "    }",
      `    var fn = $._AFTERLAB[\"${escapedFnName}\"];`,
      "    if (typeof fn !== 'function') {",
      `      return JSON.stringify({ ok: false, error: 'Host function not found: ${escapedFnName}' });`,
      "    }",
      `    return fn('${escapedPayload}');`,
      "  } catch (e) {",
      "    return JSON.stringify({ ok: false, error: 'Host exception: ' + String(e) });",
      "  }",
      "}())",
    ].join("\n");

    csInterface.evalScript(script, (result) => {
      if (result === "EvalScript error." || typeof result === "undefined" || result === "") {
        reject(new Error("Host script evaluation failed. Check that host/AfterLabHost.jsx compiles in After Effects."));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(result);
      } catch (error) {
        reject(new Error(`Invalid host response: ${result}`));
        return;
      }

      if (!parsed.ok) {
        reject(new Error(parsed.error || "Unknown AfterLab host error."));
        return;
      }

      resolve(parsed);
    });
  });
}

async function runAction(functionName, args = {}, successMessage = "Done") {
  if (state.isBusy) return;
  setBusy(true);
  try {
    const result = await evalHost(functionName, args);
    const msg = result.message || successMessage;
    showToast(msg, result.warn ? "error" : "success");
    return result;
  } catch (error) {
    showToast(error.message || "Action failed", "error");
    throw error;
  } finally {
    setBusy(false);
  }
}

function openSettings() {
  ui.mainView.classList.add("hidden");
  ui.settingsView.classList.remove("hidden");
}

function closeSettings() {
  ui.settingsView.classList.add("hidden");
  ui.mainView.classList.remove("hidden");
}

function updateMacroButtons(states) {
  ui.macroButtons.forEach((button, index) => {
    const filled = !!(states[index] && states[index].filled);
    button.classList.toggle("filled", filled);
    button.textContent = `M${index + 1}${filled ? "*" : ""}`;
  });
}

async function refreshMacros() {
  try {
    const result = await evalHost("getMacroStates");
    updateMacroButtons(result.states || []);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function showTextPrompt({ title, placeholder = "", initialValue = "" }) {
  return new Promise((resolve) => {
    ui.modalTitle.textContent = title;
    ui.modalInput.placeholder = placeholder;
    ui.modalInput.value = initialValue;
    ui.modalOverlay.classList.remove("hidden");

    state.modalResolver = resolve;

    const finish = (value, okPressed) => {
      ui.modalOverlay.classList.add("hidden");
      state.modalResolver = null;
      resolve({ ok: okPressed, value });
    };

    const onCancel = () => {
      cleanup();
      finish("", false);
    };

    const onOk = () => {
      cleanup();
      finish(ui.modalInput.value, true);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        cleanup();
        finish("", false);
      } else if (event.key === "Enter") {
        cleanup();
        finish(ui.modalInput.value, true);
      }
    };

    function cleanup() {
      ui.modalCancel.removeEventListener("click", onCancel);
      ui.modalOk.removeEventListener("click", onOk);
      ui.modalInput.removeEventListener("keydown", onKeyDown);
    }

    ui.modalCancel.addEventListener("click", onCancel);
    ui.modalOk.addEventListener("click", onOk);
    ui.modalInput.addEventListener("keydown", onKeyDown);

    window.setTimeout(() => ui.modalInput.focus(), 0);
  });
}

function bindAction(buttonId, handler) {
  const node = document.getElementById(buttonId);
  if (!node) return;
  node.addEventListener("click", handler);
}

function bindAccordionSections() {
  const sections = Array.from(document.querySelectorAll("#main-view details.collapsible-section"));
  if (!sections.length) return;

  let firstOpenFound = false;
  sections.forEach((section) => {
    if (section.open && !firstOpenFound) {
      firstOpenFound = true;
    } else {
      section.open = false;
    }
  });

  if (!firstOpenFound) {
    sections[0].open = true;
  }

  sections.forEach((section) => {
    section.addEventListener("toggle", () => {
      if (!section.open) return;
      sections.forEach((other) => {
        if (other !== section && other.open) other.open = false;
      });
    });
  });
}

function bindSectionNav() {
  ui.sectionNavButtons = Array.from(document.querySelectorAll("#main-view .section-nav-btn"));
  const sections = Array.from(document.querySelectorAll("#main-view .content-section"));
  if (!ui.mainView || !ui.sectionNavButtons.length || !sections.length) return;

  ui.mainView.classList.add("nav-mode");
  sections.forEach((section) => {
    section.open = true;
  });

  const activateSection = (targetId) => {
    sections.forEach((section) => {
      section.classList.toggle("is-active", section.id === targetId);
    });
    ui.sectionNavButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.target === targetId);
    });

    if (ui.tipsPanel) {
      ui.tipsPanel.classList.toggle("hidden", targetId !== "section-fast");
    }

    if (targetId === "section-quick") {
      refreshProjectInfo();
    }
  };

  ui.sectionNavButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.dataset.target;
      if (!targetId) return;
      activateSection(targetId);
    });
  });

  const initialButton = ui.sectionNavButtons.find((button) => button.classList.contains("active")) || ui.sectionNavButtons[0];
  if (initialButton && initialButton.dataset.target) {
    activateSection(initialButton.dataset.target);
  }
}

function buildAnchorGrid() {
  const grid = document.getElementById("anchor-grid");
  if (!grid) return;
  grid.innerHTML = "";

  ANCHOR_CELLS.forEach((cell) => {
    const button = document.createElement("button");
    button.className = "anchor-cell";
    button.type = "button";
    button.title = `Set anchor: ${cell.tip}`;
    button.setAttribute("aria-label", `Set anchor: ${cell.tip}`);
    button.addEventListener("click", async () => {
      await runAction("setAnchorPoint", { hPct: cell.hPct, vPct: cell.vPct }, `Anchor set: ${cell.tip}`);
    });
    grid.appendChild(button);
  });
}

function bindMacroButtons() {
  ui.macroButtons = Array.from(document.querySelectorAll(".macro-btn"));
  ui.macroButtons.forEach((button, slotIndex) => {
    if (!button) return;
    button.addEventListener("click", async (event) => {
      if (state.isBusy) return;
      try {
        if (event.shiftKey) {
          await runAction("clearMacro", { slotIndex }, `M${slotIndex + 1} cleared`);
        } else if (event.altKey) {
          await runAction("captureMacro", { slotIndex }, `Captured into M${slotIndex + 1}`);
        } else {
          await runAction("applyMacro", { slotIndex }, `Applied M${slotIndex + 1}`);
        }
      } finally {
        await refreshMacros();
      }
    });
  });
}

function bindMainActions() {
  bindAction("btn-precompose", async () => {
    const answer = await showTextPrompt({
      title: "Pre-Compose Name",
      placeholder: "Pre-Comp 1",
      initialValue: "Pre-Comp 1",
    });
    if (!answer.ok) return;
    const name = answer.value.trim() || "Pre-Comp 1";
    await runAction("preCompose", { name }, `Pre-composed into ${name}`);
  });

  bindAction("btn-center", () => runAction("centerLayers", {}, "Centered selected layers"));
  bindAction("btn-save-png", () => runAction("saveFrame", {}, "Frame queued to render queue"));

  bindAction("btn-adj", () => runAction("addAdjLayer", {}, "Adjustment layer added"));
  bindAction("btn-cam", () => runAction("addCamera", {}, "Camera + controller added"));

  const solBtn = document.getElementById("btn-sol");
  if (solBtn) {
    solBtn.addEventListener("click", (event) => {
      if (event.altKey) {
        runAction("addSolid", { openNative: true }, "Opened native Solid settings");
      } else {
        runAction("addSolid", {}, "Solid layer added");
      }
    });
  }

  const nulBtn = document.getElementById("btn-nul");
  if (nulBtn) {
    nulBtn.addEventListener("click", (event) => {
      if (event.altKey) {
        runAction("addNull", { createNullAndParent: true }, "Null controller created and parented");
      } else {
        runAction("addNull", {}, "Null object added");
      }
    });
  }

  bindAction("btn-trm", () => runAction("trimToTime", {}, "Trimmed selected layers"));
  bindAction("btn-ren", async () => {
    const answer = await showTextPrompt({
      title: "Rename Selected Layer",
      placeholder: "New layer name",
      initialValue: "",
    });
    if (!answer.ok) return;
    const name = answer.value.trim();
    if (!name) {
      showToast("Name cannot be empty", "error");
      return;
    }
    await runAction("renameLayer", { name }, `Renamed to ${name}`);
  });
  bindAction("btn-dup", () => runAction("duplicate", {}, "Duplicated selected layers"));
  bindAction("btn-cls", () => runAction("closeAllComps", {}, "Closed comp viewers"));

  bindAction("btn-freeze", () => runAction("freezeFrame", {}, "Freeze frame applied"));
  bindAction("btn-mirror-h", () => runAction("mirrorH", {}, "Mirrored horizontal"));
  bindAction("btn-mirror-v", () => runAction("mirrorV", {}, "Mirrored vertical"));
  bindAction("btn-reset", () => runAction("resetTransforms", {}, "Transforms reset"));

  bindAction("btn-bg-solid", () => runAction("addBGSolid", {}, "Background solid added"));
  bindAction("btn-vignette", () => runAction("addVignette", {}, "Vignette added"));
  bindAction("btn-null-parent", () => runAction("createNullAndParent", {}, "Null + Parent complete"));
  bindAction("btn-shape", () => runAction("addShapeLayer", {}, "Shape layer added"));

  bindAction("btn-gaussian", async () => {
    const answer = await showTextPrompt({
      title: "Gaussian Blur Amount",
      placeholder: "20",
      initialValue: "20",
    });
    if (!answer.ok) return;
    const amount = Number(answer.value);
    if (Number.isNaN(amount) || amount < 0) {
      showToast("Enter a valid positive number", "error");
      return;
    }
    await runAction("gaussianBlur", { amount }, `Gaussian Blur ${amount}px applied`);
  });

  bindAction("btn-lens-blur", () => runAction("cameraLensBlur", {}, "Lens blur applied"));

  bindAction("btn-flow-apply", () => applyCurveToKeyframes(state.flowCurve, "Flow easing applied"));
}

function bindSettingsActions() {
  ui.settingsToggle.addEventListener("click", openSettings);
  ui.settingsBack.addEventListener("click", closeSettings);

  if (ui.darkModeToggle) {
    ui.darkModeToggle.addEventListener("change", () => {
      const nextTheme = ui.darkModeToggle.checked ? "dark" : "light";
      applyTheme(nextTheme);
      persistTheme(nextTheme);
    });
  }

  if (ui.accentSelect) {
    ui.accentSelect.addEventListener("change", () => {
      const accentKey = ui.accentSelect.value;
      applyAccent(accentKey);
      persistAccent(accentKey);
    });
  }

  document.querySelectorAll(".swatch[data-accent]").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      const key = swatch.dataset.accent;
      applyAccent(key);
      persistAccent(key);
    });
  });

  if (ui.semanticColorsToggle) {
    ui.semanticColorsToggle.addEventListener("change", () => {
      const enabled = ui.semanticColorsToggle.checked;
      applySemanticFeedback(enabled);
      persistSemanticFeedback(enabled);
      showToast(`Semantic toast colors ${enabled ? "enabled" : "disabled"}`);
    });
  }
}

function cacheUi() {
  ui.mainView = document.getElementById("main-view");
  ui.settingsView = document.getElementById("settings-view");
  ui.settingsToggle = document.getElementById("settings-toggle");
  ui.settingsBack = document.getElementById("settings-back");

  ui.modalOverlay = document.getElementById("modal-overlay");
  ui.modalTitle = document.getElementById("modal-title");
  ui.modalInput = document.getElementById("modal-input");
  ui.modalCancel = document.getElementById("modal-cancel");
  ui.modalOk = document.getElementById("modal-ok");
  ui.toast = document.getElementById("toast");

  ui.darkModeToggle = document.getElementById("darkmode-toggle");
  ui.accentSelect = document.getElementById("accent-select");
  ui.semanticColorsToggle = document.getElementById("semantic-colors-toggle");

  ui.flowEditor = document.getElementById("flow-editor");
  ui.flowPath = document.getElementById("flow-path");
  ui.flowGuideOut = document.getElementById("flow-guide-out");
  ui.flowGuideIn = document.getElementById("flow-guide-in");
  ui.flowHandle1 = document.getElementById("flow-h1");
  ui.flowHandle2 = document.getElementById("flow-h2");
  ui.flowValues = document.getElementById("flow-values");
  ui.flowApplyBtn = document.getElementById("btn-flow-apply");
  ui.tipsPanel = document.getElementById("tips-panel");
  ui.infoProjectName = document.getElementById("info-project-name");
  ui.infoCompName = document.getElementById("info-comp-name");
  ui.infoCompSize = document.getElementById("info-comp-size");
  ui.infoFrameRate = document.getElementById("info-frame-rate");
  ui.infoLastSaved = document.getElementById("info-last-saved");
}

async function init() {
  cacheUi();
  applyTheme(getStoredTheme());
  applyAccent(getStoredAccent());
  applySemanticFeedback(getStoredSemanticFeedback());
  bindSectionNav();
  startProjectInfoPolling();
  loadCurveSlots();
  bindFlowEditor();
  bindCurveButtons();
  buildAnchorGrid();
  bindMacroButtons();
  bindMainActions();
  bindSettingsActions();

  if (!csInterface) {
    showToast("CSInterface unavailable. Run this panel from AE CEP host.", "error");
    return;
  }

  await refreshMacros();
  await refreshProjectInfo();
  showToast("AfterLab CEP panel ready");
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    showToast(error.message || "Initialization failed", "error");
  });
});
