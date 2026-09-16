/* VTE Log Manager PWA: Dropbox login, offline cache, log viewer, calibration lookup; editor.js adds recording. */
(function () {
  "use strict";
  const CONFIG = {
    appKey: "5rz8t9p1imu4wa9",
    defaultRoot: "/NEXT LAB/Log/A222/VTE log/VTE_MANAGER",
    version: "2026-09-16-7ef1c7e7"
  };
  const LS = {author: "vte.author", root: "vte.root"};
  const {fmt, displayDate, calcRequiredMonitor, calcMonitorRate} = VTECore;

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[ch]));

  const app = {client: null, store: null, model: VTEData.createModel([]), files: new Map(), tab: "logs", logType: "", logLimit: 100, syncing: false};
  let editor = null;

  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");
  const rootPath = () => localStorage.getItem(LS.root) || CONFIG.defaultRoot;

  function makeClient() {
    app.client = VTEDropbox.createClient({appKey: CONFIG.appKey, redirectUri: redirectUri(), rootPath: rootPath()});
  }
  function show(screen) {
    $$(".screen").forEach(s => { s.hidden = s.id !== `screen-${screen}`; });
    const main = ["logs", "log-detail", "record", "cal", "cal-detail", "settings"].includes(screen);
    $("#tabbar").hidden = !main;
    $("#syncBtn").hidden = !main;
    $("#structurePanel").hidden = !((screen === "record" && editor?.hasDraft()) || screen === "log-detail");
    window.scrollTo(0, 0);
  }
  function setTab(tab) {
    app.tab = tab;
    $$("#tabbar button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    if (tab === "logs") renderLogs();
    if (tab === "cal") renderMaterials();
    if (tab === "settings") renderSettings();
    if (tab === "record") editor.render();
    show(tab);
  }
  function status(text) { $("#syncStatus").textContent = text; }

  // ---------- data ----------
  async function loadModel() {
    const files = await app.store.allFiles();
    app.files = new Map(files.map(f => [f.relPath, {rev: f.rev, name: f.name}]));
    // Files saved in test mode appear at their normal place with a "테스트" badge.
    const prefix = VTEEditor.TEST_PREFIX;
    app.model = VTEData.createModel(files.map(f => (f.relPath.startsWith(prefix) ? {...f, viewPath: f.relPath.slice(prefix.length)} : f)));
    const last = await app.store.get("lastSync");
    status(last ? `로그 ${app.model.logs.length}개 · ${new Date(last.at).toLocaleString("ko-KR", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"})} 동기화` : "아직 동기화 전");
  }
  async function runSync() {
    if (app.syncing) return;
    if (!navigator.onLine) { status("오프라인 — 캐시된 데이터 표시 중"); return; }
    app.syncing = true;
    $("#syncBtn").disabled = true;
    try {
      const res = await VTEStore.sync({
        client: app.client, store: app.store, XLSX,
        onProgress: p => status(p.phase === "list" ? "Dropbox 목록 확인 중…" : `받는 중 ${p.done}/${p.total}`)
      });
      $("#syncError").hidden = true;
      await loadModel();
      if (res.failed.length) status(`동기화 완료 · ${res.failed.length}개 파일 실패`);
      if (app.tab === "logs") renderLogs();
      if (app.tab === "cal") renderMaterials();
      if (app.tab === "settings") renderSettings();
      if (app.tab === "record" && !editor.hasDraft()) editor.render();
    } catch (err) {
      if (/required scope|missing_scope/.test(`${err.summary} ${err.message}`)) {
        app.client.logout();
        $("#loginError").textContent = "Dropbox 앱에 파일 권한이 없어요.\n개발자 콘솔 Permissions 탭에서 files.metadata.read / files.content.read / files.content.write를 체크하고 Submit한 뒤 다시 로그인해 주세요.";
        show("login");
      } else if (err.status === 401 || err.summary === "not_logged_in" || /invalid_grant/.test(err.summary || "")) {
        app.client.logout();
        $("#loginError").textContent = "로그인이 만료됐어요. 다시 로그인해 주세요.";
        show("login");
      } else if (/not_found/.test(err.summary || "")) {
        status("Dropbox 폴더를 찾지 못했어요 — 설정에서 경로 확인");
      } else {
        status(`동기화 실패: ${err.message}`);
      }
      app.lastError = `${new Date().toLocaleString("ko-KR")}\n${err.name}: ${err.message}${err.status ? `\nHTTP ${err.status}` : ""}${err.summary ? `\n${err.summary}` : ""}${err.stack ? `\n${String(err.stack).split("\n").slice(0, 4).join("\n")}` : ""}`;
      console.error(err);
      $("#syncError").textContent = `동기화 오류 (이 화면을 캡처해서 보내주세요)\n\n${app.lastError}`;
      $("#syncError").hidden = false;
    } finally {
      app.syncing = false;
      $("#syncBtn").disabled = false;
    }
  }

  // ---------- logs ----------
  function renderLogs() {
    const logs = app.model.searchLogs({query: $("#logSearch").value, type: app.logType});
    $("#logCount").textContent = `${logs.length}개 로그`;
    const list = $("#logList");
    list.innerHTML = logs.slice(0, app.logLimit).map((log, i) => `
      <li data-i="${i}">
        <div class="meta"><span>${esc(displayDate(log.dateStr) || "날짜 없음")}</span><span>${log.test ? '<span class="badge test">테스트</span> ' : ""}<span class="badge ${log.type === "툴링" ? "tooling" : ""}">${esc(log.type)}</span></span></div>
        <div class="name">${esc(log.filename.replace(/\.xlsx$/i, ""))}</div>
      </li>`).join("") + (logs.length > app.logLimit ? `<li class="center" data-more="1">더 보기 (${logs.length - app.logLimit}개 남음)</li>` : "");
    list.onclick = e => {
      const li = e.target.closest("li");
      if (!li) return;
      if (li.dataset.more) { app.logLimit += 100; renderLogs(); return; }
      renderLogDetail(logs[Number(li.dataset.i)]);
    };
  }
  function pair(a, b) {
    if (a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== "" && String(a) !== String(b)) return `${fmt(a)} → ${fmt(b)}`;
    return fmt(a ?? b ?? "");
  }
  function renderLogDetail(log) {
    const parsed = app.model.parseLog(log);
    const layers = app.model.orderedLayers(log);
    const kv = (label, value) => value === "" || value === null || value === undefined ? "" : `<div><span>${label}</span><span>${esc(value)}</span></div>`;
    $("#logDetail").innerHTML = `
      <div class="card">
        <div class="meta"><span>${esc(displayDate(log.dateStr))}</span> <span class="badge ${log.type === "툴링" ? "tooling" : ""}">${esc(log.type)}</span></div>
        <h2>${esc(log.filename.replace(/\.xlsx$/i, ""))}</h2>
        ${parsed.error ? `<p class="error">${esc(parsed.error)}</p>` : ""}
        <div class="chips">${parsed.material_list.map(m => `<span class="chip">${esc(m.material)} · ${esc(m.port)}</span>`).join("")}</div>
        ${logMetaLine(log)}
        <div class="row" style="margin-top:8px"><button id="editLogBtn">수정</button><button id="deleteLogBtn" class="danger">삭제</button>${log.test ? '<span class="badge test">테스트 폴더 파일</span>' : ""}</div>
      </div>
      ${layers.map((l, i) => `
        <div class="layer" data-layer="${i}" style="border-left-color:${VTEStack.colorOf(l.material.split(":")[0])}">
          <h3><span>${i + 1}. ${esc(l.material)}</span><span class="badge none">${l.mask ? `Mask ${esc(l.mask)}` : ""}</span></h3>
          <div class="kv">
            ${kv("진공", pair(l.start_pressure, l.end_pressure))}
            ${kv("파워", pair(l.start_power, l.end_power))}
            ${kv("온도", pair(l.start_temp, l.end_temp))}
            ${kv("레이트", pair(l.rate, l.end_rate))}
            ${kv("모니터", fmt(l.monitor_thickness))}
            ${kv("실측", fmt(l.actual_thickness))}
            ${kv("목표 실제", fmt(l.target_actual))}
            ${kv("필요 모니터", fmt(l.required_monitor))}
            ${kv("Ratio", fmt(l.ratio, 6))}
            ${kv("TF", fmt(l.tooling_factor))}
          </div>
          ${l.notes ? `<div class="notes">${esc(l.notes)}</div>` : ""}
        </div>`).join("") || `<p class="hint">레이어 기록이 없어요.</p>`}
      <p class="hint">${esc(log.realPath || log.relPath)}</p>`;
    $("#editLogBtn").onclick = () => editor.editLog(log);
    $("#deleteLogBtn").onclick = () => deleteLog(log);
    renderLogStack(layers);
    show("log-detail");
  }

  // Stack drawing for a saved log. Co-deposition layers ("A:B") are split into side-by-side parts.
  function renderLogStack(layers) {
    const num = v => VTECore.toFloat(v);
    const hasTargets = layers.some(l => num(l.target_actual));
    let total = 0;
    const items = layers.map((l, i) => {
      const mats = String(l.material).split(":").map(m => m.trim()).filter(Boolean);
      const target = String(l.target_actual ?? "").split("/").map(num);
      const monitor = String(l.required_monitor ?? l.monitor_thickness ?? "").split("/").map(num);
      const parts = mats.map((material, k) => {
        const t = target.length === mats.length ? target[k] : (mats.length === 1 ? target[0] : null);
        const m = monitor.length === mats.length ? monitor[k] : (mats.length === 1 ? monitor[0] : null);
        const thick = hasTargets ? t : m;
        total += thick || 0;
        return {material, thick: thick || 0, label: thick ? fmt(thick, 1) : ""};
      });
      return {parts, mask: l.mask ? String(l.mask) : "", state: "", jump: i};
    });
    VTEStack.render(items, {
      totalText: items.length ? `총 ${fmt(total, 1) || 0} nm (${hasTargets ? "목표" : "모니터"})` : "",
      onItem: i => $(`#logDetail [data-layer="${i}"]`)?.scrollIntoView({behavior: "smooth", block: "start"})
    });
  }
  async function deleteLog(log) {
    const testMode = localStorage.getItem("vte.testMode") !== "0";
    if (!log.test && testMode) return alert("테스트 모드에서는 실제 로그 폴더의 파일을 지울 수 없어요.\n설정에서 테스트 모드를 끈 뒤 삭제해 주세요.");
    if (!navigator.onLine) return alert("오프라인이라 지금은 삭제할 수 없어요.");
    const name = log.filename;
    if (!confirm(`이 로그를 삭제할까요?\n\n${name}\n\nDropbox 휴지통에서 복구할 수 있어요.`)) return;
    if (!log.test && !confirm("실제 로그 폴더의 파일이에요. 정말 삭제할까요?")) return;
    try {
      await app.client.remove(log.realPath, {rev: app.files.get(log.realPath)?.rev || null});
      await app.store.deleteFiles([log.realPath]);
      await loadModel();
      status(`삭제됨: ${name}`);
      setTab("logs");
    } catch (err) {
      alert(/conflict|not_found/.test(err.summary || "")
        ? "다른 기기에서 이미 수정되거나 삭제된 파일이에요. 동기화 후 다시 확인해 주세요."
        : `삭제 실패: ${err.message}`);
    }
  }
  function logMetaLine(log) {
    const meta = VTECore.readSheetMeta(app.model.rowsOf(log.relPath) || []);
    const parts = [meta.Author && `작성 ${meta.Author}`, meta["Created At"], meta["Modified By"] && `수정 ${meta["Modified By"]} ${meta["Modified At"] || ""}`, meta.Preset && `프리셋 ${meta.Preset}`].filter(Boolean);
    return parts.length ? `<p class="hint">${esc(parts.join(" · "))}</p>` : "";
  }

  // ---------- calibration ----------
  function renderMaterials() {
    const q = $("#matSearch").value.trim().toLowerCase();
    const mats = app.model.materials.filter(m => !q || m.toLowerCase().includes(q));
    $("#matList").innerHTML = mats.map(mat => {
      const combos = app.model.comboOptions(mat);
      const rows = combos.map(c => {
        const has = c.ratio !== null && c.ratio !== 0;
        return `<div class="combo-line"><span>TF ${esc(fmt(c.tooling_factor) || "?")} · ${esc(c.source || "소스?")}</span>
          <span><b class="${has ? "" : "muted"}">${has ? fmt(c.ratio, 4) : "실측 없음"}</b> <small>${esc(displayDate(c.date) || "날짜 없음")}</small></span></div>`;
      }).join("");
      return `<li data-mat="${esc(mat)}">
        <div class="name">${esc(mat)}</div>
        ${rows || '<div class="combo-line"><span class="muted">calibration 기록 없음</span></div>'}
      </li>`;
    }).join("") || `<p class="hint">재료가 없어요. 동기화를 먼저 해주세요.</p>`;
    $("#matList").onclick = e => {
      const li = e.target.closest("li[data-mat]");
      if (li) renderCalDetail(li.dataset.mat);
    };
  }
  function renderCalDetail(material) {
    const combos = app.model.comboOptions(material);
    const history = app.model.calibrationHistory(material);
    $("#calDetail").innerHTML = `
      <div class="card"><h2>${esc(material)}</h2><p class="hint">TF·소스 조합별 최신 실측 ratio예요. 카드를 누르면 모니터 두께를 계산해요.</p>
        <button id="addCalBtn">+ 실측 추가</button></div>
      ${combos.map((c, i) => {
        const has = c.ratio !== null && c.ratio !== 0;
        return `<div class="combo" data-i="${i}">
          <div class="meta"><span><b>TF ${esc(fmt(c.tooling_factor) || "?")}</b> · ${esc(c.source || "소스 미기록")}</span><span>${esc(displayDate(c.date) || "날짜 없음")}</span></div>
          <div class="ratio">${has ? fmt(c.ratio, 4) : "실측 없음"}</div>
          ${has ? `<div class="hint">모니터 ${esc(fmt(c.monitor_thickness, 3))} → 실측 ${esc(fmt(c.actual_thickness, 3))} nm</div>` : ""}
          <div class="calc" hidden>
            <label>목표 실제 두께 (nm)<input inputmode="decimal" data-k="thick"></label>
            <label>필요 모니터 두께<output data-o="thick"></output></label>
            <label>목표 실제 레이트 (Å/s)<input inputmode="decimal" data-k="rate"></label>
            <label>모니터 레이트<output data-o="rate"></output></label>
          </div>
        </div>`;
      }).join("") || `<p class="hint">이 재료의 calibration 기록이 없어요.</p>`}
      <h2 style="margin:14px 2px 8px">기록</h2>
      <div class="scroll-x"><table class="hist">
        <thead><tr><th>날짜</th><th>Ratio</th><th>TF</th><th>소스</th><th>모니터</th><th>실측</th><th>레이트</th></tr></thead>
        <tbody>${history.map(m => `<tr>
          <td>${esc(displayDate(m.date || m.file.dateStr) || "-")}</td>
          <td>${m.ratio === null ? "실측 없음" : esc(fmt(m.ratio, 4))}</td>
          <td>${esc(fmt(m.tooling_factor))}</td><td>${esc(m.source || "")}</td>
          <td>${esc(fmt(m.monitor_thickness, 3))}</td><td>${esc(fmt(m.actual_thickness, 3))}</td><td>${esc(fmt(m.rate))}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
    $$("#calDetail .combo").forEach(card => {
      const combo = combos[Number(card.dataset.i)];
      card.onclick = e => {
        if (e.target.closest("input")) return;
        $$("#calDetail .combo").forEach(c => { c.classList.toggle("selected", c === card); c.querySelector(".calc").hidden = c !== card; });
      };
      card.querySelectorAll("input").forEach(input => {
        input.oninput = () => {
          const fn = input.dataset.k === "thick" ? calcRequiredMonitor : calcMonitorRate;
          const v = fn(input.value, combo.ratio);
          card.querySelector(`output[data-o="${input.dataset.k}"]`).textContent = v === null ? (input.value ? "ratio 없음" : "") : fmt(v, input.dataset.k === "thick" ? 3 : 4);
        };
      });
    });
    $("#addCalBtn").onclick = () => {
      const selected = $("#calDetail .combo.selected");
      const form = editor.calibrationForm(material, selected ? combos[Number(selected.dataset.i)] : combos[0]);
      $("#addCalBtn").closest(".card").after(form);
      form.querySelector("input[data-f=monitor]").focus();
    };
    show("cal-detail");
  }

  // ---------- settings ----------
  async function renderSettings() {
    $("#authorEdit").value = localStorage.getItem(LS.author) || "";
    $("#rootInput").value = rootPath();
    $("#testModeToggle").checked = localStorage.getItem("vte.testMode") !== "0";
    const last = await app.store.get("lastSync");
    $("#cacheInfo").textContent = last
      ? `파일 ${last.files}개 · 마지막 동기화 ${new Date(last.at).toLocaleString("ko-KR")}${last.failed?.length ? ` · 실패 ${last.failed.length}개` : ""}`
      : "아직 동기화하지 않았어요.";
    $("#versionInfo").textContent = `버전 ${CONFIG.version}`;
  }

  // ---------- start ----------
  function bind() {
    $("#loginBtn").onclick = async () => { location.href = await app.client.beginLogin(); };
    $("#authorForm").onsubmit = e => {
      e.preventDefault();
      localStorage.setItem(LS.author, $("#authorInput").value.trim());
      enterMain();
    };
    $("#authorEditForm").onsubmit = e => {
      e.preventDefault();
      localStorage.setItem(LS.author, $("#authorEdit").value.trim());
      status("작성자 이름을 바꿨어요.");
    };
    $("#rootForm").onsubmit = async e => {
      e.preventDefault();
      try {
        const value = $("#rootInput").value.trim().replace(/\/+$/, "");
        VTEDropbox.createClient({appKey: CONFIG.appKey, redirectUri: redirectUri(), rootPath: value});
        localStorage.setItem(LS.root, value);
        makeClient();
        await app.store.clear();
        await loadModel();
        await runSync();
      } catch (err) { status(err.message); }
    };
    $("#resyncBtn").onclick = async () => { await app.store.clear(); await loadModel(); await runSync(); };
    $("#logoutBtn").onclick = async () => {
      if (!confirm("로그아웃할까요? 이 기기의 캐시도 지워져요.")) return;
      app.client.logout();
      await app.store.clear();
      app.model = VTEData.createModel([]);
      show("login");
    };
    $("#testModeToggle").onchange = e => {
      if (!e.target.checked && !confirm("테스트 모드를 끄면 폰에서 저장하는 파일이 실제 로그 폴더에 생겨요. 끌까요?")) { e.target.checked = true; return; }
      localStorage.setItem("vte.testMode", e.target.checked ? "1" : "0");
      status(e.target.checked ? "테스트 폴더에만 저장해요." : "실제 로그 폴더에 저장해요.");
    };
    $("#syncBtn").onclick = runSync;
    $("#syncStatus").onclick = () => alert(app.lastError ? `마지막 오류\n\n${app.lastError}` : $("#syncStatus").textContent);
    $$("#tabbar button").forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
    $$("[data-back]").forEach(b => { b.onclick = () => setTab(b.dataset.back); });
    $("#logSearch").oninput = () => { app.logLimit = 100; renderLogs(); };
    $$("#logType button").forEach(b => {
      b.onclick = () => {
        app.logType = b.dataset.type;
        $$("#logType button").forEach(x => x.classList.toggle("active", x === b));
        app.logLimit = 100;
        renderLogs();
      };
    });
    $("#matSearch").oninput = renderMaterials;
    window.addEventListener("online", runSync);
  }
  async function enterMain() {
    setTab("logs");
    await loadModel();
    renderLogs();
    runSync();
  }
  // A new app version activates in the background; offer a one-tap reload instead of "open the app twice".
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol !== "https:") return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) $("#updateBanner").hidden = false;
    });
    navigator.serviceWorker.register("sw.js").then(reg => {
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    }).catch(() => {});
    $("#updateBtn").onclick = async () => {
      await editor.flush();
      location.reload();
    };
  }
  async function start() {
    registerServiceWorker();
    VTEStack.bind();
    editor = VTEEditor.create({app, $, $$, esc, status, show, loadModel, openLog: renderLogDetail, renderCalDetail, setTab, config: CONFIG});
    bind();
    editor.bind();
    makeClient();
    app.store = await VTEStore.createStore();
    await editor.loadDraft();
    try {
      if (await app.client.completeLogin(location.search)) history.replaceState(null, "", redirectUri());
    } catch (err) {
      history.replaceState(null, "", redirectUri());
      $("#loginError").textContent = err.message;
    }
    if (!app.client.isLoggedIn()) return show("login");
    if (!localStorage.getItem(LS.author)) return show("author");
    enterMain();
  }
  start();
})();
