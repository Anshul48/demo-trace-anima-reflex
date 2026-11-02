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
    t0: 0,
    firstResultAt: 0,
    tickTimer: null
  };

  function qs(id) { return document.getElementById(id); }

  function setStatus(msg) { qs("statusLine").textContent = msg; }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fetchJSON(url, options) {
    return fetch(url, options).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (body) {
          throw new Error("request failed " + resp.status + " for " + url + ": " + body.slice(0, 200));
        });
      }
      return resp.json();
    });
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
      btn.className = "sample" + (s.id === state.currentId ? " active" : "");
      btn.setAttribute("data-sample", s.id);
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
    if (!state.currentSample) return;
    qs("chainName").textContent = "for " + state.currentSample.id;
    state.currentSample.chain.forEach(function (tool) {
      var li = document.createElement("li");
      li.textContent = tool;
      ol.appendChild(li);
    });
    qs("inputPreview").textContent = JSON.stringify(state.currentSample.inputs || {}, null, 2);
  }

  function selectSample(id) {
    var found = null;
    state.samples.forEach(function (s) { if (s.id === id) found = s; });
    if (!found) return;
    state.currentId = id;
    fetchJSON("api/sample/" + encodeURIComponent(id) + ".json").then(function (data) {
      state.currentSample = data.sample;
      renderSamples();
      renderChain();
      setStatus("Sample loaded: " + state.currentSample.title + ". Press Run chain.");
    }).catch(function (err) {
      setStatus("Sample load failed: " + err.message);
    });
  }

  function runReplay() {
    return fetchJSON("api/replay/" + encodeURIComponent(state.currentId) + ".json").then(function (data) {
      var steps = data.replay.steps;
      var host = qs("steps");
      host.innerHTML = "";
      setProgress(0, steps.length, "0/" + steps.length + " replay");
      var chain = Promise.resolve();
      steps.forEach(function (step, i) {
        chain = chain.then(function () {
          var parts = makeStepCard(i, step.tool + (state.mode === "replay" ? " (replay)" : ""));
          parts.badge.className = "badge running";
          parts.badge.textContent = "running";
          host.appendChild(parts.card);
          setProgress(i, steps.length, (i + 1) + "/" + steps.length + " " + step.tool);
          var wait = Math.min(Math.max(step.duration_ms || 220, 60), 600);
          return sleep(wait).then(function () {
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
        setStatus("Replay complete: " + steps.length + " steps for " + state.currentId + ".");
      });
    });
  }

  function runLive(endpoint) {
    var tools = state.currentSample.chain.slice();
    var host = qs("steps");
    host.innerHTML = "";
    setProgress(0, tools.length, "0/" + tools.length + " live");
    var chain = Promise.resolve();
    tools.forEach(function (tool, i) {
      chain = chain.then(function () {
        var parts = makeStepCard(i, tool + " (live)");
        parts.badge.className = "badge running";
        parts.badge.textContent = "running";
        host.appendChild(parts.card);
        setProgress(i, tools.length, (i + 1) + "/" + tools.length + " " + tool);
        return fetchJSON(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: tool, input: state.currentSample.inputs || {} })
        }).then(function (res) {
          parts.badge.className = "badge ok";
          parts.badge.textContent = "done";
          renderOutput(res.output, parts.box);
          markFirstResult();
          setProgress(i + 1, tools.length);
        }).catch(function (err) {
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
      setStatus("Live run attempted: " + tools.length + " steps for " + state.currentId + ".");
    });
  }

  function runChain() {
    if (state.running) return;
    if (!state.currentSample) {
      setStatus("No sample selected.");
      return;
    }
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
    var job = state.mode === "live" ? runLive(endpoint) : runReplay();
    job.catch(function (err) {
      setStatus("Run failed: " + err.message);
    }).then(function () {
      state.running = false;
      qs("runBtn").disabled = false;
    });
  }

  function toggleMode() {
    var live = qs("modeLive").checked;
    state.mode = live ? "live" : "replay";
    setStatus("Mode: " + state.mode.toUpperCase() + ".");
  }

  function onKey(ev) {
    var tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (ev.key >= "1" && ev.key <= "9") {
      var i = Number(ev.key) - 1;
      if (i < state.samples.length) selectSample(state.samples[i].id);
    } else if (ev.key === "r" || ev.key === "R") {
      runChain();
    } else if (ev.key === " ") {   /* LIVE shortcut disabled in the hosted copy */
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
    qs("runBtn").addEventListener("click", runChain);
    qs("modeReplay").addEventListener("change", toggleMode);
    qs("modeLive").addEventListener("change", toggleMode);
    document.addEventListener("keydown", onKey);
    fetchJSON("api/samples.json").then(function (data) {
      state.samples = data.samples || [];
      renderSamples();
      if (state.samples.length) {
        selectSample(state.samples[0].id);
      } else {
        setStatus("No samples found under samples/.");
      }
    }).catch(function (err) {
      setStatus("Could not load samples: " + err.message);
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
