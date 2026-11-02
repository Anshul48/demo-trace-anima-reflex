/* Demo shell app: samples, replay/live chain runner, results renderer.
   No external requests: only same-origin relative paths. */
(function () {
  "use strict";

  var state = {
    samples: [],
    currentId: null,
    currentSample: null,
    mode: "replay",
    running: false,
    selectionToken: 0,
    sampleController: null,
    run: null,
    t0: 0,
    firstResultAt: 0,
    tickTimer: null
  };

  function qs(id) { return document.getElementById(id); }

  function setStatus(msg) { qs("statusLine").textContent = msg; }

  function abortError() {
    var err = new Error("Cancelled");
    err.name = "AbortError";
    return err;
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      function cancel() {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        reject(abortError());
      }
      var timer = setTimeout(function () {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      signal.addEventListener("abort", cancel);
      if (signal.aborted) cancel();
    });
  }

  // Bound the whole request, including JSON decoding. Tokens also guard against
  // responses from a cache/mock/transport that ignores AbortController.
  function fetchJSON(url, options) {
    options = options || {};
    var parent = options.signal;
    var controller = new AbortController();
    var timer;
    var cancel;
    var request = new Promise(function (resolve, reject) {
      cancel = function () {
        controller.abort();
        reject(abortError());
      };
      if (parent) parent.addEventListener("abort", cancel);
      timer = setTimeout(function () {
        controller.abort();
        reject(new Error("Request timed out. Try again."));
      }, 4000);
      if (parent && parent.aborted) { cancel(); return; }
      Promise.resolve().then(function () {
        if (controller.signal.aborted) throw abortError();
        return fetch(url, Object.assign({}, options, { signal: controller.signal }));
      }).then(function (resp) {
        if (!resp.ok) throw new Error("request failed " + resp.status + " for " + url);
        return resp.json();
      }).then(function (data) {
        if (!data || data.ok === false) throw new Error("Invalid response for " + url);
        resolve(data);
      }).catch(reject);
    });
    function cleanup() {
      clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", cancel);
    }
    return request.then(function (data) { cleanup(); return data; }, function (err) {
      cleanup();
      throw err;
    });
  }

  function panelMessage(message, isError) {
    var host = qs("steps");
    host.innerHTML = "";
    var div = document.createElement("div");
    div.className = isError ? "err" : "hint";
    if (isError) div.setAttribute("role", "alert");
    div.textContent = message;
    host.appendChild(div);
  }

  function cancelRun() {
    var run = state.run;
    state.run = null;
    state.running = false;
    if (run) run.controller.abort();
    stopTTFR();
  }

  function checkRun(run) {
    if (state.run !== run || run.controller.signal.aborted) throw abortError();
  }

  function validSample(sample) {
    return sample && typeof sample.id === "string" && sample.id &&
      typeof sample.title === "string" && sample.title &&
      Array.isArray(sample.chain) && sample.chain.length > 0 &&
      sample.chain.every(function (tool) { return typeof tool === "string" && tool; }) &&
      (sample.inputs === undefined || (sample.inputs !== null &&
        typeof sample.inputs === "object" && !Array.isArray(sample.inputs)));
  }

  function startTTFR() {
    stopTTFR();
    state.t0 = performance.now();
    state.firstResultAt = 0;
    qs("ttfr").textContent = "0 ms";
    state.tickTimer = setInterval(function () {
      var end = state.firstResultAt || performance.now();
      qs("ttfr").textContent = Math.round(end - state.t0) + " ms";
    }, 50);
  }

  function markFirstResult() {
    if (!state.firstResultAt) {
      state.firstResultAt = performance.now();
      qs("ttfr").textContent = Math.round(state.firstResultAt - state.t0) + " ms";
    }
  }

  function stopTTFR() {
    if (state.tickTimer) {
      clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
  }

  function setProgress(done, total, label) {
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    qs("progressBar").style.width = pct + "%";
    qs("progressLabel").textContent = label || (done + "/" + total);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderOutput(output, box) {
    if (!output || typeof output !== "object") {
      box.innerHTML = '<div class="err">missing output</div>';
      return;
    }
    if (output.kind === "text") {
      var pre = document.createElement("pre");
      pre.textContent = output.text || "";
      box.appendChild(pre);
    } else if (output.kind === "table") {
      var table = document.createElement("table");
      var thead = document.createElement("thead");
      var hr = document.createElement("tr");
      (output.columns || []).forEach(function (c) {
        var th = document.createElement("th");
        th.textContent = c;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement("tbody");
      (output.rows || []).forEach(function (row) {
        var tr = document.createElement("tr");
        row.forEach(function (cell) {
          var td = document.createElement("td");
          td.textContent = cell === null || cell === undefined ? "" : String(cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      box.appendChild(table);
    } else if (output.kind === "image") {
      var uri = output.data_uri || "";
      if (uri.indexOf("data:image/") !== 0) {
        box.innerHTML = '<div class="err">image blocked: data URI required</div>';
        return;
      }
      var img = document.createElement("img");
      img.src = uri;
      img.alt = output.alt || "result image";
      box.appendChild(img);
    } else {
      box.innerHTML = '<div class="err">unknown output kind: ' + escapeHtml(output.kind) + "</div>";
    }
  }

  function makeStepCard(index, tool) {
    var card = document.createElement("div");
    card.className = "step";
    var head = document.createElement("div");
    head.className = "step-head";
    var name = document.createElement("span");
    name.className = "step-tool";
    name.textContent = (index + 1) + ". " + tool;
    var badge = document.createElement("span");
    badge.className = "badge pending";
    badge.textContent = "pending";
    head.appendChild(name);
    head.appendChild(badge);
    card.appendChild(head);
    var box = document.createElement("div");
    card.appendChild(box);
    return { card: card, badge: badge, box: box };
  }

  function renderSamples() {
    var list = qs("sampleList");
    list.innerHTML = "";
    state.samples.forEach(function (s, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sample" + (s.id === state.currentId ? " active" : "");
      btn.setAttribute("data-sample", s.id);
      btn.setAttribute("aria-pressed", String(s.id === state.currentId));
      var t = document.createElement("div");
      t.className = "t";
      t.textContent = (i + 1) + ". " + s.title;
      var d = document.createElement("div");
      d.className = "d";
      d.textContent = (s.description || "") + " [" + s.chain.join(" > ") + "]";
      btn.appendChild(t);
      btn.appendChild(d);
      btn.addEventListener("click", function () { selectSample(s.id); });
      list.appendChild(btn);
    });
  }

  function renderChain() {
    var ol = qs("chainList");
    ol.innerHTML = "";
    qs("chainName").textContent = "";
    qs("inputPreview").textContent = "{}";
    if (!state.currentSample) return;
    qs("chainName").textContent = "for " + state.currentSample.id;
    state.currentSample.chain.forEach(function (tool) {
      var li = document.createElement("li");
      li.textContent = tool;
      ol.appendChild(li);
    });
    qs("inputPreview").textContent = JSON.stringify(state.currentSample.inputs || {}, null, 2);
  }

  // Keep native sample buttons in the DOM so keyboard focus survives loading.
  function updateSampleButtons() {
    var buttons = qs("sampleList").children;
    state.samples.forEach(function (sample, i) {
      buttons[i].className = "sample" + (sample.id === state.currentId ? " active" : "");
      buttons[i].setAttribute("aria-pressed", String(sample.id === state.currentId));
    });
  }

  function selectSample(id) {
    var token = ++state.selectionToken;
    if (state.sampleController) state.sampleController.abort();
    var controller = new AbortController();
    state.sampleController = controller;
    cancelRun();
    state.currentId = null;
    state.currentSample = null;
    qs("runBtn").disabled = true;
    qs("ttfr").textContent = "-- ms";
    renderChain();
    updateSampleButtons();
    setProgress(0, 0, "loading");
    var found = state.samples.some(function (s) { return s.id === id; });
    function failed(err) {
      if (token !== state.selectionToken) return;
      state.sampleController = null;
      var message = "Sample load failed: " + err.message + " Choose a sample to retry.";
      setStatus(message);
      panelMessage(message, true);
      setProgress(0, 0, "error");
    }
    if (!found) {
      failed(new Error("Unknown sample: " + id));
      return Promise.resolve();
    }
    setStatus("Loading sample: " + id + "...");
    panelMessage("Loading sample...");
    return fetchJSON("api/sample/" + encodeURIComponent(id) + ".json", { signal: controller.signal }).then(function (data) {
      if (token !== state.selectionToken) return;
      if (!validSample(data.sample) || data.sample.id !== id) throw new Error("Invalid or mismatched sample");
      // Commit id and inputs together, only after the latest request succeeds.
      state.currentSample = data.sample;
      state.currentId = id;
      state.sampleController = null;
      updateSampleButtons();
      renderChain();
      qs("runBtn").disabled = false;
      setProgress(0, 0, "ready");
      panelMessage("Sample ready. Press Run chain (R) for recorded results.");
      setStatus("Sample loaded: " + state.currentSample.title + ". Press Run chain.");
    }).catch(failed);
  }

  function runReplay(run) {
    return fetchJSON("api/replay/" + encodeURIComponent(run.id) + ".json", { signal: run.controller.signal }).then(function (data) {
      checkRun(run);
      var replay = data.replay;
      if (!replay || replay.sample_id !== run.id || !Array.isArray(replay.steps) ||
          !replay.steps.length || !replay.steps.every(function (step) {
            return step && typeof step.tool === "string" &&
              (step.status === "ok" || step.status === "error");
          })) throw new Error("Invalid or mismatched replay");
      var steps = replay.steps;
      var host = qs("steps");
      host.innerHTML = "";
      setProgress(0, steps.length, "0/" + steps.length + " replay");
      var chain = Promise.resolve();
      steps.forEach(function (step, i) {
        chain = chain.then(function () {
          checkRun(run);
          var parts = makeStepCard(i, step.tool + " (replay)");
          parts.badge.className = "badge running";
          parts.badge.textContent = "running";
          host.appendChild(parts.card);
          setProgress(i, steps.length, (i + 1) + "/" + steps.length + " " + step.tool);
          var wait = Math.min(Math.max(step.duration_ms || 220, 60), 600);
          return sleep(wait, run.controller.signal).then(function () {
            checkRun(run);
            if (step.status === "error") {
              parts.badge.className = "badge error";
              parts.badge.textContent = "error";
              var err = document.createElement("div");
              err.className = "err";
              err.textContent = step.error || "step failed";
              parts.box.appendChild(err);
            } else {
              parts.badge.className = "badge ok";
              parts.badge.textContent = "done";
              renderOutput(step.output, parts.box);
            }
            markFirstResult();
            setProgress(i + 1, steps.length);
          });
        });
      });
      return chain.then(function () {
        checkRun(run);
        setStatus("Replay complete: " + steps.length + " steps for " + run.id + ".");
      });
    });
  }

  function runLive(endpoint, run) {
    var tools = run.sample.chain.slice();
    var host = qs("steps");
    host.innerHTML = "";
    setProgress(0, tools.length, "0/" + tools.length + " live");
    var chain = Promise.resolve();
    tools.forEach(function (tool, i) {
      chain = chain.then(function () {
        checkRun(run);
        var parts = makeStepCard(i, tool + " (live)");
        parts.badge.className = "badge running";
        parts.badge.textContent = "running";
        host.appendChild(parts.card);
        setProgress(i, tools.length, (i + 1) + "/" + tools.length + " " + tool);
        return fetchJSON(endpoint, {
          signal: run.controller.signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: tool, input: run.sample.inputs || {} })
        }).then(function (res) {
          checkRun(run);
          parts.badge.className = "badge ok";
          parts.badge.textContent = "done";
          renderOutput(res.output, parts.box);
          markFirstResult();
          setProgress(i + 1, tools.length);
        }).catch(function (err) {
          checkRun(run);
          parts.badge.className = "badge error";
          parts.badge.textContent = "error";
          var div = document.createElement("div");
          div.className = "err";
          div.textContent = "live call failed: " + err.message;
          parts.box.appendChild(div);
          setProgress(i + 1, tools.length);
        });
      });
    });
    return chain.then(function () {
      checkRun(run);
      setStatus("Live run attempted: " + tools.length + " steps for " + run.id + ".");
    });
  }

  function runChain() {
    if (state.running) return;
    if (!state.currentSample) {
      setStatus("Load a sample before running.");
      return;
    }
    var run = { id: state.currentId, sample: state.currentSample,
      mode: state.mode, controller: new AbortController() };
    state.run = run;
    state.running = true;
    qs("runBtn").disabled = true;
    startTTFR();
    setStatus("Running " + state.mode + " chain for " + state.currentId + "...");
    var endpoint = qs("liveEndpoint").value.trim() || "/api/live";
    try {
      var u = new URL(endpoint, location.href);
      if (u.origin !== location.origin || u.protocol.indexOf("http") !== 0) { endpoint = "/api/live"; qs("liveEndpoint").value = endpoint; }
      else { endpoint = u.pathname + u.search; }
    } catch (e) { endpoint = "/api/live"; }
    panelMessage("Loading " + run.mode + " results...");
    return Promise.resolve().then(function () {
      checkRun(run);
      return run.mode === "live" ? runLive(endpoint, run) : runReplay(run);
    }).catch(function (err) {
      if (state.run !== run) return;
      var message = "Run failed: " + err.message + " Press Run chain to retry.";
      setStatus(message);
      panelMessage(message, true);
      setProgress(0, 0, "error");
    }).then(function () {
      if (state.run !== run) return;
      stopTTFR();
      state.run = null;
      state.running = false;
      qs("runBtn").disabled = !state.currentSample;
    });
  }

  function toggleMode() {
    var live = qs("modeLive").checked;
    state.mode = live ? "live" : "replay";
    setStatus("Mode: " + state.mode.toUpperCase() + ".");
  }

  function onKey(ev) {
    var tag = (ev.target && ev.target.tagName) || "";
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.repeat || ev.defaultPrevented ||
        (ev.target && ev.target.isContentEditable) ||
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (ev.key >= "1" && ev.key <= "9") {
      var i = Number(ev.key) - 1;
      if (i < state.samples.length) { ev.preventDefault(); selectSample(state.samples[i].id); }
    } else if (ev.key === "r" || ev.key === "R") {
      ev.preventDefault();
      runChain();
    } else if (ev.key === " ") {   /* LIVE shortcut disabled in the hosted copy */
      if (qs("modeLive").disabled) return;
      ev.preventDefault();
      var toLive = state.mode !== "live";
      qs("modeLive").checked = toLive;
      qs("modeReplay").checked = !toLive;
      toggleMode();
    } else if (ev.key === "?" || ev.key === "h" || ev.key === "H") {
      var box = qs("helpBox");
      box.hidden = !box.hidden;
    }
  }

  function init() {
    qs("runBtn").disabled = true;
    setStatus("Loading preloaded samples...");
    panelMessage("Loading preloaded samples...");
    qs("runBtn").addEventListener("click", runChain);
    qs("modeReplay").addEventListener("change", toggleMode);
    qs("modeLive").addEventListener("change", toggleMode);
    document.addEventListener("keydown", onKey);
    fetchJSON("api/samples.json").then(function (data) {
      if (!Array.isArray(data.samples) || !data.samples.every(validSample) ||
          new Set(data.samples.map(function (sample) { return sample.id; })).size !== data.samples.length) {
        throw new Error("Invalid sample list");
      }
      state.samples = data.samples;
      renderSamples();
      if (state.samples.length) {
        return selectSample(state.samples[0].id);
      } else {
        throw new Error("No samples found under samples/.");
      }
    }).catch(function (err) {
      var message = "Could not load samples: " + err.message + " Reload the page to retry.";
      setStatus(message);
      panelMessage(message, true);
      setProgress(0, 0, "error");
    });
    setProgress(0, 0, "idle");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for smoke checks only; page wiring uses the closures above.
  window.demoShell = { state: state, runChain: runChain, selectSample: selectSample };
})();
