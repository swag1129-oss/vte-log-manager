/* Floating, collapsible OLED stack drawing shared by the recording screen and the log viewer. */
(function (root) {
  "use strict";
  const PALETTE = ["#cfe3ff", "#ffe2b8", "#cdeed6", "#ffd1d1", "#d3efec", "#e6d6f2", "#ffd6e3", "#e8e0cf", "#d9e7b5", "#f7e3a1"];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[ch]));
  const $ = sel => document.querySelector(sel);
  let onJump = null;

  function colorOf(material) {
    let h = 0;
    for (const ch of String(material)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  /*
   * items (bottom layer first): [{parts: [{material, thick, label}], mask, state: "running"|"done"|"", jump}]
   * `thick` sets the block height; `label` is the text shown after the material.
   */
  function render(items, {totalText = "", onItem = null} = {}) {
    onJump = onItem;
    const collapsed = localStorage.getItem("vte.structureCollapsed") === "1";
    $("#structurePanel").classList.toggle("collapsed", collapsed);
    $("#structureToggle").textContent = `구조 ${items.length}층 ${collapsed ? "▾" : "▴"}`;
    // `items` is bottom layer first; the panel draws top layer first, so emit in reverse visual order.
    $("#structureBody").innerHTML = (totalText ? `<div class="stack-total">${esc(totalText)}</div>` : "") + items.slice().reverse().map(it => {
      const thick = it.parts.reduce((sum, p) => sum + (p.thick || 0), 0);
      const height = Math.round(Math.min(64, Math.max(18, 14 + Math.sqrt(thick) * 5)));
      return `<div class="stack-layer ${it.state || ""}" data-jump="${it.jump}" style="min-height:${height}px">
        <div class="parts">${it.parts.map(p => `<span class="part" style="background:${colorOf(p.material)}">${esc(p.material)}${p.label ? ` ${esc(p.label)}` : ""}</span>`).join("")}</div>
        <span class="mask">${it.mask ? `M${esc(it.mask)}` : ""}</span></div>`;
    }).join("") + `<div class="stack-sub">기판</div>`;
  }
  function bind() {
    $("#structureToggle").onclick = () => {
      const next = localStorage.getItem("vte.structureCollapsed") === "1" ? "0" : "1";
      localStorage.setItem("vte.structureCollapsed", next);
      $("#structurePanel").classList.toggle("collapsed", next === "1");
      $("#structureToggle").textContent = $("#structureToggle").textContent.replace(/[▾▴]$/, next === "1" ? "▾" : "▴");
    };
    $("#structureBody").onclick = e => {
      const block = e.target.closest("[data-jump]");
      if (block && onJump) onJump(Number(block.dataset.jump));
    };
  }
  // scrollIntoView puts the target under the sticky top bar (taller on iOS home-screen apps); scroll to just below it instead.
  function scrollToEl(el) {
    if (!el) return;
    const bars = [document.querySelector(".topbar"), document.querySelector("#updateBanner")]
      .filter(b => b && !b.hidden).reduce((h, b) => h + b.getBoundingClientRect().height, 0);
    window.scrollTo({top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - bars - 8), behavior: "smooth"});
  }
  root.VTEStack = {render, bind, colorOf, scrollToEl};
})(typeof globalThis !== "undefined" ? globalThis : this);
