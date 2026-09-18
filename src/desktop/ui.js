    const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js";
    const {
      ALL_PORTS, MASKS, STRUCTURE_KEYS, STRUCTURE_DEFAULTS,
      toFloat, fmt, dateStrFromName, splitPair, pressureX1e7, sameNumeric, parseDateKey, displayDate, safeSheetTitle,
      calcRequiredMonitor, calcMonitorRate, getCell, norm, currentYYMMDD, latestOf, comboLabel
    } = VTECore;
    const APP_VERSION = "v11";
    const PALETTE = ["#E8F2FF", "#FFF2DE", "#E8F7EA", "#FFE8E8", "#E7F6F5", "#F1E8F7", "#FFEAF0", "#EEE8DE"];

    const state = {
      appDir: null,
      dirs: {},
      logs: [],
      materials: [],
      calFilesByMaterial: new Map(),
      materialComboOptions: [],
      materialComboByLabel: new Map(),
      selectedMaterial: "",
      sortKey: "dateStr",
      sortAsc: false,
      editingLog: null,
      detailLog: null,
      editingStructure: null,
      selectedCalibration: null,
      editingCalibration: null,
      calRows: [],
      layerRows: [],
      deletedLayers: [],
      structureRows: [],
      maskHolders: VTECore.maskHoldersFromMeta(null)
    };

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));


    async function getDir(parent, name, create = false) {
      try { return await parent.getDirectoryHandle(name, {create}); }
      catch { return null; }
    }
    async function ensureDir(parent, name) {
      return await parent.getDirectoryHandle(name, {create: true});
    }
    async function removeEntryByRelPath(relPath) {
      if (!state.appDir || !relPath) throw new Error("삭제 경로를 찾을 수 없습니다.");
      const parts = String(relPath).split("/").filter(Boolean);
      const name = parts.pop();
      let dir = state.appDir;
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      await dir.removeEntry(name);
    }
    async function readWorkbook(fileHandle) {
      const file = await fileHandle.getFile();
      const buf = await file.arrayBuffer();
      return XLSX.read(buf, {type: "array", cellDates: false});
    }
    async function workbookRows(fileHandle, maxRows = null, maxCols = null) {
      const wb = await readWorkbook(fileHandle);
      const ws = wb.Sheets[wb.SheetNames[0]];
      let rows = XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: null});
      if (maxRows) rows = rows.slice(0, maxRows);
      if (maxCols) rows = rows.map(r => Array.from({length: maxCols}, (_, i) => r[i] ?? null));
      return rows;
    }
    async function writeWorkbookToHandle(wb, fileHandle) {
      const data = XLSX.write(wb, {bookType: "xlsx", type: "array"});
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
    }
    async function collectXlsx(dir, prefix = "") {
      const out = [];
      if (!dir) return out;
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith(".") || name.startsWith("~$")) continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") out.push(...await collectXlsx(handle, rel));
        else if (/\.xlsx$/i.test(name)) out.push({name, relPath: rel, handle});
      }
      return out;
    }
    async function listDirectXlsx(dir, prefix = "") {
      const out = [];
      if (!dir) return out;
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file" && /\.xlsx$/i.test(name) && !name.startsWith(".") && !name.startsWith("~$")) {
          out.push({name, relPath: prefix ? `${prefix}/${name}` : name, handle});
        }
      }
      return out;
    }




    // ---------- file readers (core does the parsing) ----------
    async function readRowsSafe(handle) {
      try { return {rows: await workbookRows(handle, null, null)}; }
      catch (err) { return {error: err}; }
    }
    function sheetToFile(sheet) {
      const ws = XLSX.utils.aoa_to_sheet(sheet.aoa);
      ws["!cols"] = sheet.cols.map(wch => ({wch}));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheet.sheetTitle);
      return wb;
    }
    async function readCalibrationMeta(file) {
      const read = await readRowsSafe(file.handle);
      return VTECore.calibrationMetaFromRows(read.error ? null : read.rows, file);
    }
    async function readCalibrationMeasurements(file) {
      const read = await readRowsSafe(file.handle);
      return VTECore.calibrationMeasurementsFromRows(read.error ? null : read.rows, file);
    }
    async function parseProcessLog(file) {
      const read = await readRowsSafe(file.handle);
      if (read.error) return {error: String(read.error.message || read.error), material_list: [], layers: {}};
      return VTECore.parseProcessRows(read.rows);
    }
    async function getLatestCalibration(material, source = null, toolingFactor = null) {
      let fallback = null;
      for (const file of state.calFilesByMaterial.get(material) || []) {
        const match = VTECore.matchCalibration(await readCalibrationMeasurements(file), source, toolingFactor);
        if (match.measured) return match.measured;
        if (!fallback) fallback = match.withToolingFactor;
      }
      return fallback || VTECore.noCalibration(source);
    }
    async function buildMaterialComboOptions() {
      const best = new Map();
      for (const material of state.materials) {
        for (const file of state.calFilesByMaterial.get(material) || []) {
          for (const meta of await readCalibrationMeasurements(file)) VTECore.mergeComboOption(best, material, meta, file.dateStr);
        }
      }
      state.materialComboOptions = [...best.values()].sort((a, b) => a.label.localeCompare(b.label, "en", {sensitivity: "base"}));
      state.materialComboByLabel = new Map(state.materialComboOptions.map(item => [item.label, item]));
      renderMaterialComboOptions();
    }

    async function scanAll() {
      if (!state.appDir) return;
      $("#folderStatus").textContent = "폴더 스캔 중...";
      state.dirs.general = await getDir(state.appDir, "Process_General");
      state.dirs.tooling = await getDir(state.appDir, "Process_Tooling");
      state.dirs.calibration = await getDir(state.appDir, "Calibration");
      if (!state.dirs.general || !state.dirs.tooling || !state.dirs.calibration) {
        $("#folderStatus").textContent = "필수 폴더(Process_General, Process_Tooling, Calibration)를 확인하세요.";
      }
      const general = (await collectXlsx(state.dirs.general)).map(f => ({...f, type: "일반증착", root: "Process_General"}));
      const tooling = (await collectXlsx(state.dirs.tooling)).map(f => ({...f, type: "툴링", root: "Process_Tooling"}));
      state.logs = [...general, ...tooling].map(f => {
        const ds = dateStrFromName(f.name, f.relPath);
        return {...f, dateStr: ds, dateKey: parseDateKey(ds), filename: f.name, relPath: `${f.root}/${f.relPath}`};
      }).sort((a, b) => (b.dateKey || 0) - (a.dateKey || 0));
      await scanCalibrationFiles();
      await buildMaterialComboOptions();
      renderLogs();
      renderMaterials();
      $("#folderStatus").textContent = `선택됨: ${state.appDir.name} / 로그 ${state.logs.length}개 / 재료 ${state.materials.length}개`;
    }
    async function scanCalibrationFiles() {
      state.calFilesByMaterial = new Map();
      const names = new Set();
      if (state.dirs.calibration) {
        for await (const [mat, handle] of state.dirs.calibration.entries()) {
          if (handle.kind !== "directory" || mat.startsWith(".")) continue;
          names.add(mat);
          const files = (await listDirectXlsx(handle, `Calibration/${mat}`)).map(f => ({...f, material: mat, dateStr: dateStrFromName(f.name, f.relPath)}));
          state.calFilesByMaterial.set(mat, files);
        }
      }
      for (const log of state.logs.filter(l => l.type === "툴링")) {
        try {
          const parsed = await parseProcessLog(log);
          for (const item of parsed.material_list) {
            if (!item.material) continue;
            names.add(item.material);
            const arr = state.calFilesByMaterial.get(item.material) || [];
            if (!arr.some(x => x.relPath === log.relPath)) arr.push({...log, material: item.material, dateStr: log.dateStr});
            state.calFilesByMaterial.set(item.material, arr);
          }
        } catch {}
      }
      for (const [mat, files] of state.calFilesByMaterial.entries()) {
        files.sort((a, b) => (parseDateKey(b.dateStr) || 0) - (parseDateKey(a.dateStr) || 0));
      }
      state.materials = [...names].sort((a, b) => a.localeCompare(b, "en", {sensitivity: "base"}));
    }

    function renderMaterialComboOptions() {
      const html = state.materialComboOptions.map(item => `<option value="${escapeAttr(item.label)}"></option>`).join("");
      ["materialComboOptions", "calMaterialComboOptions"].forEach(id => {
        const list = $(`#${id}`);
        if (list) list.innerHTML = html;
      });
    }
    function confirmCalibrationApply(meta) {
      if (!meta) return false;
      const msg = [
        meta.label || meta.material || "",
        "",
        `날짜: ${displayDate(meta.date || "")}`,
        `Ratio: ${fmt(meta.ratio, 6)}`,
        `Monitor → Actual: ${fmt(meta.monitor_thickness, 3)} → ${fmt(meta.actual_thickness, 3)}`,
        `TF: ${fmt(meta.tooling_factor)}`,
        `Source: ${meta.source || ""}`,
        `파일: ${meta.relPath || ""}`,
        "",
        "이 최신 tooling/calibration 값을 적용할까요?"
      ].join("\n");
      return confirm(msg);
    }
    async function applyComboToLayerRow(row) {
      const meta = state.materialComboByLabel.get(row.material.trim());
      if (!meta) return false;
      if (!confirmCalibrationApply(meta)) {
        row.material = meta.material || row.material;
        return true;
      }
      row.material = meta.material || row.material;
      row.port = meta.source ? String(meta.source) : row.port;
      row.tooling_factor = fmt(meta.tooling_factor);
      row.ratio = fmt(meta.ratio, 6);
      recalcLayer(row);
      return true;
    }
    async function applyComboToStructureRow(row, key) {
      const meta = state.materialComboByLabel.get(String(row[key] || "").trim());
      if (!meta) return false;
      if (!confirmCalibrationApply(meta)) {
        row[key] = meta.material || row[key];
        return true;
      }
      const idx = key.slice(-1);
      row[key] = meta.material || row[key];
      row[`src${idx}`] = meta.source ? String(meta.source) : "";
      row[`tf${idx}`] = fmt(meta.tooling_factor);
      return true;
    }

    function renderLogs() {
      const tbody = $("#logTable tbody");
      tbody.innerHTML = "";
      const q = $("#filterMaterial").value.trim().toLowerCase();
      const from = parseDateKey($("#filterFrom").value);
      const to = parseDateKey($("#filterTo").value);
      let rows = state.logs.filter(log => {
        const hay = `${log.filename} ${log.relPath}`.toLowerCase();
        if (q && !hay.includes(q)) return false;
        if (from && (!log.dateKey || log.dateKey < from)) return false;
        if (to && (!log.dateKey || log.dateKey > to)) return false;
        return true;
      });
      rows.sort((a, b) => {
        const av = a[state.sortKey] ?? "", bv = b[state.sortKey] ?? "";
        const cmp = state.sortKey === "dateStr" ? ((a.dateKey || 0) - (b.dateKey || 0)) : String(av).localeCompare(String(bv));
        return state.sortAsc ? cmp : -cmp;
      });
      for (const log of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${displayDate(log.dateStr)}</td><td>${log.type}</td><td class="left">${escapeHtml(log.filename)}</td><td class="left">${escapeHtml(log.relPath)}</td>`;
        tr.ondblclick = () => showLogDetail(log);
        tbody.appendChild(tr);
      }
      $("#viewerCount").textContent = `${rows.length} / ${state.logs.length}`;
    }
    function renderMaterials() {
      const ul = $("#materialList");
      ul.innerHTML = "";
      $("#materialCount").textContent = `${state.materials.length}개`;
      for (const mat of state.materials) {
        const li = document.createElement("li");
        li.textContent = mat;
        li.className = mat === state.selectedMaterial ? "active" : "";
        li.onclick = () => selectMaterial(mat);
        ul.appendChild(li);
      }
    }
    async function selectMaterial(mat) {
      state.selectedMaterial = mat;
      state.selectedCalibration = null;
      state.calRows = [];
      renderMaterials();
      $("#selectedMaterialTitle").textContent = mat;
      const tbody = $("#calHistoryTable tbody");
      tbody.innerHTML = "";
      const files = state.calFilesByMaterial.get(mat) || [];
      let latestText = "Calibration ratio 없음";
      for (const file of files) {
        const measurements = await readCalibrationMeasurements(file);
        const latest = latestOf(measurements);
        if (latestText === "Calibration ratio 없음" && latest && latest.ratio !== null && latest.ratio !== 0) latestText = `Latest ratio ${fmt(latest.ratio, 6)} (${latest.date || file.dateStr})`;
        for (const m of measurements) {
          const rowIndex = state.calRows.push({meta: m, file, material: mat}) - 1;
          const tr = document.createElement("tr");
          tr.dataset.calIndex = String(rowIndex);
          tr.innerHTML = `<td>${escapeHtml(m.date || file.dateStr || "")}</td><td>${m.ratio === null ? "실측 없음" : fmt(m.ratio, 6)}</td><td>${escapeHtml(fmt(m.tooling_factor))}</td><td>${escapeHtml(m.source || "")}</td><td>${fmt(m.monitor_thickness, 4)}</td><td>${fmt(m.actual_thickness, 4)}</td><td>${escapeHtml(fmt(m.rate))}</td><td>${escapeHtml(fmt(m.power))}</td><td class="left">${escapeHtml(file.relPath)}</td>`;
          tr.onclick = () => {
            state.selectedCalibration = state.calRows[rowIndex];
            $$("#calHistoryTable tbody tr").forEach(row => row.style.background = "");
            tr.style.background = "#e7f0fb";
          };
          tr.ondblclick = () => openCalModal(state.calRows[rowIndex]);
          tbody.appendChild(tr);
        }
      }
      $("#latestCalText").textContent = latestText;
    }
    async function showLogDetail(log) {
      $("#detailTitle").textContent = `${log.filename} (${log.type})`;
      state.detailLog = log;
      const parsed = await parseProcessLog(log);
      const mt = $("#detailMaterialTable tbody");
      mt.innerHTML = "";
      parsed.material_list.forEach(item => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${escapeHtml(item.material)}</td><td>${escapeHtml(item.port)}</td>`;
        mt.appendChild(tr);
      });
      const lt = $("#detailLayerTable tbody");
      lt.innerHTML = "";
      let idx = 0;
      for (const [mat, rows] of Object.entries(parsed.layers).flatMap(([mat, rows]) => rows.map(item => [mat, [item]])).sort((a, b) => a[1][0].sequence - b[1][0].sequence)) {
        const color = PALETTE[Object.keys(parsed.layers).indexOf(mat) % PALETTE.length];
        rows.forEach(item => {
          const vacuum = item.start_pressure && item.end_pressure && item.start_pressure !== item.end_pressure ? `${item.start_pressure} / ${item.end_pressure}` : (item.start_pressure || item.pressure || "");
          const power = item.start_power && item.end_power && item.start_power !== item.end_power ? `${item.start_power} / ${item.end_power}` : (item.start_power || item.power || "");
          const temp = item.start_temp && item.end_temp && item.start_temp !== item.end_temp ? `${item.start_temp} / ${item.end_temp}` : (item.start_temp || item.temp || "");
          const tr = document.createElement("tr");
          tr.style.background = color;
          tr.innerHTML = `<td>${escapeHtml(mat)}</td><td>${escapeHtml(item.mask || "")}</td><td>${escapeHtml(vacuum)}</td><td>${escapeHtml(power)}</td><td>${escapeHtml(temp)}</td><td>${escapeHtml(fmt(item.rate))}</td><td>${escapeHtml(fmt(item.monitor_thickness))}</td><td>${escapeHtml(fmt(item.actual_thickness))}</td><td>${escapeHtml(fmt(item.ratio, 6))}</td><td>${escapeHtml(fmt(item.tooling_factor))}</td><td>${escapeHtml(fmt(item.target_actual))}</td><td>${escapeHtml(fmt(item.required_monitor))}</td><td class="left">${escapeHtml(item.notes || "")}</td>`;
          lt.appendChild(tr);
        });
      }
      openModal("detailModal");
    }

    async function loadLogIntoCreator(log) {
      const parsed = await parseProcessLog(log);
      if (parsed.error) return alert(`파싱 오류: ${parsed.error}`);
      state.deletedLayers = [];
      state.editingLog = log;
      $("#newDate").value = log.dateStr || currentYYMMDD();
      $("#newLogType").value = log.type === "툴링" ? "툴링" : "일반증착";
      const ports = new Map(parsed.material_list.map(item => [item.material, item.port]));
      // Phone logs carry extras the desktop table does not show (author/device metadata, start/end times, end rate, co-dep groups).
      // Keep them on the rows so saving here does not drop them. Same row filter and order as the parser loop below.
      const rawRows = await workbookRows(log.handle);
      state.editingMeta = VTECore.readSheetMeta(rawRows);
      state.maskHolders = VTECore.maskHoldersFromMeta(state.editingMeta);
      const extras = VTECore.draftLayersFromRows(rawRows);
      state.layerRows = [];
      for (const [mat, rows] of Object.entries(parsed.layers).flatMap(([mat, rows]) => rows.map(item => [mat, [item]])).sort((a, b) => a[1][0].sequence - b[1][0].sequence)) {
        for (const item of rows) {
          if (item.monitor_thickness === "Start" || item.target_actual !== null || item.required_monitor !== null || item.mask) {
            const pressure = [item.start_pressure || "", item.end_pressure || ""].filter(Boolean).join("/");
            const power = [item.start_power || "", item.end_power || ""].filter(Boolean).join("/");
            const temp = [item.start_temp || "", item.end_temp || ""].filter(Boolean).join("/");
            const extra = extras[state.layerRows.length] || {};
            const same = extra.material === mat;
            state.layerRows.push({
              ...(same ? {started_at: extra.started_at, ended_at: extra.ended_at, end_rate: extra.end_rate, orig_rate: fmt(item.rate), codep: extra.codep, vol: extra.vol} : {}),
              material: mat,
              port: item.port || ports.get(mat) || "",
              mask: item.mask || "1",
              target_actual: fmt(item.target_actual),
              required_monitor: fmt(item.required_monitor),
              measured_actual: fmt(item.actual_thickness),
              ratio: fmt(item.ratio, 6),
              tooling_factor: fmt(item.tooling_factor),
              rate: fmt(item.rate),
              source_temp_pair: temp,
              pressure_pair: pressure,
              power_pair: power,
              notes: same && extra.codep ? extra.notes : item.notes || ""
            });
          }
        }
      }
      if (!state.layerRows.length) addLayerRow();
      renderLayerRows();
      closeModal("detailModal");
      document.querySelector('[data-tab="creator"]').click();
      $("#creatorMsg").textContent = `편집 중: ${log.relPath}`;
    }

    function addLayerRow(defaults = {}, index = state.layerRows.length) {
      if (!Number.isInteger(index) || index < 0 || index > state.layerRows.length) return;
      const row = {
        material: defaults.material || "",
        port: defaults.port || "O-1",
        mask: defaults.mask || "1",
        target_actual: defaults.target_actual || "",
        required_monitor: defaults.required_monitor || "",
        measured_actual: defaults.measured_actual || "",
        ratio: defaults.ratio || "",
        tooling_factor: defaults.tooling_factor || "",
        rate: defaults.rate || "",
        source_temp_pair: defaults.source_temp_pair || "",
        pressure_pair: defaults.pressure_pair || "",
        power_pair: defaults.power_pair || "",
        notes: defaults.notes || ""
      };
      state.layerRows.splice(index, 0, row);
      renderLayerRows();
    }
    function deleteLayer(index) {
      if (index < 0 || index >= state.layerRows.length) return;
      state.deletedLayers.push({index, next: state.layerRows[index + 1], previous: state.layerRows[index - 1], row: state.layerRows.splice(index, 1)[0]});
      renderLayerRows();
    }
    function undoLayerDeletion() {
      const deleted = state.deletedLayers.pop();
      if (!deleted) return;
      const nextIndex = state.layerRows.indexOf(deleted.next);
      const previousIndex = state.layerRows.indexOf(deleted.previous);
      const index = nextIndex >= 0 ? nextIndex : previousIndex >= 0 ? previousIndex + 1 : Math.min(deleted.index, state.layerRows.length);
      state.layerRows.splice(index, 0, deleted.row);
      renderLayerRows();
    }
    function insertLayerAt(index) {
      addLayerRow({}, index);
      const input = $("#layerTable tbody").children[index]?.querySelector('[data-k="material"]');
      if (input) {
        input.focus({preventScroll: true});
        input.scrollIntoView({block: "nearest", inline: "nearest"});
      }
    }
    // One 3x3 grid per mask holder (1 2 3 / 4 5 6 / 7 8 9); clicking a cell steps through the four
    // things that fit in it. The arrangement changes per run, so it is entered with the layers.
    function renderMaskHolders() {
      $("#maskHolders").innerHTML = VTECore.MASKS.map(mask => {
        const used = state.layerRows.some(r => String(r.mask) === mask && r.material.trim());
        const cells = state.maskHolders[mask].map((token, i) => {
          const cell = VTECore.MASK_CELLS.find(c => c.token === token);
          return `<button class="mask-cell ${cell.key}" data-mask="${mask}" data-cell="${i}"
            title="${escapeAttr(cell.label)}" aria-label="${mask}번 홀더 ${i + 1}칸: ${escapeAttr(cell.label)}">${escapeHtml(cell.short)}</button>`;
        }).join("");
        return `<div class="mask-holder${used ? "" : " unused"}">
          <div class="mask-holder-head">Mask${mask}</div>
          <div class="mask-grid">${cells}</div></div>`;
      }).join("");
    }
    function renderLayerRows() {
      renderMaskHolders();
      const position = $("#layerInsertPosition");
      const selected = position.value;
      position.innerHTML = '<option value="end">맨 끝</option>' + state.layerRows.map((row, idx) =>
        `<option value="${idx}">${idx + 1}번 앞${row.material ? ` · ${escapeHtml(row.material)}` : ""}</option>`).join("");
      position.value = selected !== "end" && Number(selected) < state.layerRows.length ? selected : "end";
      $("#undoLayerBtn").disabled = !state.deletedLayers.length;
      $("#removeLayerBtn").disabled = !state.layerRows.length;
      const tbody = $("#layerTable tbody");
      tbody.innerHTML = "";
      const isTooling = $("#newLogType").value === "툴링";
      state.layerRows.forEach((row, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="white-space:nowrap">${idx + 1} <button type="button" data-insert-layer="${idx}" aria-label="${idx + 1}번 레이어 앞에 삽입">앞에 삽입</button> <button type="button" class="danger" data-delete-layer="${idx}" aria-label="${idx + 1}번 레이어 삭제">삭제</button></td>
          <td><input class="wide" data-k="material" list="materialComboOptions" value="${escapeAttr(row.material)}"></td>
          <td>${selectHtml("port", ALL_PORTS, row.port)}</td>
          <td>${selectHtml("mask", MASKS, row.mask)}</td>
          <td><input data-k="target_actual" value="${escapeAttr(row.target_actual)}"></td>
          <td><input data-k="required_monitor" value="${escapeAttr(row.required_monitor)}"></td>
          <td><input data-k="measured_actual" value="${escapeAttr(row.measured_actual)}" ${isTooling ? "" : "disabled"}></td>
          <td><input data-k="ratio" value="${escapeAttr(row.ratio)}"></td>
          <td><input data-k="tooling_factor" value="${escapeAttr(row.tooling_factor)}"></td>
          <td><input data-k="rate" value="${escapeAttr(row.rate)}"></td>
          <td><input data-k="source_temp_pair" value="${escapeAttr(row.source_temp_pair)}"></td>
          <td><input data-k="pressure_pair" value="${escapeAttr(row.pressure_pair)}"></td>
          <td><input data-k="power_pair" value="${escapeAttr(row.power_pair)}"></td>
          <td><input class="wide" data-k="notes" value="${escapeAttr(row.notes)}"></td>`;
        tr.querySelector("[data-insert-layer]").onclick = () => insertLayerAt(idx);
        tr.querySelector("[data-delete-layer]").onclick = () => deleteLayer(idx);
        $$("input,select", tr).forEach(el => {
          el.onchange = async () => {
            row[el.dataset.k] = el.value;
            if (el.dataset.k === "material" && row.material.trim()) {
              const applied = await applyComboToLayerRow(row);
              if (!applied) await fillRowCalibration(row);
            }
            if (["target_actual", "ratio"].includes(el.dataset.k)) recalcLayer(row);
            renderLayerRows();
          };
          el.oninput = () => {
            row[el.dataset.k] = el.value;
            if (["target_actual", "ratio"].includes(el.dataset.k)) recalcLayer(row);
          };
        });
        tbody.appendChild(tr);
      });
    }
    async function fillRowCalibration(row) {
      const mat = row.material.trim();
      if (!mat) return;
      const cal = await getLatestCalibration(mat, row.port || null, row.tooling_factor || null);
      if (cal.ratio !== null) row.ratio = fmt(cal.ratio, 6);
      if (cal.tooling_factor !== null && cal.tooling_factor !== undefined) row.tooling_factor = fmt(cal.tooling_factor);
      if (cal.source) row.port = String(cal.source);
      recalcLayer(row);
    }
    function recalcLayer(row) {
      const monitor = calcRequiredMonitor(row.target_actual, row.ratio);
      if (monitor !== null) row.required_monitor = fmt(monitor, 4);
    }

    async function createLog(saveAs = true) {
      if (!state.appDir) return alert("먼저 폴더를 선택하세요.");
      const yymmdd = $("#newDate").value.trim();
      if (!/^\d{6}$/.test(yymmdd)) return alert("날짜를 YYMMDD 형식으로 입력하세요.");
      const layers = state.layerRows.filter(r => r.material.trim());
      if (!layers.length) return alert("최소 1개 이상의 레이어를 입력하세요.");
      const isTooling = $("#newLogType").value === "툴링";
      // An end rate from the phone only stays while the (start) rate is unchanged here.
      const rows = VTECore.tagCodepRows(layers.map(r => (r.end_rate && r.rate !== r.orig_rate ? {...r, end_rate: ""} : r)));
      // A new PC log carries no meta of its own, but the measurement database needs a process id,
      // so always write meta here. Editing keeps the existing id instead of issuing a new one.
      const editingMeta = state.editingLog && state.editingMeta && Object.keys(state.editingMeta).length ? state.editingMeta : null;
      const meta = editingMeta
        ? {...editingMeta, "Modified By": "PC v11", "Modified At": new Date().toLocaleString("sv-SE").slice(0, 16)}
        : {App: `VTE Log Manager ${APP_VERSION}`, "Created At": new Date().toLocaleString("sv-SE").slice(0, 16)};
      meta[VTECore.PROCESS_ID_KEY] = VTECore.keepProcessId(editingMeta, yymmdd);
      Object.assign(meta, VTECore.maskHoldersToMeta(state.maskHolders), VTECore.samplesToMeta(rows, state.maskHolders));
      const sheet = VTECore.buildProcessLogSheet({isTooling, layers: rows, memo: $("#newMemo").value, version: APP_VERSION, meta});
      let dir = state.appDir;
      for (const part of VTECore.processLogFolder(isTooling, yymmdd)) dir = await ensureDir(dir, part);
      let fileHandle;
      if (state.editingLog && !saveAs) {
        fileHandle = state.editingLog.handle;
        if (!confirm(`${state.editingLog.filename} 파일에 덮어쓸까요?`)) return;
      } else {
        try { fileHandle = await dir.getFileHandle(sheet.fileName); if (!confirm(`${sheet.fileName} 이미 존재. 덮어쓸까요?`)) return; }
        catch { fileHandle = await dir.getFileHandle(sheet.fileName, {create: true}); }
      }
      await writeWorkbookToHandle(sheetToFile(sheet), fileHandle);
      $("#creatorMsg").textContent = `저장됨: ${state.editingLog && !saveAs ? state.editingLog.filename : sheet.fileName}`;
      await scanAll();
    }

    function openCalModal(editItem = null) {
      state.editingCalibration = editItem;
      const meta = editItem?.meta || {};
      const mat = meta.material || editItem?.material || state.selectedMaterial || "";
      const fields = [
        ["재료명", mat], ["날짜(YYMMDD)", meta.date || currentYYMMDD()], ["소스번호", meta.source || "O-1"], ["고정TF", fmt(meta.tooling_factor) || "20"],
        ["Monitor두께", fmt(meta.monitor_thickness)], ["Actual두께(ellipsometer)", fmt(meta.actual_thickness)], ["Pressure", meta.pressure || ""], ["Power", meta.power || ""],
        ["Temp", meta.temp || ""], ["Rate", meta.rate || ""], ["Density", meta.density || ""], ["Acoustic Impedance", meta.acoustic_imp || ""], ["비고", meta.notes || ""]
      ];
      const form = $("#calForm");
      form.innerHTML = "";
      for (const [label, val] of fields) {
        const id = `cal_${label.replace(/[^A-Za-z0-9가-힣]/g, "_")}`;
        const list = label === "재료명" ? ' list="calMaterialComboOptions"' : "";
        form.insertAdjacentHTML("beforeend", `<label for="${id}">${label}</label><input id="${id}" data-label="${escapeAttr(label)}"${list} value="${escapeAttr(val)}">`);
      }
      $$("input", form).forEach(inp => {
        inp.oninput = updateRatioPreview;
        if (inp.dataset.label === "재료명") {
          inp.onchange = () => applyComboToCalForm(inp.value);
        }
      });
      updateRatioPreview();
      openModal("calModal");
    }
    function calValue(label) {
      const input = $$(`#calForm input`).find(el => el.dataset.label === label);
      return input ? input.value : "";
    }
    function updateRatioPreview() {
      const mon = toFloat(calValue("Monitor두께"));
      const act = toFloat(calValue("Actual두께(ellipsometer)"));
      $("#ratioPreview").textContent = mon ? `Ratio actual/monitor: ${fmt(act / mon, 6)}` : "Ratio: -";
    }
    function setCalValue(label, value) {
      const input = $$(`#calForm input`).find(el => el.dataset.label === label);
      if (input) input.value = value ?? "";
    }
    function applyComboToCalForm(label) {
      const meta = state.materialComboByLabel.get(String(label || "").trim());
      if (!meta) return;
      if (!confirmCalibrationApply(meta)) {
        setCalValue("재료명", meta.material || label);
        return;
      }
      setCalValue("재료명", meta.material || label);
      setCalValue("소스번호", meta.source || "");
      setCalValue("고정TF", fmt(meta.tooling_factor));
      if (meta.density !== null && meta.density !== undefined) setCalValue("Density", meta.density);
      if (meta.acoustic_imp !== null && meta.acoustic_imp !== undefined) setCalValue("Acoustic Impedance", meta.acoustic_imp);
      updateRatioPreview();
    }
    async function deleteSelectedCalibration() {
      const item = state.selectedCalibration;
      if (!item) return alert("삭제할 Calibration row를 선택하세요.");
      const relPath = item.file?.relPath;
      if (!relPath) return alert("삭제 경로를 찾을 수 없습니다.");
      if (!confirm(`정말 삭제할까요?\n${relPath}`)) return;
      await removeEntryByRelPath(relPath);
      state.selectedCalibration = null;
      await scanAll();
      if (state.selectedMaterial) await selectMaterial(state.selectedMaterial);
    }
    async function deleteDetailLog() {
      if (!state.detailLog) return;
      if (!confirm(`정말 삭제할까요?\n${state.detailLog.relPath}`)) return;
      await removeEntryByRelPath(state.detailLog.relPath);
      closeModal("detailModal");
      state.detailLog = null;
      await scanAll();
    }

    async function saveCalibration(saveAs = false) {
      if (!state.appDir) return alert("먼저 폴더를 선택하세요.");
      const sheet = VTECore.buildCalibrationSheet({
        material: calValue("재료명"), date: calValue("날짜(YYMMDD)"), source: calValue("소스번호"), toolingFactor: calValue("고정TF"),
        monitor: calValue("Monitor두께"), actual: calValue("Actual두께(ellipsometer)"), pressure: calValue("Pressure"), power: calValue("Power"),
        temp: calValue("Temp"), rate: calValue("Rate"), density: calValue("Density"), acousticImpedance: calValue("Acoustic Impedance"), notes: calValue("비고")
      });
      if (sheet.error) return alert(sheet.error);
      let fileHandle;
      const editingFile = state.editingCalibration?.file;
      if (editingFile && !saveAs && String(editingFile.relPath || "").startsWith("Calibration/")) {
        fileHandle = editingFile.handle;
        if (!confirm(`${editingFile.name} 파일에 덮어쓸까요?`)) return;
      } else {
        let dir = state.appDir;
        for (const part of sheet.folder) dir = await ensureDir(dir, part);
        try { fileHandle = await dir.getFileHandle(sheet.fileName); if (!confirm(`${sheet.fileName} 이미 존재. 덮어쓸까요?`)) return; }
        catch { fileHandle = await dir.getFileHandle(sheet.fileName, {create: true}); }
      }
      await writeWorkbookToHandle(sheetToFile(sheet), fileHandle);
      closeModal("calModal");
      await scanAll();
      await selectMaterial(sheet.material);
    }

    function addStructureRow(defaults) {
      const row = Object.assign({...STRUCTURE_DEFAULTS}, defaults || {});
      state.structureRows.push(row);
      renderStructureRows();
    }
    function renderStructureRows() {
      const tbody = $("#structureInputTable tbody");
      tbody.innerHTML = "";
      state.structureRows.forEach(row => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${selectHtml("mode", ["single","co-dep"], row.mode)}</td>
          ${inputTd("mat1", row.mat1, "wide")}${selectTd("src1", ["",...ALL_PORTS], row.src1)}${inputTd("tf1", row.tf1)}${inputTd("vol1", row.vol1)}
          ${inputTd("mat2", row.mat2, "wide")}${selectTd("src2", ["",...ALL_PORTS], row.src2)}${inputTd("tf2", row.tf2)}${inputTd("vol2", row.vol2)}
          ${inputTd("mat3", row.mat3, "wide")}${selectTd("src3", ["",...ALL_PORTS], row.src3)}${inputTd("tf3", row.tf3)}${inputTd("vol3", row.vol3)}
          ${inputTd("thick", row.thick)}${inputTd("rate", row.rate)}${selectTd("mask", MASKS, row.mask)}`;
        $$("input,select", tr).forEach(el => {
          el.oninput = () => { row[el.dataset.k] = el.value; };
          el.onchange = async () => {
            row[el.dataset.k] = el.value;
            if (["mat1", "mat2", "mat3"].includes(el.dataset.k)) {
              const applied = await applyComboToStructureRow(row, el.dataset.k);
              if (applied) renderStructureRows();
            }
          };
        });
        tbody.appendChild(tr);
      });
    }
    async function saveStructure(saveAs = false) {
      if (!state.appDir) return alert("먼저 폴더를 선택하세요.");
      let fileHandle;
      if (state.editingStructure && !saveAs) {
        fileHandle = state.editingStructure.handle;
        if (!confirm(`${state.editingStructure.name} 파일에 덮어쓸까요?`)) return;
      } else {
        const root = await ensureDir(state.appDir, "Structures");
        const fileName = `${currentYYMMDD()}_structure_${APP_VERSION}.xlsx`;
        try { fileHandle = await root.getFileHandle(fileName); if (!confirm(`${fileName} 이미 존재. 덮어쓸까요?`)) return; }
        catch { fileHandle = await root.getFileHandle(fileName, {create: true}); }
        state.editingStructure = {handle: fileHandle, name: fileName, relPath: `Structures/${fileName}`};
      }
      await writeWorkbookToHandle(sheetToFile(VTECore.buildStructureSheet(state.structureRows)), fileHandle);
      $("#structMsg").textContent = `Structure 저장됨: ${state.editingStructure.name}`;
    }
    async function openStructure() {
      if (!window.showOpenFilePicker) return alert("이 브라우저에서는 파일 열기를 지원하지 않습니다.");
      const [handle] = await window.showOpenFilePicker({
        types: [{description: "Excel files", accept: {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"]}}],
        multiple: false
      });
      const rows = await workbookRows(handle, null, null);
      if (!rows.length) return;
      state.structureRows = VTECore.structureRowsFromSheet(rows);
      state.editingStructure = {handle, name: handle.name};
      renderStructureRows();
      await calculateStructure();
      $("#structMsg").textContent = `Structure 편집 중: ${handle.name}`;
    }
    // Presets/<name>.xlsx: same layout as Structures, shared with the mobile app's recording screen.
    async function savePreset() {
      if (!state.appDir) return alert("먼저 폴더를 선택하세요.");
      const rows = state.structureRows.filter(r => String(r.mat1 || "").trim());
      if (!rows.length) return alert("재료가 입력된 층이 필요합니다.");
      const name = VTECore.safeFileName(prompt("프리셋 이름") || "");
      if (!name) return;
      const dir = await ensureDir(state.appDir, "Presets");
      let fileHandle, exists = true;
      try { fileHandle = await dir.getFileHandle(`${name}.xlsx`); } catch { exists = false; fileHandle = await dir.getFileHandle(`${name}.xlsx`, {create: true}); }
      if (exists && !confirm(`${name}.xlsx 이미 존재. 덮어쓸까요?`)) return;
      const d = new Date(), pad = n => String(n).padStart(2, "0");
      const sheets = VTECore.buildPresetWorkbookSheets(rows, {Name: name, [exists ? "Updated At" : "Created At"]: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`, App: `VTE Log Manager ${APP_VERSION} (PC)`});
      const wb = XLSX.utils.book_new();
      for (const sheet of sheets) {
        const ws = XLSX.utils.aoa_to_sheet(sheet.aoa);
        ws["!cols"] = sheet.cols.map(wch => ({wch}));
        XLSX.utils.book_append_sheet(wb, ws, sheet.sheetTitle);
      }
      await writeWorkbookToHandle(wb, fileHandle);
      $("#structMsg").textContent = `프리셋 저장됨: Presets/${name}.xlsx`;
    }
    async function deleteCurrentStructure() {
      if (!state.editingStructure) return alert("삭제할 Structure 파일을 먼저 열거나 저장하세요.");
      if (!confirm(`정말 삭제할까요?\n${state.editingStructure.name}`)) return;
      if (state.editingStructure.relPath) await removeEntryByRelPath(state.editingStructure.relPath);
      else if (state.editingStructure.handle.remove) await state.editingStructure.handle.remove();
      else return alert("이 브라우저에서는 외부에서 연 Structure 파일 삭제를 지원하지 않습니다.");
      state.editingStructure = null;
      $("#structMsg").textContent = "Structure 삭제 완료";
    }
    async function calculateStructure() {
      const tbody = $("#structureResultTable tbody");
      tbody.innerHTML = "";
      const canvasLayers = [];
      for (let idx = 0; idx < state.structureRows.length; idx++) {
        const row = state.structureRows[idx];
        const totalThick = toFloat(row.thick);
        const totalRate = toFloat(row.rate);
        const materials = [];
        for (const n of [1,2,3]) {
          const mat = row[`mat${n}`].trim();
          const vol = toFloat(row[`vol${n}`]);
          if (mat) materials.push({mat, src: row[`src${n}`].trim(), tf: row[`tf${n}`].trim(), vol: vol ?? (materials.length ? 0 : 100)});
        }
        if (!materials.length || totalThick === null) continue;
        const used = row.mode === "single" ? [{...materials[0], vol: 100}] : materials;
        const totalVol = used.reduce((s, m) => s + m.vol, 0) || 100;
        canvasLayers.push({label: used.map(m => m.mat).join(":"), thick: totalThick, mask: row.mask});
        for (const m of used) {
          const fraction = m.vol / totalVol;
          const actualThick = totalThick * fraction;
          const actualRate = totalRate === null ? null : totalRate * fraction;
          const cal = await getLatestCalibration(m.mat, m.src || null, m.tf || null);
          const monitorThick = calcRequiredMonitor(actualThick, cal.ratio);
          const monitorRate = calcMonitorRate(actualRate, cal.ratio);
          const label = [m.mat, m.src, m.tf ? `TF${m.tf}` : ""].filter(Boolean).join(" ");
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHtml(label)}</td><td>${fmt(m.vol, 2)}</td><td>${fmt(cal.ratio, 6)}</td><td>${fmt(actualThick, 3)}</td><td>${monitorThick === null ? "ratio 없음" : fmt(monitorThick, 3)}</td><td>${fmt(actualRate, 4)}</td><td>${monitorRate === null ? "ratio 없음" : fmt(monitorRate, 4)}</td><td>${escapeHtml(row.mask)}</td>`;
          tbody.appendChild(tr);
        }
      }
      drawStack(canvasLayers);
    }
    function drawStack(layers) {
      const canvas = $("#stackCanvas");
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#555";
      ctx.textAlign = "center";
      ctx.font = "13px sans-serif";
      if (!layers.length) { ctx.fillText("입력된 layer 없음", canvas.width / 2, canvas.height / 2); return; }
      ctx.fillText("Top", canvas.width / 2, 20);
      const total = layers.reduce((s, l) => s + l.thick, 0) || 1;
      let y = canvas.height - 36;
      const x0 = 36, x1 = canvas.width - 34;
      [...layers].reverse().forEach((l, i) => {
        const h = Math.max(22, Math.min(120, l.thick / total * (canvas.height - 90)));
        const y0 = y - h;
        ctx.fillStyle = ["#4C78A8","#F58518","#54A24B","#E45756","#72B7B2","#B279A2","#FF9DA6","#9D755D"][i % 8];
        ctx.fillRect(x0, y0, x1 - x0, h);
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(x0, y0, x1 - x0, h);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 12px sans-serif";
        ctx.fillText(`${l.label} ${fmt(l.thick, 2)} nm M${l.mask}`, canvas.width / 2, y0 + h / 2 + 4);
        y = y0;
      });
      ctx.fillStyle = "#303030";
      ctx.fillRect(x0, y - 26, x1 - x0, 26);
      ctx.fillStyle = "#fff";
      ctx.fillText("Substrate / ITO", canvas.width / 2, y - 9);
      ctx.fillStyle = "#555";
      ctx.font = "13px sans-serif";
      ctx.fillText("Bottom", canvas.width / 2, canvas.height - 12);
    }

    function selectHtml(key, values, selected) {
      return `<select data-k="${key}">${values.map(v => `<option ${v === selected ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}</select>`;
    }
    function selectTd(key, values, selected) { return `<td>${selectHtml(key, values, selected)}</td>`; }
    function inputTd(key, value, cls = "") {
      const list = ["mat1", "mat2", "mat3"].includes(key) ? ' list="materialComboOptions"' : "";
      return `<td><input class="${cls}" data-k="${key}"${list} value="${escapeAttr(value)}"></td>`;
    }
    function escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
    }
    function escapeAttr(s) { return escapeHtml(s); }
    function openModal(id) { $(`#${id}`).classList.add("active"); }
    function closeModal(id) { $(`#${id}`).classList.remove("active"); }

    function init() {
      $("#newDate").value = currentYYMMDD();
      for (let i = 0; i < 4; i++) addLayerRow();
      [
        {mode:"single", mat1:"HATCN", vol1:"100", thick:"10", rate:"0.1", mask:"1"},
        {mode:"single", mat1:"TAPC", vol1:"100", thick:"40", rate:"0.5", mask:"1"},
        {mode:"co-dep", mat1:"CBP", vol1:"94", mat2:"Irppy3", vol2:"6", thick:"30", rate:"0.3", mask:"2"},
        {mode:"single", mat1:"B3PYMPM", vol1:"100", thick:"40", rate:"0.5", mask:"3"},
        {mode:"single", mat1:"LiF", vol1:"100", thick:"1", rate:"0.1", mask:"3"},
        {mode:"single", mat1:"Al", vol1:"100", thick:"100", rate:"1", mask:"3"}
      ].forEach(addStructureRow);
      drawStack([]);

      $$(".tab-btn").forEach(btn => btn.onclick = () => {
        $$(".tab-btn").forEach(b => b.classList.remove("active"));
        $$(".tab").forEach(t => t.classList.remove("active"));
        btn.classList.add("active");
        $(`#tab-${btn.dataset.tab}`).classList.add("active");
        if (btn.dataset.tab === "structure") drawStack([]);
      });
      $("#pickFolderBtn").onclick = async () => {
        if (!window.showDirectoryPicker) return alert("Chrome의 File System Access API가 필요합니다.");
        state.appDir = await window.showDirectoryPicker({mode: "readwrite"});
        $("#refreshBtn").disabled = false;
        await scanAll();
      };
      $("#refreshBtn").onclick = scanAll;
      $("#applyFilterBtn").onclick = renderLogs;
      ["filterMaterial","filterFrom","filterTo"].forEach(id => $(`#${id}`).onkeydown = e => { if (e.key === "Enter") renderLogs(); });
      $$("#logTable th.sortable").forEach(th => th.onclick = () => {
        if (state.sortKey === th.dataset.sort) state.sortAsc = !state.sortAsc;
        else { state.sortKey = th.dataset.sort; state.sortAsc = true; }
        renderLogs();
      });
      $("#addLayerBtn").onclick = () => {
        const position = $("#layerInsertPosition").value;
        insertLayerAt(position === "end" ? state.layerRows.length : Number(position));
      };
      $("#maskHolders").onclick = e => {
        const btn = e.target.closest("[data-cell]");
        if (!btn) return;
        const cells = state.maskHolders[btn.dataset.mask];
        const at = Number(btn.dataset.cell);
        cells[at] = VTECore.MASK_CELLS[(VTECore.MASK_CELLS.findIndex(c => c.token === cells[at]) + 1) % VTECore.MASK_CELLS.length].token;
        renderMaskHolders();
      };
      $("#removeLayerBtn").onclick = () => deleteLayer(state.layerRows.length - 1);
      $("#undoLayerBtn").onclick = undoLayerDeletion;
      $("#newLogType").onchange = renderLayerRows;
      $("#autofillBtn").onclick = async () => { for (const row of state.layerRows) await fillRowCalibration(row); renderLayerRows(); $("#creatorMsg").textContent = "최신 calibration ratio/TF/source를 채웠습니다."; };
      $("#recalcBtn").onclick = () => { state.layerRows.forEach(recalcLayer); renderLayerRows(); };
      $("#createLogBtn").onclick = () => createLog(true);
      $("#saveLogBtn").onclick = () => createLog(false);
      $("#saveAsLogBtn").onclick = () => createLog(true);
      $("#editDetailBtn").onclick = () => { if (state.detailLog) loadLogIntoCreator(state.detailLog); };
      $("#deleteDetailBtn").onclick = deleteDetailLog;
      $("#newCalBtn").onclick = () => openCalModal(null);
      $("#editCalBtn").onclick = () => {
        if (!state.selectedCalibration) return alert("수정할 Calibration row를 선택하세요.");
        openCalModal(state.selectedCalibration);
      };
      $("#deleteCalBtn").onclick = deleteSelectedCalibration;
      $("#saveCalBtn").onclick = () => saveCalibration(false);
      $("#saveAsCalBtn").onclick = () => saveCalibration(true);
      $("#addStructBtn").onclick = () => addStructureRow();
      $("#removeStructBtn").onclick = () => { state.structureRows.pop(); renderStructureRows(); };
      $("#openStructBtn").onclick = openStructure;
      $("#saveStructBtn").onclick = () => saveStructure(false);
      $("#saveAsStructBtn").onclick = () => saveStructure(true);
      $("#savePresetBtn").onclick = savePreset;
      $("#deleteStructBtn").onclick = deleteCurrentStructure;
      $("#calcStructBtn").onclick = calculateStructure;
      $$("[data-close]").forEach(btn => btn.onclick = () => closeModal(btn.dataset.close));
      $$(".modal-backdrop").forEach(bg => bg.onclick = e => { if (e.target === bg) closeModal(bg.id); });
    }
    init();
