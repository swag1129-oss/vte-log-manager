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

    const testMode = () => localStorage.getItem("vte.testMode") !== "0";
    const author = () => localStorage.getItem("vte.author") || "";
    const pad = n => String(n).padStart(2, "0");
    const nowText = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const deviceName = () => {
      const ua = navigator.userAgent;
      return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
    };
    const savePrefix = () => (testMode() ? TEST_PREFIX : "");
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
    async function uploadFile(relPath, bytes, {rev = null, what = "파일", fallbackPath = null} = {}) {
      let base = relPath, target = relPath;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const result = await app.client.upload(target, bytes, {rev});
          await VTEStore.cacheUploaded({store: app.store, XLSX, relPath: target, data: bytes, result});
          return {relPath: target, result};
        } catch (err) {
          if (err.status !== 409) throw err;
          if (rev) {
            if (!confirm(`다른 기기에서 먼저 수정된 ${what}예요.\n덮어쓰지 않고 새 파일로 저장할까요?`)) return null;
            rev = null;
            base = target = fallbackPath || relPath.replace(/\.xlsx$/i, "_copy.xlsx");
            continue;
          }
          target = base.replace(/\.xlsx$/i, `_${attempt + 2}.xlsx`);
        }
      }
      throw new Error("같은 이름의 파일이 계속 있어서 저장하지 못했어요.");
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
        const layers = Core.presetToDraftLayers(Core.structureRowsFromSheet(app.model.rowsOf(p.relPath) || []));
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
      $("#layerCards").innerHTML = d.layers.map((l, i) => layerCard(l, i, d.type === "툴링")).join("");
      renderStructure();
    }

    // ---------- structure panel ----------
    // Consecutive co-dep layers from a preset ("co-dep A:B …" notes, same mask) are drawn as one split block.
    function stackGroups(layers) {
      const groups = [];
      layers.forEach((l, i) => {
        if (!String(l.material || "").trim()) return;
        const co = /^co-dep (\S+)/.exec(l.notes || "");
        const last = groups[groups.length - 1];
        if (co && last && last.co === co[1] && last.mask === String(l.mask) && last.items.length < co[1].split(":").length) last.items.push({l, i});
        else groups.push({co: co ? co[1] : null, mask: String(l.mask), items: [{l, i}]});
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
          if (draft.layers[i].collapsed) { draft.layers[i].collapsed = false; persist(); refreshCard(i); }
          $(`[data-card="${i}"]`)?.scrollIntoView({behavior: "smooth", block: "start"});
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
    function heroSub(l) {
      const monitorRate = Core.calcMonitorRate(l.target_rate, l.ratio);
      return [
        l.target_actual && `목표 실제 ${l.target_actual} nm`,
        l.monitor_manual ? "모니터 직접 입력" : (l.ratio && `ratio ${l.ratio}`),
        l.target_rate && `레이트 목표 ${l.target_rate}${monitorRate !== null ? ` → 모니터 ${fmt(monitorRate, 3)}` : ""} Å/s`
      ].filter(Boolean).join(" · ");
    }
    function settingsLine(l) {
      return [l.port || "소스?", `TF ${l.tooling_factor || "?"}`, `M${l.mask || "?"}`].join(" · ");
    }
    function layerCard(l, i, isTooling) {
      const prev = draft.layers[i - 1] || {};
      const placeholder = k => {
        const from = {start_pressure: "end_pressure", start_power: "end_power", start_temp: "end_temp", start_rate: "end_rate"}[k];
        return from && prev[from] ? `placeholder="이전 ${esc(prev[from])}"` : "";
      };
      const input = (k, label, mode = "decimal", extra = "") => `<label>${label}<input data-i="${i}" data-k="${k}" inputmode="${mode}" value="${esc(l[k] || "")}" ${placeholder(k)} ${extra}></label>`;
      const state = l.ended_at ? "done" : l.started_at ? "running" : "";
      const elapsed = l.started_ms ? (l.ended_ms ? `소요 ${elapsedText(l.started_ms, l.ended_ms)}` : `경과 ${elapsedText(l.started_ms)}`) : "";
      const rates = l.start_rate || l.end_rate ? `${l.start_rate || "?"}→${l.end_rate || "?"}Å/s` : "";
      const summary = [l.monitor && `모니터 ${l.monitor}nm`, rates, l.port, l.mask && `M${l.mask}`].filter(Boolean).join(" · ");
      const ports = ["", ...ALL_PORTS].map(p => `<option ${p === l.port ? "selected" : ""}>${esc(p)}</option>`).join("");
      const masks = ["1", "2", "3"].map(m => `<option ${m === String(l.mask) ? "selected" : ""}>${m}</option>`).join("");
      const settingsOpen = l.settings_open ?? !String(l.material || "").trim();
      return `<div class="edit-layer ${state} ${l.collapsed ? "collapsed" : ""}" data-card="${i}">
        <div class="head"><b class="toggle" role="button" data-act="toggle" data-i="${i}">${l.collapsed ? "▸" : "▾"} ${i + 1}. ${esc(l.material || "재료 선택")}</b>
          <span class="tools"><button data-act="up" data-i="${i}">↑</button><button data-act="down" data-i="${i}">↓</button><button data-act="remove" data-i="${i}" class="danger">✕</button></span></div>
        <div class="summary">${esc(summary)} <span class="elapsed" data-elapsed="${i}">${elapsed}</span></div>
        <div class="body">
          <div class="hero">
            <div class="hero-label">모니터 목표</div>
            <div class="hero-value"><span data-hero="${i}">${esc(heroText(l))}</span><small> nm</small></div>
            <div class="hero-sub" data-hero-sub="${i}">${esc(heroSub(l))}</div>
          </div>
          <button class="settings-toggle" data-act="settings" data-i="${i}">${settingsOpen ? "설정 접기 ▴" : `설정 ✎ ${esc(settingsLine(l))}`}</button>
          <div class="settings" ${settingsOpen ? "" : "hidden"}>
            <label>재료 (목록에서 고르면 소스·TF·ratio 자동)<input data-i="${i}" data-k="material" list="materialOptions" value="${esc(l.material || "")}" autocomplete="off"></label>
            <div class="grid3" style="margin-top:6px">
              <label>소스<select data-i="${i}" data-k="port">${ports}</select></label>
              ${input("tooling_factor", "TF")}
              <label>마스크<select data-i="${i}" data-k="mask">${masks}</select></label>
              ${input("ratio", "Ratio")}
              ${input("target_actual", "목표 실제(nm)")}
              ${input("monitor", "모니터(nm)")}
            </div>
            <div class="calc-hint" data-hint="${i}">${l.monitor_manual ? "모니터 두께 직접 입력됨 (지우면 자동 계산)" : l.monitor ? "모니터 = 목표 ÷ ratio" : ""}</div>
            <div class="grid2">${input("target_rate", "목표 실제 레이트(Å/s)")}<span></span></div>
          </div>
          <div class="phase"><div class="phase-head"><span>시작 <span class="time">${esc(l.started_at || "")}</span></span><button data-act="start" data-i="${i}">${l.started_at ? "시각 다시" : "▶ 시작"}</button></div>
            <div class="grid2 tight">${input("start_pressure", "압력(×10⁻⁷)", "text")}${input("start_rate", "레이트(Å/s)")}${input("start_power", "파워")}${input("start_temp", "온도")}</div></div>
          <div class="phase"><div class="phase-head"><span>끝 <span class="time">${esc(l.ended_at || "")}</span></span><button data-act="end" data-i="${i}">${l.ended_at ? "시각 다시" : "■ 끝"}</button></div>
            <div class="grid2 tight">${input("end_pressure", "압력(×10⁻⁷)", "text")}${input("end_rate", "레이트(Å/s)")}${input("end_power", "파워")}${input("end_temp", "온도")}
              ${isTooling ? input("measured_actual", "실측 두께(nm)") : ""}</div></div>
          <label style="margin-top:6px">메모${`<input data-i="${i}" data-k="notes" value="${esc(l.notes || "")}">`}</label>
        </div>
      </div>`;
    }
    function refreshCard(i) {
      const card = $(`[data-card="${i}"]`);
      if (!card) return renderEditor();
      const tmp = document.createElement("div");
      tmp.innerHTML = layerCard(draft.layers[i], i, draft.type === "툴링");
      card.replaceWith(tmp.firstElementChild);
    }

    // ---------- save ----------
    async function uploadDraft() {
      const d = draft;
      const err = msg => { $("#editorError").textContent = msg; };
      if (!/^\d{6}$/.test(d.date)) return err("날짜를 YYMMDD 6자리로 입력해 주세요.");
      const layers = d.layers.filter(l => String(l.material || "").trim());
      if (!layers.length) return err("재료가 입력된 레이어가 하나 이상 필요해요.");
      if (!navigator.onLine) return err("오프라인이라 지금은 저장할 수 없어요. 초안은 폰에 남아 있어요.");
      const isTooling = d.type === "툴링";
      const editing = d.editing;
      const meta = editing
        ? {...editing.meta, App: `VTE Log PWA ${config.version}`, "Modified By": author(), "Modified At": nowText(), Device: deviceName(), Preset: d.preset || editing.meta.Preset || ""}
        : {App: `VTE Log PWA ${config.version}`, Author: author(), Device: deviceName(), "Created At": d.createdAt, Preset: d.preset};
      const sheet = Core.buildProcessLogSheet({isTooling, layers: layers.map(Core.draftLayerToEditorRow), memo: d.memo, meta, timeTag: Core.timeTag()});
      const newPath = `${savePrefix()}${Core.processLogFolder(isTooling, d.date).join("/")}/${sheet.fileName}`;
      // Edit in place only when the file is where saving is allowed and its type/date did not change.
      const inPlace = editing && (editing.test || !testMode()) && editing.origType === d.type && editing.origDate === d.date;
      $("#uploadBtn").disabled = true;
      try {
        const saved = await uploadFile(inPlace ? editing.realPath : newPath, toWorkbook([sheet]), {rev: inPlace ? fileRev(editing.realPath) : null, what: "로그", fallbackPath: newPath});
        if (!saved) return;
        draft = null;
        await app.store.set("draft", null);
        await loadModel();
        status(`저장됨: ${saved.relPath.split("/").pop()}`);
        const log = app.model.logs.find(l => l.realPath === saved.relPath);
        if (editing && !inPlace) alert(`새 파일로 저장했어요.\n원래 파일(${editing.relPath.split("/").pop()})은 그대로 있어요.`);
        if (log) openLog(log); else ctx.setTab("logs");
      } catch (e) {
        err(`저장 실패: ${e.message}`);
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
      try {
        const saved = await uploadFile(relPath, toWorkbook(sheets), {rev: existing ? existing.rev : null, what: "프리셋"});
        if (!saved) return;
        draft.preset = name;
        persist();
        await loadModel();
        $("#editorPreset").value = name;
        status(`프리셋 저장됨: ${name}`);
      } catch (e) {
        alert(`프리셋 저장 실패: ${e.message}`);
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
      const rows = app.model.rowsOf(log.relPath) || [];
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
        if (!navigator.onLine) { box.querySelector("[data-err]").textContent = "오프라인이라 저장할 수 없어요."; return; }
        const relPath = `${savePrefix()}${sheet.folder.join("/")}/${sheet.fileName}`;
        const existing = app.files.get(relPath);
        if (existing && !confirm(`${sheet.fileName}이(가) 이미 있어요. 덮어쓸까요?`)) return;
        try {
          const saved = await uploadFile(relPath, toWorkbook([sheet]), {rev: existing ? existing.rev : null, what: "calibration"});
          if (!saved) return;
          await loadModel();
          status(`실측 저장됨: ${material} ${sheet.fileName}`);
          ctx.renderCalDetail(material);
        } catch (e) {
          box.querySelector("[data-err]").textContent = `저장 실패: ${e.message}`;
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
        $(`[data-card="${draft.layers.length - 1}"]`)?.scrollIntoView({behavior: "smooth", block: "center"});
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
        layer[k] = el.value;
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
        if (k === "target_actual") renderStructure();
        persist();
      });
      cards.addEventListener("change", e => {
        const el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
        if (Number.isNaN(i) || !k) return;
        const layer = draft.layers[i];
        if (k === "material") { applyCombo(layer, el.value.trim()); autofill(layer, {force: true}); }
        else if (k === "port" || k === "tooling_factor") { layer[k] = el.value; autofill(layer, {force: true}); }
        else if (k === "mask") layer.mask = el.value;
        else return;
        persist();
        refreshCard(i);
        renderStructure();
      });
      cards.addEventListener("click", async e => {
        let btn = e.target.closest("[data-act]");
        if (!btn) {
          // Tapping the title row or summary of a card toggles it too.
          const zone = e.target.closest(".edit-layer .head, .edit-layer .summary");
          if (!zone || e.target.closest("button")) return;
          btn = zone.closest(".edit-layer").querySelector('[data-act="toggle"]');
        }
        const i = Number(btn.dataset.i), layers = draft.layers;
        const act = btn.dataset.act;
        if (act === "settings") {
          const card = layers[i];
          card.settings_open = !(card.settings_open ?? !String(card.material || "").trim());
          persist();
          return refreshCard(i);
        }
        if (act === "toggle") {
          layers[i].collapsed = !layers[i].collapsed;
          persist();
          return refreshCard(i);
        }
        if (act === "start" || act === "end") {
          const key = act === "start" ? "started_at" : "ended_at";
          if (layers[i][key] && !confirm(`${act === "start" ? "시작" : "끝"} 시각을 지금으로 바꿀까요?`)) return;
          layers[i][key] = nowText();
          layers[i][act === "start" ? "started_ms" : "ended_ms"] = Date.now();
          if (act === "end") layers[i].collapsed = true;
        } else if (act === "up" && i > 0) [layers[i - 1], layers[i]] = [layers[i], layers[i - 1]];
        else if (act === "down" && i < layers.length - 1) [layers[i + 1], layers[i]] = [layers[i], layers[i + 1]];
        else if (act === "remove") {
          if (hasData(layers[i]) && !confirm(`${i + 1}번 레이어(${layers[i].material || "빈 레이어"})를 지울까요?`)) return;
          layers.splice(i, 1);
          if (!layers.length) layers.push({...Core.DRAFT_LAYER_DEFAULTS});
        } else return;
        persist();
        if (act === "start" || act === "end") { refreshCard(i); renderStructure(); syncRunningState(); } else renderEditor();
      });
    }

    return {bind, render, flush, loadDraft, editLog, calibrationForm, hasDraft: () => Boolean(draft), TEST_PREFIX};
  }

  root.VTEEditor = {create, TEST_PREFIX};
})(typeof globalThis !== "undefined" ? globalThis : this);
