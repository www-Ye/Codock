import { Transform, pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import { installMediaViewer } from "./preview-media.mjs";

// A tiny transport bridge, not project code. Appended after the document so its
// doctype, head and scripts are preserved. DOM readiness doesn't wait for media.
export function bridge(origin, error = null) {
  const target = JSON.stringify(origin).replaceAll("<", "\\u003c");
  const message = JSON.stringify(error).replaceAll("<", "\\u003c");
  return `\n<script>(()=>{${error ? "" : `(${installMediaViewer.toString()})();`}const send=(type,message)=>parent.postMessage({type,message},${target});const ready=()=>send(${error ? '"workbench-preview-error"' : '"workbench-preview-ready"'},${message});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();addEventListener('pagehide',()=>send('workbench-preview-navigation'));})();</script>`;
}
export function streamPreview(
  source,
  res,
  { html = false, origin, gzip = false, error = null } = {},
) {
  const streams = [source];
  if (html)
    streams.push(
      new Transform({
        transform(chunk, encoding, done) {
          done(null, chunk);
        },
        flush(done) {
          this.push(bridge(origin, error));
          done();
        },
      }),
    );
  if (gzip) streams.push(createGzip({ level: 4 }));
  streams.push(res);
  pipeline(...streams, () => {}); // pipeline tears down file/upstream on disconnect
}
export function acceptsGzip(req) {
  return String(req.headers["accept-encoding"] || "")
    .split(",")
    .some((value) => {
      const [name, ...parameters] = value.trim().split(";");
      return name === "gzip" && !parameters.some((p) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));
    });
}
export function previewError(req, res, origin, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const header of [
    "Content-Length",
    "Content-Encoding",
    "Content-Range",
    "ETag",
    "Last-Modified",
    "Location",
  ])
    res.removeHeader(header);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const safe = String(message).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
  res.end(
    req.method === "HEAD"
      ? undefined
      : `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>预览暂未打开</title><body><p>${safe}</p><p>请回到终端台，点击「刷新预览」。</p></body></html>${bridge(origin, message)}`,
  );
}
