/* VTE Log Manager PWA — stage 3: record new logs, edit logs, presets, calibration measurements. */
(function (root) {
  "use strict";
  const Core = root.VTECore;
  const TEST_PREFIX = "_mobile_test/";

  function create(ctx) {
    const {app, $, $$, esc, status, show, loadModel, openLog, config} = ctx;
    const {fmt, calcRequiredMonitor, ALL_PORTS} = Core;
    let draft = null;
    let saveTimer = null;
    let tickTimer = null;
    let wakeLock = null;

    const testMode = () => localStorage.getItem("vte.testMode") === "1";
    const author = () => localStorage.getItem("vte.author") || "";
    const pad = n => String(n).padStart(2, "0");
    const nowText = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const deviceName = () => {
      const ua = navigator.userAgent;
      return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
    };
    const savePrefix = () => (testMode() ? TEST_PREFIX : "");
    // ---------- co-deposition groups ----------
    // A co-dep card is consecutive layers sharing `codep`; these fields are kept identical across its members.
    const SHARED_KEYS = ["mask", "codep_total", "started_at", "ended_at", "started_ms", "ended_ms", "start_pressure", "end_pressure", "notes", "collapsed", "settings_open"];
    function blocks() {
      const out = [];
      draft.layers.forEach((l, i) => {
        const last = out[out.length - 1];
        if (l.codep && last && draft.layers[last[0]].codep === l.codep) last.push(i); else out.push([i]);
      });
      return out;
    }
    const blockOf = i => blocks().find(b => b.includes(i)) || [i];
    function setShared(i, k, v) {
      for (const j of blockOf(i)) draft.layers[j][k] = v;
    }
    function syncCodep(i) {
      const members = blockOf(i).map(j => draft.layers[j]);
      if (!members[0].codep) return;
      for (const m of members) { m.target_actual = Core.codepShare(members, m); recalcMonitor(m); }
    }
    // Actual deposition shares from the typed monitor rates (rate × ratio), to catch a drifting doping ratio.
    function dopingText(idx) {
      const members = idx.map(j => draft.layers[j]);
      for (const [key, label] of [["end_rate", "끝"], ["start_rate", "시작"]]) {
        const actual = members.map(m => (Core.toFloat(m[key]) ?? NaN) * (Core.toFloat(m.ratio) ?? NaN));
        const sum = actual.reduce((a, b) => a + b, 0);
        if (actual.every(Number.isFinite) && sum > 0) return `현재 부피비 (${label} 레이트) ${actual.map(a => fmt(a / sum * 100, 1)).join(" : ")}`;
      }
      return "";
    }
    const hasData = l => ["target_actual", "start_pressure", "start_power", "start_temp", "start_rate", "end_pressure", "end_power", "end_temp", "end_rate", "measured_actual", "started_at", "ended_at", "notes"].some(k => String(l[k] || "").trim());

    function toWorkbook(sheets) {
      const wb = XLSX.utils.book_new();
      for (const s of sheets) {
        const ws = XLSX.utils.aoa_to_sheet(s.aoa);
        ws["!cols"] = (s.cols || []).map(wch => ({wch}));
        XLSX.utils.book_append_sheet(wb, ws, s.sheetTitle);
      }
      return new Uint8Array(XLSX.write(wb, {bookType: "xlsx", type: "array"}));
    }
    // Upload with the app's conflict rules. Returns {relPath, result} or null when the user cancels.
    // `fallbackPath`: where to save a new copy when an in-place update loses a conflict.
    // `auto`: replaying the offline queue, where nobody is there to answer; a lost update always becomes a new file.
    async function uploadFile(relPath, bytes, {rev = null, what = "파일", fallbackPath = null, auto = false} = {}) {
      let base = relPath, target = relPath;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const result = await app.client.upload(target, bytes, {rev});
          await VTEStore.cacheUploaded({store: app.store, XLSX, relPath: target, data: bytes, result});
          return {relPath: target, result};
        } catch (err) {
          if (err.status !== 409 || !/conflict/.test(err.summary || "")) throw err;
          if (rev) {
            if (!auto && !confirm(`다른 기기에서 먼저 수정된 ${what}예요.\n덮어쓰지 않고 새 파일로 저장할까요?`)) return null;
            rev = null;
            base = target = fallbackPath || relPath.replace(/\.xlsx$/i, "_copy.xlsx");
            continue;
          }
          target = base.replace(/\.xlsx$/i, `_${attempt + 2}.xlsx`);
        }
      }
      throw new Error("같은 이름의 파일이 계속 있어서 저장하지 못했어요.");
    }
    // ---------- offline upload queue ----------
    // A save that cannot reach Dropbox is kept on the phone (bytes + target + rev) and retried when back online.
    const isNetworkError = e => !navigator.onLine || e instanceof TypeError;
    const queueJobs = async () => (await app.store.get("uploadQueue")) || [];
    async function setQueue(jobs) {
      await app.store.set("uploadQueue", jobs);
      ctx.renderQueue?.(jobs);
    }
    async function enqueue(job) {
      const jobs = await queueJobs();
      jobs.push({id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, queuedAt: nowText(), error: "", ...job});
      await setQueue(jobs);
    }
    let flushing = false;
    async function flushQueue() {
      if (flushing || !navigator.onLine || !app.client?.isLoggedIn()) return;
      flushing = true;
      const done = [];
      try {
        for (const job of await queueJobs()) {
          try {
            const saved = await uploadFile(job.relPath, job.bytes, {rev: job.rev, what: job.what, fallbackPath: job.fallbackPath, auto: true});
            done.push(saved.relPath);
            await setQueue((await queueJobs()).filter(j => j.id !== job.id));
          } catch (e) {
            if (isNetworkError(e)) break;
            await setQueue((await queueJobs()).map(j => (j.id === job.id ? {...j, error: e.message} : j)));
          }
        }
      } finally {
        flushing = false;
      }
      if (done.length) {
        await loadModel();
        status(`대기 중이던 ${done.length}건 업로드 완료`);
        ctx.onQueueUploaded?.(done);
      }
    }
    async function removeJob(id) {
      await setQueue((await queueJobs()).filter(j => j.id !== id));
    }
    // A queued log goes back to being an editable draft (the queued upload is dropped).
    async function restoreJob(id) {
      const job = (await queueJobs()).find(j => j.id === id);
      if (!job?.draft) return;
      if (!(await replaceDraftOk())) return;
      draft = job.draft;
      await app.store.set("draft", draft);
      await removeJob(id);
      ctx.setTab("record");
    }
    function fileRev(realPath) {
      return app.files.get(realPath)?.rev || null;
    }

    // ---------- draft ----------
    async function loadDraft() {
      draft = (await app.store.get("draft")) || null;
      // Drafts from before start/end rates: the single rate becomes the start rate.
      for (const l of draft?.layers || []) {
        if (l.rate && !l.start_rate) l.start_rate = l.rate;
        delete l.rate;
      }
    }
    async function flush() {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      await app.store.set("draft", draft);
    }
    function persist() {
      $("#draftState").textContent = "저장 중…";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        saveTimer = null;
        await app.store.set("draft", draft);
        $("#draftState").textContent = "초안 저장됨";
      }, 250);
    }
    async function replaceDraftOk() {
      if (!draft || !draft.layers.some(hasData)) return true;
      return confirm("작성 중인 초안이 있어요. 버리고 새로 시작할까요?");
    }
    async function startDraft({type, layers = [], preset = "", editing = null, date = Core.currentYYMMDD(), createdAt = nowText()}) {
      draft = {type, date, memo: "", preset, layers: layers.length ? layers : [{...Core.DRAFT_LAYER_DEFAULTS}], editing, createdAt};
      if (!editing) draft.layers.forEach(l => autofill(l));
      await app.store.set("draft", draft);
      render();
    }

    // ---------- calibration helpers ----------
    function autofill(layer, {force = false} = {}) {
      const mat = String(layer.material || "").trim();
      if (mat && (force || !layer.ratio)) {
        const cal = app.model.latestCalibration(mat, layer.port || null, layer.tooling_factor || null);
        if (cal.ratio) layer.ratio = fmt(cal.ratio, 6);
        else if (force) layer.ratio = "";
        if (!layer.port && cal.source) layer.port = cal.source;
        if (!layer.tooling_factor && cal.tooling_factor !== null && cal.tooling_factor !== undefined) layer.tooling_factor = fmt(cal.tooling_factor);
      }
      recalcMonitor(layer);
    }
    function recalcMonitor(layer) {
      if (layer.monitor_manual) return;
      const v = calcRequiredMonitor(layer.target_actual, layer.ratio);
      layer.monitor = v === null ? "" : fmt(v, 4);
    }
    function applyCombo(layer, value) {
      const combo = app.model.comboOptions().find(c => c.label === value);
      if (!combo) { layer.material = value; return; }
      layer.material = combo.material;
      if (combo.source) layer.port = combo.source;
      if (combo.tooling_factor !== null && combo.tooling_factor !== undefined) layer.tooling_factor = fmt(combo.tooling_factor);
      if (combo.ratio) layer.ratio = fmt(combo.ratio, 6);
    }

    // ---------- screens ----------
    function render() {
      $("#saveTargetHint").textContent = testMode()
        ? "테스트 모드: 저장하면 VTE_MANAGER/_mobile_test/ 안에만 생겨요 (설정에서 변경)."
        : "실제 로그 폴더에 저장돼요.";
      $("#recordStart").hidden = Boolean(draft);
      $("#editor").hidden = !draft;
      $("#structurePanel").hidden = !draft || app.tab !== "record";
      if (draft) renderEditor(); else renderPresets();
      syncRunningState();
    }
    function renderPresets() {
      const q = $("#presetSearch").value.trim().toLowerCase();
      const presets = app.model.presets.filter(p => !q || p.title.toLowerCase().includes(q));
      $("#presetList").innerHTML = presets.map((p, i) => `
        <li data-i="${i}">
          <div class="meta"><span class="name">${esc(p.title)}</span>
            <span><span class="badge ${p.kind === "preset" ? "" : "none"}">${p.kind === "preset" ? "프리셋" : "Structure"}</span>${p.test ? ' <span class="badge test">테스트</span>' : ""}</span></div>
          <div class="row wrap" style="margin-top:6px">
            <button data-act="general">일반증착으로</button><button data-act="tooling">툴링으로</button>
            ${p.kind === "preset" ? '<button data-act="delete" class="danger">삭제</button>' : ""}
          </div>
        </li>`).join("") || `<p class="hint">프리셋이 없어요. 기록을 작성한 뒤 "프리셋으로 저장"을 누르면 생겨요.</p>`;
      $("#presetList").onclick = async e => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const p = presets[Number(btn.closest("li").dataset.i)];
        if (btn.dataset.act === "delete") return deletePreset(p);
        if (!(await replaceDraftOk())) return;
        const layers = Core.presetToDraftLayers(Core.structureRowsFromSheet(app.model.rowsOf(p.realPath) || []));
        await startDraft({type: btn.dataset.act === "tooling" ? "툴링" : "일반증착", layers, preset: p.title});
      };
    }
    function renderEditor() {
      const d = draft;
      $("#editorTitle").textContent = d.editing ? `수정 중: ${d.editing.relPath.split("/").pop()}` : "새 로그";
      $$("#editorType button").forEach(b => b.classList.toggle("active", b.dataset.type === d.type));
      $("#editorDate").value = d.date;
      $("#editorPreset").value = d.preset || "";
      $("#editorMemo").value = d.memo || "";
      $("#editorError").textContent = "";
      $("#materialOptions").innerHTML = [...app.model.comboOptions().map(c => c.label), ...app.model.materials]
        .map(v => `<option value="${esc(v)}"></option>`).join("");
      $("#layerCards").innerHTML = blocks().map((idx, n) => cardHtml(idx, n)).join("");
      renderStructure();
    }

    // ---------- structure panel ----------
    // A co-dep group is drawn as one split block.
    function stackGroups(layers) {
      const groups = [];
      layers.forEach((l, i) => {
        if (!String(l.material || "").trim()) return;
        const last = groups[groups.length - 1];
        if (l.codep && last && last.co === l.codep) last.items.push({l, i});
        else groups.push({co: l.codep || null, mask: String(l.mask), items: [{l, i}]});
      });
      return groups;
    }
    function renderStructure() {
      const groups = stackGroups(draft.layers);
      const total = draft.layers.reduce((sum, l) => sum + (String(l.material || "").trim() ? Core.toFloat(l.target_actual) || 0 : 0), 0);
      VTEStack.render(groups.map(g => ({
        parts: g.items.map(({l}) => ({material: l.material, thick: Core.toFloat(l.target_actual) || 0, label: Core.toFloat(l.target_actual) ? fmt(Core.toFloat(l.target_actual), 1) : ""})),
        mask: g.mask,
        state: g.items.some(({l}) => l.started_at && !l.ended_at) ? "running" : g.items.every(({l}) => l.ended_at) ? "done" : "",
        jump: g.items[0].i
      })), {
        totalText: `총 ${fmt(total, 1) || 0} nm (목표)`,
        onItem: i => {
          if (draft.layers[i].collapsed) { setShared(i, "collapsed", false); persist(); refreshCard(i); }
          VTEStack.scrollToEl($(`[data-card="${blockOf(i)[0]}"]`));
        }
      });
    }

    // ---------- running layer: elapsed time and keeping the screen on ----------
    const elapsedText = (from, to = Date.now()) => {
      const sec = Math.max(0, Math.round((to - from) / 1000));
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    };
    function syncRunningState() {
      const running = draft && app.tab === "record" && draft.layers.some(l => l.started_ms && !l.ended_ms);
      clearInterval(tickTimer);
      if (running) {
        tickTimer = setInterval(() => {
          draft.layers.forEach((l, i) => {
            const el = $(`[data-elapsed="${i}"]`);
            if (el && l.started_ms && !l.ended_ms) el.textContent = `경과 ${elapsedText(l.started_ms)}`;
          });
        }, 1000);
        if ("wakeLock" in navigator && !wakeLock) navigator.wakeLock.request("screen").then(lock => { wakeLock = lock; lock.addEventListener("release", () => { wakeLock = null; }); }).catch(() => {});
      } else if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncRunningState(); });
    function heroText(l) {
      return l.monitor ? `${l.monitor}` : "—";
    }
    // Which calibration the ratio came from: the newest measurement on this source/TF with the same ratio.
    function calibrationDate(l) {
      const ratio = Core.toFloat(l.ratio);
      if (!app.model || !l.material || !ratio) return null;
      const hit = app.model.calibrationHistory(String(l.material).trim()).find(m =>
        m.ratio && fmt(m.ratio, 6) === fmt(ratio, 6) &&
        (!l.port || String(m.source || "").trim().toUpperCase() === String(l.port).trim().toUpperCase()) &&
        (!l.tooling_factor || Core.sameNumeric(m.tooling_factor, l.tooling_factor)));
      return hit ? Core.displayDate(String(hit.date || hit.file?.dateStr || "")) || "날짜 없음" : "";
    }
    function heroSub(l) {
      if (l.monitor_manual) return "모니터 직접 입력";
      if (!l.ratio) return "";
      const date = calibrationDate(l);
      if (date === null) return `ratio ${l.ratio}`;
      return `ratio ${l.ratio} · ${date === "" ? "ratio 직접 입력" : `calibration ${date}`}`;
    }
    function historyFor(l, limit = 5) {
      if (!app.model || !l.material || !l.port) return [];
      return app.model.sourceHistory(l.material, l.port, {limit, excludePath: draft?.editing?.relPath || ""});
    }
    function showHistory(l) {
      const rows = historyFor(l);
      const pair = (a, b) => [a, b].map(v => (v === "" || v === null || v === undefined ? "?" : Core.fmt(v))).join("→");
      const sheet = document.createElement("div");
      sheet.className = "sheet-backdrop";
      sheet.innerHTML = `<div class="sheet" role="dialog">
        <div class="meta"><b>${esc(l.material)} · ${esc(l.port)} 지난 기록</b><button data-close>닫기</button></div>
        ${rows.length ? `<ul class="list">${rows.map((h, n) => `<li><button class="history-row" data-n="${n}">
          <b>${esc(h.log.dateStr || "날짜 없음")}</b> ${h.log.test ? '<span class="badge none">테스트</span>' : ""}
          <span>${esc(`파워 ${pair(h.start_power, h.end_power)} · 온도 ${pair(h.start_temp, h.end_temp)} · 레이트 ${pair(h.start_rate, h.end_rate)}`)}</span>
        </button></li>`).join("")}</ul>` : `<p class="hint">같은 재료·소스로 증착한 로그가 아직 없어요.</p>`}
      </div>`;
      sheet.onclick = e => {
        const row = e.target.closest("[data-n]");
        if (row) { sheet.remove(); openLog(rows[Number(row.dataset.n)].log); return; }
        if (e.target === sheet || e.target.closest("[data-close]")) sheet.remove();
      };
      document.body.appendChild(sheet);
    }
    function settingsLine(l) {
      return [l.port || "소스?", `TF ${l.tooling_factor || "?"}`].join(" · ");
    }
    function placeholderFor(l, i, k) {
      // Power and temperature depend on the source, so their hints come from the last run of this material on this source.
      if (k === "start_power" || k === "start_temp") {
        const hit = historyFor(l).find(h => Core.toFloat(h[k]) !== null);
        return hit ? `placeholder="지난 ${esc(fmt(Core.toFloat(hit[k])))}"` : "";
      }
      const prev = draft.layers[blockOf(i)[0] - 1] || {};
      const from = {start_pressure: "end_pressure", start_rate: "end_rate"}[k];
      return from && prev[from] ? `placeholder="이전 ${esc(prev[from])}"` : "";
    }
    const MEASURES = {pressure: ["압력", "text", "×10⁻⁷"], rate: ["레이트", "decimal", "Å/s"], power: ["파워", "decimal", ""], temp: ["온도", "decimal", "°C"]};
    function measureRow(l, i, k) {
      const [label, mode, unit] = MEASURES[k];
      return `
            <div class="measure-row">
              ${k === "power" || k === "temp"
                ? `<button class="measure-label link" data-act="history" data-i="${i}">${label}${unit ? `<small>${unit}</small>` : ""}<small>지난 기록 ›</small></button>`
                : `<span class="measure-label">${label}${unit ? `<small>${unit}</small>` : ""}</span>`}
              <input data-i="${i}" data-k="start_${k}" inputmode="${mode}" value="${esc(l[`start_${k}`] || "")}" ${placeholderFor(l, i, `start_${k}`) || 'placeholder="시작"'} aria-label="${label} 시작">
              <input data-i="${i}" data-k="end_${k}" inputmode="${mode}" value="${esc(l[`end_${k}`] || "")}" placeholder="끝" aria-label="${label} 끝">
            </div>`;
    }
    const cardHtml = (idx, n) => (draft.layers[idx[0]].codep ? codepCard(idx, n, draft.type === "툴링") : layerCard(draft.layers[idx[0]], idx[0], draft.type === "툴링", n));
    function layerCard(l, i, isTooling, n) {
      const placeholder = k => placeholderFor(l, i, k);
      const input = (k, label, mode = "decimal", extra = "") => `<label>${label}<input data-i="${i}" data-k="${k}" inputmode="${mode}" value="${esc(l[k] || "")}" ${placeholder(k)} ${extra}></label>`;
      const state = l.ended_at ? "done" : l.started_at ? "running" : "";
      const elapsed = l.started_ms ? (l.ended_ms ? `소요 ${elapsedText(l.started_ms, l.ended_ms)}` : `경과 ${elapsedText(l.started_ms)}`) : "";
      const rates = l.start_rate || l.end_rate ? `${l.start_rate || "?"}→${l.end_rate || "?"}Å/s` : "";
      const summary = [l.monitor && `모니터 ${l.monitor}nm`, rates].filter(Boolean).join(" · ");
      const ports = ["", ...ALL_PORTS].map(p => `<option ${p === l.port ? "selected" : ""}>${esc(p)}</option>`).join("");
      const masks = ["1", "2", "3"].map(m => `<option value="${m}" ${m === String(l.mask) ? "selected" : ""}>M${m}</option>`).join("");
      const settingsOpen = l.settings_open ?? !String(l.material || "").trim();
      return `<div class="edit-layer ${state} ${l.collapsed ? "collapsed" : ""}" data-card="${i}">
        <div class="head"><b class="toggle" role="button" data-act="toggle" data-i="${i}">${l.collapsed ? "▸" : "▾"} ${n + 1}. ${l.material ? `<span class="mat">${esc(l.material)}</span>` : "재료 선택"}${l.port ? ` <span class="port">${esc(l.port)}</span>` : ""}</b>
          <select class="mask-select" data-i="${i}" data-k="mask" aria-label="마스크">${masks}</select>
          <span class="tools"><button data-act="up" data-i="${i}">↑</button><button data-act="down" data-i="${i}">↓</button><button data-act="remove" data-i="${i}" class="danger">✕</button></span></div>
        <div class="summary ${elapsed ? "" : "no-elapsed"}"><span class="sum-text">${esc(summary)}</span> <span class="elapsed" data-elapsed="${i}">${elapsed}</span></div>
        <div class="body">
          <div class="hero">
            <div class="hero-row">
              <label class="hero-target"><input data-i="${i}" data-k="target_actual" inputmode="decimal" value="${esc(l.target_actual || "")}" placeholder="목표" aria-label="목표 실제 두께"><small>nm (목표)</small></label>
              <span class="hero-arrow">→</span>
              <span class="hero-value"><span data-hero="${i}">${esc(heroText(l))}</span><small>nm (모니터)</small></span>
            </div>
            <div class="hero-sub" data-hero-sub="${i}">${esc(heroSub(l))}</div>
          </div>
          <button class="settings-toggle" data-act="settings" data-i="${i}">${settingsOpen ? "설정 접기 ▴" : `설정 ✎ ${esc(settingsLine(l))}`}</button>
          <div class="settings" ${settingsOpen ? "" : "hidden"}>
            <label>재료 (목록에서 고르면 소스·TF·ratio 자동)<input data-i="${i}" data-k="material" list="materialOptions" value="${esc(l.material || "")}" autocomplete="off"></label>
            <div class="grid3" style="margin-top:6px">
              <label>소스<select data-i="${i}" data-k="port">${ports}</select></label>
              ${input("tooling_factor", "TF")}
              ${input("ratio", "Ratio")}
              ${input("monitor", "모니터(nm)")}
            </div>
            <div class="calc-hint" data-hint="${i}">${l.monitor_manual ? "모니터 두께 직접 입력됨 (지우면 자동 계산)" : l.monitor ? "모니터 = 목표 ÷ ratio" : ""}</div>
            <div class="grid2">${input("target_rate", "목표 실제 레이트(Å/s)")}<span></span></div>
          </div>
          <div class="phase">
            <div class="measure-head">
              <span></span>
              <button data-act="start" data-i="${i}">${l.started_at ? "▶ 시작 ↺" : "▶ 시작"}<small>${esc((l.started_at || "").slice(11))}</small></button>
              <button data-act="end" data-i="${i}">${l.ended_at ? "■ 끝 ↺" : "■ 끝"}<small>${esc((l.ended_at || "").slice(11))}</small></button>
            </div>
            ${["pressure", "rate", "power", "temp"].map(k => measureRow(l, i, k)).join("")}
            ${isTooling ? `<div class="grid2 tight" style="margin-top:6px">${input("measured_actual", "실측 두께(nm)")}<span></span></div>` : ""}
          </div>
          <label style="margin-top:6px">메모${`<input data-i="${i}" data-k="notes" value="${esc(l.notes || "")}">`}</label>
        </div>
      </div>`;
    }
    function codepCard(idx, n, isTooling) {
      const i = idx[0], l = draft.layers[i], members = idx.map(j => [j, draft.layers[j]]);
      const ports = m => ["", ...ALL_PORTS].map(p => `<option ${p === m.port ? "selected" : ""}>${esc(p)}</option>`).join("");
      const masks = ["1", "2", "3"].map(m => `<option value="${m}" ${m === String(l.mask) ? "selected" : ""}>M${m}</option>`).join("");
      const state = l.ended_at ? "done" : l.started_at ? "running" : "";
      const elapsed = l.started_ms ? (l.ended_ms ? `소요 ${elapsedText(l.started_ms, l.ended_ms)}` : `경과 ${elapsedText(l.started_ms)}`) : "";
      const summary = members.map(([, m]) => `${m.material || "?"} ${m.monitor || "?"}`).join(" · ") + " nm (모니터)";
      const settingsOpen = l.settings_open ?? members.some(([, m]) => !String(m.material || "").trim());
      const field = (j, m, k, label) => `<label>${label}<input data-i="${j}" data-k="${k}" inputmode="decimal" value="${esc(m[k] || "")}"></label>`;
      return `<div class="edit-layer codep ${state} ${l.collapsed ? "collapsed" : ""}" data-card="${i}">
        <div class="head"><b class="toggle" role="button" data-act="toggle" data-i="${i}">${l.collapsed ? "▸" : "▾"} ${n + 1}. ${members.map(([, m]) => (m.material ? `<span class="mat">${esc(m.material)}</span>` : "재료?")).join(" : ")}</b>
          <select class="mask-select" data-i="${i}" data-k="mask" aria-label="마스크">${masks}</select>
          <span class="tools"><button data-act="up" data-i="${i}">↑</button><button data-act="down" data-i="${i}">↓</button><button data-act="remove" data-i="${i}" class="danger">✕</button></span></div>
        <div class="summary ${elapsed ? "" : "no-elapsed"}"><span class="sum-text">${esc(summary)}</span> <span class="elapsed" data-elapsed="${i}">${elapsed}</span></div>
        <div class="body">
          <div class="hero">
            <div class="hero-row">
              <span class="codep-badge">공증착</span>
              <label class="hero-target"><input data-i="${i}" data-k="codep_total" inputmode="decimal" value="${esc(l.codep_total || "")}" placeholder="합계" aria-label="공증착 전체 목표 두께"><small>nm (목표 합계)</small></label>
            </div>
            ${members.map(([j, m]) => `
            <div class="codep-line">
              <span class="codep-name"><span class="mat">${esc(m.material || "재료?")}</span> <small>${esc(m.vol || "?")}%</small></span>
              <span class="codep-actual" data-actual="${j}">${esc(m.target_actual || "—")}</span>
              <span class="hero-arrow">→</span>
              <span class="codep-monitor"><span data-hero="${j}">${esc(heroText(m))}</span><small>nm</small></span>
            </div>
            <div class="hero-sub" data-hero-sub="${j}">${esc(heroSub(m))}</div>`).join("")}
          </div>
          <button class="settings-toggle" data-act="settings" data-i="${i}">${settingsOpen ? "설정 접기 ▴" : `설정 ✎ ${esc(members.map(([, m]) => `${m.port || "소스?"} ${m.vol || "?"}%`).join(" · "))}`}</button>
          <div class="settings" ${settingsOpen ? "" : "hidden"}>
            ${members.map(([j, m], k) => `
            <div class="codep-member">
              <div class="meta"><b>재료 ${k + 1}</b>${members.length > 2 ? `<button data-act="codep-remove" data-i="${j}" class="danger">빼기</button>` : ""}</div>
              <label>재료 (목록에서 고르면 소스·TF·ratio 자동)<input data-i="${j}" data-k="material" list="materialOptions" value="${esc(m.material || "")}" autocomplete="off"></label>
              <div class="grid3" style="margin-top:6px">
                <label>소스<select data-i="${j}" data-k="port">${ports(m)}</select></label>
                ${field(j, m, "tooling_factor", "TF")}
                ${field(j, m, "vol", "부피비(%)")}
                ${field(j, m, "ratio", "Ratio")}
                ${field(j, m, "monitor", "모니터(nm)")}
              </div>
            </div>`).join("")}
            ${members.length < 3 ? `<button class="wide" data-act="codep-add" data-i="${i}">+ 재료 추가</button>` : ""}
          </div>
          <div class="phase">
            <div class="measure-head">
              <span></span>
              <button data-act="start" data-i="${i}">${l.started_at ? "▶ 시작 ↺" : "▶ 시작"}<small>${esc((l.started_at || "").slice(11))}</small></button>
              <button data-act="end" data-i="${i}">${l.ended_at ? "■ 끝 ↺" : "■ 끝"}<small>${esc((l.ended_at || "").slice(11))}</small></button>
            </div>
            ${measureRow(l, i, "pressure")}
            ${members.map(([j, m]) => `
            <div class="codep-sub"><span class="mat">${esc(m.material || "재료?")}</span> <span class="port">${esc(m.port || "")}</span></div>
            ${["rate", "power", "temp"].map(k => measureRow(m, j, k)).join("")}
            ${isTooling ? `<div class="grid2 tight" style="margin-top:6px"><label>실측 두께(nm)<input data-i="${j}" data-k="measured_actual" inputmode="decimal" value="${esc(m.measured_actual || "")}"></label><span></span></div>` : ""}`).join("")}
            <div class="calc-hint" data-dope="${i}">${esc(dopingText(idx))}</div>
          </div>
          <label style="margin-top:6px">메모<input data-i="${i}" data-k="notes" value="${esc(l.notes || "")}"></label>
        </div>
      </div>`;
    }
    // Update a card without replacing its inputs, so the field the user just tapped keeps focus and the keyboard stays open.
    function patchCard(i) {
      const all = blocks(), n = all.findIndex(b => b.includes(i));
      const card = n < 0 ? null : $(`[data-card="${all[n][0]}"]`);
      if (!card) return renderEditor();
      const tmp = document.createElement("div");
      tmp.innerHTML = cardHtml(all[n], n);
      const next = tmp.firstElementChild;
      const fields = el => [...el.querySelectorAll("[data-k]")];
      const [oldFields, newFields] = [fields(card), fields(next)];
      if (oldFields.length !== newFields.length || oldFields.some((f, j) => f.dataset.k !== newFields[j].dataset.k || f.dataset.i !== newFields[j].dataset.i)) return refreshCard(i);
      oldFields.forEach((f, j) => {
        const nf = newFields[j];
        if (f.tagName === "SELECT") { f.innerHTML = nf.innerHTML; f.value = nf.value; }
        else if (f !== document.activeElement) f.value = nf.value;
        if (f.placeholder !== nf.placeholder) f.placeholder = nf.placeholder;
      });
      const texts = ".head .toggle, .summary, .hero-sub, [data-hero], [data-actual], .settings-toggle, .codep-name, .codep-sub, [data-dope], .calc-hint";
      const [oldTexts, newTexts] = [card.querySelectorAll(texts), next.querySelectorAll(texts)];
      if (oldTexts.length !== newTexts.length) return refreshCard(i);
      oldTexts.forEach((t, j) => { if (t.innerHTML !== newTexts[j].innerHTML) t.innerHTML = newTexts[j].innerHTML; });
      card.className = next.className;
    }
    function refreshCard(i) {
      const all = blocks(), n = all.findIndex(b => b.includes(i));
      const card = n < 0 ? null : $(`[data-card="${all[n][0]}"]`);
      if (!card) return renderEditor();
      const tmp = document.createElement("div");
      tmp.innerHTML = cardHtml(all[n], n);
      card.replaceWith(tmp.firstElementChild);
    }

    // ---------- save ----------
    async function uploadDraft() {
      const d = draft;
      const err = msg => { $("#editorError").textContent = msg; };
      if (!/^\d{6}$/.test(d.date)) return err("날짜를 YYMMDD 6자리로 입력해 주세요.");
      const layers = d.layers.filter(l => String(l.material || "").trim());
      if (!layers.length) return err("재료가 입력된 레이어가 하나 이상 필요해요.");
      const halfFilled = blocks().some(idx => {
        const members = idx.map(j => d.layers[j]);
        return members[0].codep && members.some(m => String(m.material || "").trim()) && members.some(m => !String(m.material || "").trim() || Core.toFloat(m.vol) === null);
      });
      if (halfFilled) return err("공증착 재료마다 재료명과 부피비(%)를 입력해 주세요.");
      const isTooling = d.type === "툴링";
      const editing = d.editing;
      // One clock read for both the file name tag and the process id, so they never disagree.
      const tag = Core.timeTag();
      const meta = editing
        ? {...editing.meta, App: `VTE Log PWA ${config.version}`, "Modified By": author(), "Modified At": nowText(), Device: deviceName(), Preset: d.preset || editing.meta.Preset || ""}
        : {App: `VTE Log PWA ${config.version}`, Author: author(), Device: deviceName(), "Created At": d.createdAt, Preset: d.preset};
      meta[Core.PROCESS_ID_KEY] = Core.keepProcessId(editing && editing.meta, d.date, tag);
      const sheet = Core.buildProcessLogSheet({isTooling, layers: Core.draftLayersToEditorRows(layers), memo: d.memo, meta, timeTag: tag});
      const newPath = `${savePrefix()}${Core.processLogFolder(isTooling, d.date).join("/")}/${Core.pathSafe(sheet.fileName)}`;
      // Edit in place only in the matching mode (test file in test mode, real file otherwise) and while the file still exists;
      // a file deleted since opening is saved as a new file instead of being silently recreated.
      const inPlace = editing && editing.test === testMode() && editing.origType === d.type && editing.origDate === d.date && Boolean(fileRev(editing.realPath));
      const job = {kind: "log", label: sheet.fileName, relPath: inPlace ? editing.realPath : newPath, rev: inPlace ? fileRev(editing.realPath) : null,
        fallbackPath: newPath, what: "로그", bytes: toWorkbook([sheet]), draft: d};
      const queueDraft = async () => {
        await enqueue(job);
        draft = null;
        await app.store.set("draft", null);
        render();
        alert("인터넷이 안 돼서 폰에 보관했어요.\n연결되면 자동으로 Dropbox에 올려요. (위쪽 '업로드 대기'에서 확인)");
      };
      if (!navigator.onLine) return queueDraft();
      $("#uploadBtn").disabled = true;
      try {
        const saved = await uploadFile(job.relPath, job.bytes, {rev: job.rev, what: "로그", fallbackPath: newPath});
        if (!saved) return;
        draft = null;
        await app.store.set("draft", null);
        await loadModel();
        status(`저장됨: ${saved.relPath.split("/").pop()}`);
        const log = app.model.logs.find(l => l.realPath === saved.relPath);
        if (editing && !inPlace) alert(`새 파일로 저장했어요.\n원래 파일(${editing.relPath.split("/").pop()})은 그대로 있어요.`);
        if (log) openLog(log); else ctx.setTab("logs");
      } catch (e) {
        if (isNetworkError(e)) await queueDraft();
        else err(`저장 실패: ${e.message}`);
      } finally {
        $("#uploadBtn").disabled = false;
      }
    }
    async function savePreset() {
      const layers = draft.layers.filter(l => String(l.material || "").trim());
      if (!layers.length) return alert("재료가 입력된 레이어가 필요해요.");
      const name = Core.safeFileName(prompt("프리셋 이름", draft.preset || "") || "");
      if (!name) return;
      const relPath = `${savePrefix()}Presets/${name}.xlsx`;
      const existing = app.files.get(relPath);
      if (existing && !confirm(`"${name}" 프리셋이 이미 있어요. 덮어쓸까요?`)) return;
      const sheets = Core.buildPresetWorkbookSheets(Core.draftLayersToPresetRows(layers), {
        Name: name, Author: author(), [existing ? "Updated At" : "Created At"]: nowText(), App: `VTE Log PWA ${config.version}`
      });
      const bytes = toWorkbook(sheets), rev = existing ? existing.rev : null;
      try {
        if (!navigator.onLine) throw new TypeError("offline");
        const saved = await uploadFile(relPath, bytes, {rev, what: "프리셋"});
        if (!saved) return;
        draft.preset = name;
        persist();
        await loadModel();
        $("#editorPreset").value = name;
        status(`프리셋 저장됨: ${name}`);
      } catch (e) {
        if (!isNetworkError(e)) return alert(`프리셋 저장 실패: ${e.message}`);
        await enqueue({kind: "preset", label: `프리셋 ${name}`, relPath, rev, fallbackPath: `${savePrefix()}Presets/${name}_copy.xlsx`, what: "프리셋", bytes});
        draft.preset = name;
        persist();
        $("#editorPreset").value = name;
        alert("인터넷이 안 돼서 프리셋을 폰에 보관했어요. 연결되면 자동으로 올려요.");
      }
    }
    async function deletePreset(p) {
      if (!p.test && testMode()) return alert("테스트 모드에서는 실제 폴더의 프리셋을 지울 수 없어요.");
      if (!confirm(`"${p.title}" 프리셋을 삭제할까요?\nDropbox 휴지통에서 복구할 수 있어요.`)) return;
      try {
        await app.client.remove(p.realPath, {rev: fileRev(p.realPath)});
        await app.store.deleteFiles([p.realPath]);
        await loadModel();
        renderPresets();
      } catch (e) {
        alert(`삭제 실패: ${e.message}`);
      }
    }

    // ---------- entry points ----------
    async function editLog(log) {
      if (!(await replaceDraftOk())) return;
      const rows = app.model.rowsOf(log.realPath) || [];
      const meta = Core.readSheetMeta(rows);
      const layers = Core.draftLayersFromRows(rows);
      if (!layers.length && !confirm("이 파일은 매니저 양식이 아니라 레이어를 불러오지 못했어요. 빈 로그로 수정할까요?")) return;
      await startDraft({
        type: log.type, date: log.dateStr || Core.currentYYMMDD(), layers, preset: meta.Preset || "", createdAt: meta["Created At"] || "",
        editing: {realPath: log.realPath, relPath: log.relPath, test: log.test, meta, origType: log.type, origDate: log.dateStr}
      });
      ctx.setTab("record");
    }
    function calibrationForm(material, combo) {
      const box = document.createElement("div");
      box.className = "card";
      const v = (k, label, value = "", mode = "decimal") => `<label>${label}<input data-f="${k}" inputmode="${mode}" value="${esc(value)}"></label>`;
      box.innerHTML = `<h2>실측 추가 · ${esc(material)}</h2>
        <div class="grid2">${v("date", "날짜 (YYMMDD)", Core.currentYYMMDD(), "numeric")}${v("source", "소스", combo?.source || "", "text")}
          ${v("toolingFactor", "TF", fmt(combo?.tooling_factor) || "")}${v("rate", "레이트")}
          ${v("monitor", "모니터 두께(nm)")}${v("actual", "실측 두께(nm)")}
          ${v("pressure", "압력", "", "text")}${v("power", "파워")}</div>
        ${v("notes", "메모", "", "text")}
        <p class="calc-hint" data-ratio></p><p class="error" data-err></p>
        <div class="row"><button class="primary" data-save>저장</button><button data-cancel>닫기</button></div>`;
      const val = k => box.querySelector(`[data-f="${k}"]`).value;
      box.oninput = () => {
        const m = Core.toFloat(val("monitor")), a = Core.toFloat(val("actual"));
        box.querySelector("[data-ratio]").textContent = m && a !== null ? `Ratio ${fmt(a / m, 6)}` : "";
      };
      box.querySelector("[data-cancel]").onclick = () => box.remove();
      box.querySelector("[data-save]").onclick = async () => {
        const sheet = Core.buildCalibrationSheet({material, date: val("date"), source: val("source"), toolingFactor: val("toolingFactor"), monitor: val("monitor"),
          actual: val("actual"), pressure: val("pressure"), power: val("power"), rate: val("rate"), notes: [val("notes"), `입력: ${author()} (${deviceName()})`].filter(Boolean).join(" / ")});
        if (sheet.error) { box.querySelector("[data-err]").textContent = sheet.error; return; }
        const relPath = `${savePrefix()}${sheet.folder.map(Core.pathSafe).join("/")}/${sheet.fileName}`;
        const existing = app.files.get(relPath);
        if (existing && !confirm(`${sheet.fileName}이(가) 이미 있어요. 덮어쓸까요?`)) return;
        const bytes = toWorkbook([sheet]), rev = existing ? existing.rev : null;
        try {
          if (!navigator.onLine) throw new TypeError("offline");
          const saved = await uploadFile(relPath, bytes, {rev, what: "calibration"});
          if (!saved) return;
          await loadModel();
          status(`실측 저장됨: ${material} ${sheet.fileName}`);
          ctx.renderCalDetail(material);
        } catch (e) {
          if (!isNetworkError(e)) { box.querySelector("[data-err]").textContent = `저장 실패: ${e.message}`; return; }
          await enqueue({kind: "calibration", label: `${material} ${sheet.fileName}`, relPath, rev, fallbackPath: relPath.replace(/\.xlsx$/i, "_copy.xlsx"), what: "calibration", bytes});
          box.remove();
          alert("인터넷이 안 돼서 실측값을 폰에 보관했어요. 연결되면 자동으로 올려요.");
        }
      };
      return box;
    }

    function bind() {
      $("#newGeneralBtn").onclick = async () => { if (await replaceDraftOk()) startDraft({type: "일반증착"}); };
      $("#newToolingBtn").onclick = async () => { if (await replaceDraftOk()) startDraft({type: "툴링"}); };
      $("#presetSearch").oninput = renderPresets;
      $$("#editorType button").forEach(b => { b.onclick = () => { draft.type = b.dataset.type; persist(); renderEditor(); }; });
      $("#editorDate").oninput = e => { draft.date = e.target.value.trim(); persist(); };
      $("#editorMemo").oninput = e => { draft.memo = e.target.value; persist(); };
      $("#addLayerBtn").onclick = () => {
        const prev = draft.layers[draft.layers.length - 1];
        draft.layers.push({...Core.DRAFT_LAYER_DEFAULTS, mask: prev?.mask || "1"});
        persist();
        renderEditor();
        VTEStack.scrollToEl($(`[data-card="${draft.layers.length - 1}"]`));
      };
      $("#addCodepBtn").onclick = () => {
        const prev = draft.layers[draft.layers.length - 1];
        const codep = `g${Date.now().toString(36)}`;
        const at = draft.layers.length;
        draft.layers.push(...[0, 1].map(() => ({...Core.DRAFT_LAYER_DEFAULTS, codep, mask: prev?.mask || "1", settings_open: true})));
        persist();
        renderEditor();
        VTEStack.scrollToEl($(`[data-card="${at}"]`));
      };
      $("#uploadBtn").onclick = uploadDraft;
      $("#savePresetBtn").onclick = savePreset;
      $("#discardDraftBtn").onclick = async () => {
        if (!confirm("초안을 버릴까요? 저장하지 않은 입력은 사라져요.")) return;
        draft = null;
        await app.store.set("draft", null);
        render();
      };
      const cards = $("#layerCards");
      cards.addEventListener("input", e => {
        const el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
        if (!k || Number.isNaN(i)) return;
        const layer = draft.layers[i];
        if (k === "material") { layer.material = el.value; persist(); return; }
        if (SHARED_KEYS.includes(k)) setShared(i, k, el.value); else layer[k] = el.value;
        if (layer.codep && (k === "codep_total" || k === "vol" || k === "ratio" || k === "monitor")) {
          if (k === "monitor") { layer.monitor_manual = el.value.trim() !== ""; recalcMonitor(layer); } else syncCodep(i);
          for (const j of blockOf(i)) {
            const m = draft.layers[j];
            const actual = $(`[data-actual="${j}"]`), hero = $(`[data-hero="${j}"]`), sub = $(`[data-hero-sub="${j}"]`), mon = $(`input[data-i="${j}"][data-k="monitor"]`);
            if (actual) actual.textContent = m.target_actual || "—";
            if (hero) hero.textContent = heroText(m);
            if (sub) sub.textContent = heroSub(m);
            if (mon && !m.monitor_manual && j !== i) mon.value = m.monitor;
          }
        }
        if (layer.codep && /rate$|^ratio$|^vol$/.test(k)) {
          const dope = $(`[data-dope="${blockOf(i)[0]}"]`);
          if (dope) dope.textContent = dopingText(blockOf(i));
        }
        if (k === "monitor") layer.monitor_manual = el.value.trim() !== "";
        if (k === "target_actual" || k === "ratio") {
          recalcMonitor(layer);
          const mon = $(`input[data-i="${i}"][data-k="monitor"]`);
          if (mon && !layer.monitor_manual) mon.value = layer.monitor;
        }
        if (["monitor", "target_actual", "ratio", "target_rate"].includes(k)) {
          const hero = $(`[data-hero="${i}"]`), sub = $(`[data-hero-sub="${i}"]`);
          if (hero) hero.textContent = heroText(layer);
          if (sub) sub.textContent = heroSub(layer);
        }
        if (k === "monitor" || k === "target_actual" || k === "ratio") {
          const hint = $(`[data-hint="${i}"]`);
          if (hint) hint.textContent = layer.monitor_manual ? "모니터 두께 직접 입력됨 (지우면 자동 계산)" : layer.monitor ? "모니터 = 목표 ÷ ratio" : "";
        }
        if (k === "target_actual" || k === "codep_total" || k === "vol") renderStructure();
        persist();
      });
      cards.addEventListener("change", e => {
        const el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
        if (Number.isNaN(i) || !k) return;
        const layer = draft.layers[i];
        if (k === "material") {
          // A plain material name (not a combo) must not inherit the previous material's source, TF or ratio.
          if (!app.model.comboOptions().some(c => c.label === el.value.trim())) Object.assign(layer, {port: "", tooling_factor: "", ratio: ""});
          applyCombo(layer, el.value.trim());
          autofill(layer, {force: true});
        }
        else if (k === "vol" || k === "codep_total" || k === "monitor") { persist(); patchCard(i); renderStructure(); return; }
        else if (k === "port" || k === "tooling_factor") { layer[k] = el.value; autofill(layer, {force: true}); }
        else if (k === "mask") setShared(i, "mask", el.value);
        else return;
        persist();
        patchCard(i);
        renderStructure();
      });
      cards.addEventListener("click", async e => {
        let btn = e.target.closest("[data-act]");
        if (!btn) {
          // Tapping the title row or summary of a card toggles it too.
          const zone = e.target.closest(".edit-layer .head, .edit-layer .summary");
          if (!zone || e.target.closest("button, select")) return;
          btn = zone.closest(".edit-layer").querySelector('[data-act="toggle"]');
        }
        const i = Number(btn.dataset.i), layers = draft.layers;
        const act = btn.dataset.act;
        if (act === "settings") {
          const card = layers[i], idx = blockOf(i);
          const defaultOpen = idx.some(j => !String(layers[j].material || "").trim());
          setShared(i, "settings_open", !(card.settings_open ?? defaultOpen));
          persist();
          return refreshCard(i);
        }
        if (act === "history") return showHistory(layers[i]);
        if (act === "toggle") {
          setShared(i, "collapsed", !layers[i].collapsed);
          persist();
          return refreshCard(i);
        }
        if (act === "codep-add") {
          const idx = blockOf(i), first = layers[idx[0]];
          const shared = Object.fromEntries(SHARED_KEYS.map(k => [k, first[k]]).filter(([, v]) => v !== undefined));
          layers.splice(idx[idx.length - 1] + 1, 0, {...Core.DRAFT_LAYER_DEFAULTS, ...shared, codep: first.codep});
          syncCodep(i);
          persist();
          return renderEditor();
        }
        if (act === "codep-remove") {
          if (hasData(layers[i]) && !confirm(`${layers[i].material || "빈 재료"}를 공증착에서 뺄까요?`)) return;
          const keep = blockOf(i).find(j => j !== i);
          layers.splice(i, 1);
          syncCodep(keep > i ? keep - 1 : keep);
          persist();
          return renderEditor();
        }
        if (act === "start" || act === "end") {
          const key = act === "start" ? "started_at" : "ended_at";
          if (layers[i][key] && !confirm(`${act === "start" ? "시작" : "끝"} 시각을 지금으로 바꿀까요?`)) return;
          setShared(i, key, nowText());
          setShared(i, act === "start" ? "started_ms" : "ended_ms", Date.now());
          if (act === "end") setShared(i, "collapsed", true);
        } else if (act === "up" || act === "down" || act === "remove") {
          const all = blocks(), n = all.findIndex(b => b.includes(i));
          if (act === "remove") {
            const names = all[n].map(j => layers[j].material || "빈 레이어").join(":");
            if (all[n].some(j => hasData(layers[j])) && !confirm(`${n + 1}번 레이어(${names})를 지울까요?`)) return;
            all.splice(n, 1);
          } else {
            const m = act === "up" ? n - 1 : n + 1;
            if (m < 0 || m >= all.length) return;
            [all[n], all[m]] = [all[m], all[n]];
          }
          draft.layers = all.flat().map(j => layers[j]);
          if (!draft.layers.length) draft.layers.push({...Core.DRAFT_LAYER_DEFAULTS});
        } else return;
        persist();
        if (act === "start" || act === "end") { refreshCard(i); renderStructure(); syncRunningState(); } else renderEditor();
      });
    }

    async function discardIfEditing(realPath) {
      if (!draft?.editing || draft.editing.realPath !== realPath) return true;
      if (!confirm("이 로그를 수정 중인 초안이 있어요. 삭제하면 초안도 버려요. 계속할까요?")) return false;
      draft = null;
      await app.store.set("draft", null);
      return true;
    }
    return {bind, render, flush, loadDraft, editLog, calibrationForm, discardIfEditing, queueJobs, flushQueue, removeJob, restoreJob, hasDraft: () => Boolean(draft), TEST_PREFIX};
  }

  root.VTEEditor = {create, TEST_PREFIX};
})(typeof globalThis !== "undefined" ? globalThis : this);
