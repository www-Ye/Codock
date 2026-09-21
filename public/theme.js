/* Local appearance only: never sends terminal input or changes identity. */
(() => {
  const root = document.documentElement;
  const presets = {
    graphite: ["石墨黑", "Graphite"],
    midnight: ["午夜紫", "Midnight"],
    paper: ["暖纸白", "Paper"],
  };
  const characters = {
    nailong: ["奶龙", "webp"],
    duck: ["小鸭", "svg"],
    cat: ["猫", "svg"],
    robot: ["机器人", "svg"],
  };
  const read = (key) => {
    try {
      return localStorage.getItem("codock." + key);
    } catch {
      return null;
    }
  };
  const save = (key, value) => {
    try {
      localStorage.setItem("codock." + key, value);
    } catch {
      /* Storage may be disabled. */
    }
  };
  const saved = read("theme");
  if (Object.hasOwn(presets, saved)) root.dataset.theme = saved;
  if (["on", "off"].includes(read("mascot"))) root.dataset.mascot = read("mascot");
  if (Object.hasOwn(characters, read("character"))) root.dataset.character = read("character");
  const color = (key) => getComputedStyle(root).getPropertyValue(key).trim();
  const terminal = () => ({
    background: color("--terminal"),
    foreground: color("--text"),
    cursor: color("--accent"),
    selectionBackground: color("--selection"),
    black: color("--terminal"),
    brightBlack: color("--muted"),
  });
  const refresh = () => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color("--bg"));
    document
      .querySelectorAll("[data-preset]")
      .forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.preset === root.dataset.theme)),
      );
    const rgb = color("--accent")
      .slice(1)
      .match(/../g)
      ?.map((v) => parseInt(v, 16) / 255);
    if (rgb?.length === 3) {
      const lum = rgb
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      root.style.setProperty("--ink", lum > 0.179 ? "#000000" : "#ffffff");
    }
    window.dispatchEvent(new Event("codock-theme"));
  };
  const portrait = '<img class="pet-image" alt="" width="120" height="120" decoding="async">';
  const bubble = document.createElement("div");
  bubble.className = "pet-bubble";
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-live", "polite");
  bubble.hidden = true;
  document.body.append(bubble);
  const greetings = {
    nailong: ["陪你坐一会儿。", "伸个懒腰，再继续。"],
    duck: ["嘎！我在呢。", "喝口水，慢慢来。"],
    cat: ["喵，陪你盯一会儿。", "摸到了，呼噜呼噜。"],
    robot: ["滴，陪伴模式在线。", "记得让眼睛休息一下。"],
  };
  let playTimer,
    bubbleTimer,
    phrase = 0;
  const dismiss = () => {
    bubble.hidden = true;
    bubble.textContent = "";
    clearTimeout(bubbleTimer);
  };
  const play = (event) => {
    if (root.dataset.mascot === "off") return;
    root.dataset.petPlay = "yes";
    clearTimeout(playTimer);
    playTimer = setTimeout(() => delete root.dataset.petPlay, 1700);
    if (!event?.currentTarget) return;
    const lines = greetings[root.dataset.character];
    bubble.textContent =
      root.dataset.activity === "waiting"
        ? "有个确认在等你，看看原终端吧。"
        : root.dataset.activity === "running"
          ? "还在忙，我陪你等一会儿。"
          : lines[phrase++ % lines.length];
    bubble.hidden = false;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = bubble.offsetWidth,
      height = bubble.offsetHeight;
    bubble.style.left =
      Math.max(12, Math.min(innerWidth - width - 12, rect.left + rect.width / 2 - width / 2)) +
      "px";
    bubble.style.top =
      Math.max(
        12,
        Math.min(
          innerHeight - height - 12,
          rect.top > height + 20 ? rect.top - height - 10 : rect.bottom + 10,
        ),
      ) + "px";
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(dismiss, 3500);
  };
  window.addEventListener("resize", dismiss);
  document.addEventListener("visibilitychange", dismiss);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".pet-play,.status-pet")) dismiss();
  });
  document.querySelectorAll(".workbench").forEach((node) => {
    node.innerHTML = portrait + '<span class="dock-mark" aria-hidden="true">&gt;_</span>';
    if (!node.closest("a")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pet-play";
      button.setAttribute("aria-label", "逗一下桌面搭子");
      button.innerHTML = node.innerHTML;
      button.onclick = play;
      node.replaceChildren(button);
      node.removeAttribute("aria-hidden");
    }
  });
  const pet = document.createElement("button");
  pet.type = "button";
  pet.className = "status-pet";
  pet.innerHTML = portrait;
  pet.setAttribute("aria-label", "逗一下桌面搭子");
  pet.onclick = play;
  document.querySelector("#chatRunStatus")?.before(pet);
  const settings = document.createElement("section");
  settings.className = "appearance settings";
  settings.setAttribute("aria-labelledby", "appearanceTitle");
  settings.innerHTML =
    '<h2 id="appearanceTitle">你的桌面，你的搭子</h2><div class="theme-presets" role="group" aria-label="配色预设"></div><div class="character-presets" role="group" aria-label="选择桌面搭子"></div><label class="pet-toggle"><input id="mascotToggle" type="checkbox">显示桌面搭子<span class="micro">点一下，动一动、说句话 · 默认无声</span></label>';
  for (const [key, [label, english]] of Object.entries(presets)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.preset = key;
    button.innerHTML = `<span class="theme-swatch ${key}" aria-hidden="true"></span><strong>${label}</strong><small>${english}</small>`;
    button.onclick = () => {
      root.dataset.theme = key;
      save("theme", key);
      refresh();
    };
    settings.querySelector(".theme-presets").append(button);
  }
  const updateCharacter = () => {
    const character = root.dataset.character;
    document.querySelectorAll(".workbench .pet-image,.status-pet .pet-image").forEach((img) => {
      img.src = "/mascots/" + character + "." + characters[character][1];
    });
    settings
      .querySelectorAll("[data-pet]")
      .forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.pet === character)),
      );
  };
  for (const [key, [label, extension]] of Object.entries(characters)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.pet = key;
    button.innerHTML = `<img src="/mascots/${key}.${extension}" alt="" width="80" height="80" loading="lazy"><strong>${label}</strong>`;
    button.onclick = () => {
      root.dataset.character = key;
      save("character", key);
      updateCharacter();
      play();
    };
    settings.querySelector(".character-presets").append(button);
  }
  const toggle = settings.querySelector("#mascotToggle");
  toggle.checked = root.dataset.mascot !== "off";
  toggle.onchange = () => {
    dismiss();
    root.dataset.mascot = toggle.checked ? "on" : "off";
    save("mascot", root.dataset.mascot);
  };
  document.querySelector("#settingsPanel")?.prepend(settings);
  updateCharacter();
  window.CodockTheme = {
    terminal,
    status: (state) => {
      root.dataset.activity = ["running", "waiting", "ready"].includes(state) ? state : "unknown";
    },
  };
  refresh();
})();
