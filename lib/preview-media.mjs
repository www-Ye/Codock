// Serialized into authenticated HTML responses; executes on the preview origin,
// never the terminal origin. No project files or resource responses are modified.
export function installMediaViewer() {
  if (window.__workbenchMediaViewer) return;
  window.__workbenchMediaViewer = true;
  let host,
    root,
    dialog,
    content,
    active,
    returnFocus,
    pendingBack = false;
  const stateKey = "__workbenchPreviewMedia";
  const remove = () => {
    if (!active) return;
    active = null;
    for (const media of content.querySelectorAll("video,audio")) {
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    for (const image of content.querySelectorAll("img")) image.removeAttribute("src");
    content.replaceChildren();
    dialog.close();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const close = () => {
    if (!active) return;
    const token = active.token;
    remove();
    if (token && history.state?.[stateKey] === token) {
      pendingBack = true;
      history.back();
    }
  };
  const create = () => {
    if (host) return;
    host = document.createElement("workbench-media-viewer");
    // Shadow DOM protects the close control from project dialog/button CSS.
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{all:initial}*{box-sizing:border-box}
      dialog{position:fixed;inset:0;margin:auto;padding:0;border:1px solid #526053;border-radius:14px;width:calc(100vw - 16px);max-width:1100px;height:calc(100dvh - 16px);max-height:900px;background:#191f1c;color:#dbe1d5;font:14px/1.5 system-ui,sans-serif;overflow:hidden;overscroll-behavior:contain;color-scheme:dark}
      dialog[open]{display:flex;flex-direction:column}dialog::backdrop{background:#080c09d9}
      header{display:flex;align-items:center;gap:12px;flex:none;padding:8px 12px;padding-top:max(8px,env(safe-area-inset-top));border-bottom:1px solid #414c40}
      strong{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;font-weight:500}
      button{flex:none;min-width:80px;min-height:44px;padding:8px 14px;border:1px solid #526053;border-radius:10px;background:#303b31;color:#e6ebdf;font:inherit;cursor:pointer;touch-action:manipulation}
      button:focus-visible{outline:2px solid #c7b67c;outline-offset:2px}
      main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px;padding-bottom:max(12px,env(safe-area-inset-bottom));overflow:auto}
      img,video{display:block;max-width:100%;max-height:100%;object-fit:contain}audio{width:min(100%,600px)}
      p{padding:16px;color:#e5b29c}
    </style><dialog aria-label="图片与视频预览"><header><strong></strong><button type="button" aria-label="关闭预览">关闭 ×</button></header><main></main></dialog>`;
    document.documentElement.append(host);
    dialog = root.querySelector("dialog");
    content = root.querySelector("main");
    root.querySelector("button").addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close();
    });
  };
  window.addEventListener("popstate", () => {
    pendingBack = false;
    if (active && history.state?.[stateKey] !== active.token) remove();
  });
  window.addEventListener("pagehide", remove);
  // Bubble at window level so a project's own lightbox/router keeps precedence.
  window.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target?.closest?.("a[href]");
    if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return;
    const ext = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
    const tag = ["png", "jpg", "jpeg", "webp", "gif", "svg", "ico"].includes(ext)
      ? "img"
      : ["mp4", "webm"].includes(ext)
        ? "video"
        : ["mp3", "wav"].includes(ext)
          ? "audio"
          : null;
    if (!tag) return;
    event.preventDefault();
    if (pendingBack || active) return;
    create();
    returnFocus = link;
    const media = document.createElement(tag);
    if (tag === "img") media.alt = link.textContent.trim() || "图片";
    else {
      media.controls = true;
      media.preload = "metadata";
      media.setAttribute("playsinline", "");
    }
    root.querySelector("strong").textContent =
      tag === "img" ? "查看图片" : tag === "video" ? "播放视频" : "播放音频";
    media.addEventListener(
      "error",
      () => {
        if (!media.isConnected) return;
        const message = document.createElement("p");
        message.textContent = "媒体暂时无法加载，可以关闭后重试。";
        content.replaceChildren(message);
      },
      { once: true },
    );
    media.src = url.href;
    content.replaceChildren(media);
    let token = null;
    // Preserve an application's existing plain-object history state. Exotic
    // state belongs to that app: explicit close/Escape still work without it.
    if (history.state === null || Object.getPrototypeOf(history.state) === Object.prototype) {
      token = Date.now() + ":" + Math.random();
      try {
        history.pushState({ ...history.state, [stateKey]: token }, "", location.href);
      } catch {
        token = null;
      }
    }
    active = { token };
    dialog.showModal();
    root.querySelector("button").focus({ preventScroll: true });
  });
}
