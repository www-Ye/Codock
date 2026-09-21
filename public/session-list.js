/* Session navigation only: never creates, renames or stops a tmux process. */
class DeskSessions {
  constructor() {
    this.panel = document.querySelector("#sessionSidebar");
    this.toggle = document.querySelector("#sessionToggle");
    this.list = document.querySelector("#sessionList");
    this.search = document.querySelector("#sessionSearch");
    this.media = matchMedia("(max-width:850px)");
    this.items = [];
    this.pins = new Set();
    this.runtime = new Map();
    this.searchToggle = document.querySelector("#sessionSearchToggle");
    this.searchToggle.onclick = () => this.setSearch(this.search.classList.contains("hidden"));
    try {
      const saved = JSON.parse(localStorage.getItem("workbench.pinned") || "[]");
      if (Array.isArray(saved)) this.pins = new Set(saved.filter((s) => typeof s === "string"));
    } catch {}
    this.search.oninput = () => this.render();
    this.toggle.onclick = () => this.setOpen(!this.open);
    document.querySelector("#sessionClose").onclick = () => this.setOpen(false);
    document.querySelector("#sessionBackdrop").onclick = () => this.setOpen(false);
    this.media.addEventListener("change", () => this.setOpen(!this.media.matches));
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.search.classList.contains("hidden")) {
        e.preventDefault();
        this.setSearch(false);
        this.searchToggle.focus();
        return;
      }
      if (!this.media.matches) return;
      if (e.key === "Escape") {
        e.preventDefault();
        this.setOpen(false);
      }
      if (e.key === "Tab") {
        const nodes = [...this.panel.querySelectorAll("button,input,a")].filter(
            (n) => n.getClientRects().length,
          ),
          first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    this.setOpen(!this.media.matches);
  }
  setSearch(open) {
    this.search.classList.toggle("hidden", !open);
    this.searchToggle.setAttribute("aria-expanded", String(open));
    if (open) this.search.focus();
    else {
      this.search.value = "";
      this.render();
    }
  }
  setOpen(open) {
    if (!open) this.setSearch(false);
    this.open = open;
    document.body.classList.toggle("sidebar-open", open);
    document.body.classList.toggle("sidebar-collapsed", !open);
    this.toggle.setAttribute("aria-expanded", String(open));
    this.panel.inert = !open;
    document
      .querySelector("#sessionBackdrop")
      .classList.toggle("hidden", !open || !this.media.matches);
    document.querySelector("#deskContent").inert = Boolean(open && this.media.matches);
    if (this.media.matches && open) {
      this.panel.setAttribute("role", "dialog");
      this.panel.setAttribute("aria-modal", "true");
      document.querySelector("#sessionClose").focus();
    } else {
      this.panel.removeAttribute("role");
      this.panel.removeAttribute("aria-modal");
      if (this.panel.contains(document.activeElement)) this.toggle.focus();
    }
  }
  update(items, current) {
    this.items = [...items].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    this.select(current);
  }
  select(current) {
    // Navigation changes selection, not position. Apply recency on list refresh,
    // independent of when asynchronous visit receipts arrive.
    this.current = current?.name;
    this.render();
  }
  setRuntime(item, value) {
    this.runtime.set(item.name, value.state);
    const row = [...this.list.querySelectorAll(".session-row")].find(
      (n) => n.dataset.name === item.name,
    );
    if (row) this.paintRuntime(row, value.state);
  }
  paintRuntime(row, state) {
    const badge = row.querySelector(".session-runtime");
    const label = { running: "运行中", waiting: "待操作", ready: "待命" }[state];
    badge.textContent = label || "";
    badge.dataset.state = state || "unknown";
    badge.classList.toggle("hidden", !label);
  }
  render() {
    const term = this.search.value.trim().toLowerCase();
    this.list.replaceChildren();
    const items = this.items.filter((s) => (s.name + " " + s.label).toLowerCase().includes(term));
    document.querySelector("#sessionCount").textContent = this.items.length + " 个会话";
    const buckets = [
      ["常用", items.filter((s) => this.pins.has(s.name))],
      ["最近使用", items.filter((s) => !this.pins.has(s.name) && s.state === "online")],
      ["未连接", items.filter((s) => !this.pins.has(s.name) && s.state !== "online")],
    ];
    for (const [label, entries] of buckets) {
      if (!entries.length) continue;
      const heading = document.createElement("p");
      heading.className = "session-section";
      heading.textContent = label;
      this.list.append(heading);
      for (const item of entries) {
        const row = document.createElement("div");
        row.className = "session-row" + (item.name === this.current ? " active" : "");
        row.dataset.name = item.name;
        const link = document.createElement("a");
        link.href = "/s/" + item.name + "#chat";
        if (item.name === this.current) link.setAttribute("aria-current", "page");
        const icon = document.createElement("span");
        icon.className = "session-icon";
        icon.textContent = item.name.slice(0, 2).toUpperCase();
        const main = document.createElement("span"),
          title = document.createElement("strong"),
          note = document.createElement("small");
        main.className = "session-row-text";
        title.textContent = item.label;
        const dot = document.createElement("i");
        dot.className =
          "dot " + (item.state === "online" ? "online" : item.state === "rebind" ? "warn" : "");
        note.append(
          dot,
          document.createTextNode(
            item.name +
              (item.state === "online"
                ? item.preview
                  ? " · 网页已接入"
                  : ""
                : " · " + (item.state === "rebind" ? "需要确认" : "未运行")),
          ),
        );
        const run = document.createElement("span");
        run.className = "session-runtime hidden";
        main.append(title, note, run);
        link.append(icon, main);
        const pin = document.createElement("button");
        pin.className = "session-pin";
        pin.textContent = this.pins.has(item.name) ? "★" : "☆";
        pin.setAttribute(
          "aria-label",
          (this.pins.has(item.name) ? "取消置顶 " : "置顶 ") + item.label,
        );
        pin.setAttribute("aria-pressed", String(this.pins.has(item.name)));
        pin.onclick = () => {
          this.pins.has(item.name) ? this.pins.delete(item.name) : this.pins.add(item.name);
          try {
            localStorage.setItem("workbench.pinned", JSON.stringify([...this.pins]));
          } catch {}
          this.render();
          this.list.querySelector(`a[href="/s/${item.name}#chat"]`)?.nextElementSibling?.focus();
        };
        row.append(link, pin);
        this.list.append(row);
        this.paintRuntime(row, this.runtime.get(item.name));
      }
    }
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "没有找到这个会话";
      this.list.append(empty);
    }
  }
  navigated() {
    this.setSearch(false);
    if (this.media.matches) this.setOpen(false);
  }
}
