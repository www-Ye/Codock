import { execFileSync, spawn } from "node:child_process";
import { readFile, lstat, access } from "node:fs/promises";
import path from "node:path";

// Check publish candidates, including staged content. Never print a matched secret.
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const files = [
  ...new Set(
    git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean),
  ),
];
const tracked = new Set(git("ls-files", "--cached", "-z").split("\0").filter(Boolean));
const problems = [];
const report = (file, reason) => problems.push(file + ": " + reason);
const forbidden =
  /(^|\/)(runtime|node_modules|dist|\.git|\.ssh|__pycache__)(\/|$)|(^|\/)(config\.json|\.env(?:\..*)?)$|\.(?:key|pem|p12|pfx|tar\.gz|zip)$/i;
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "credential token",
    /\b(?:gh[pousr]_[a-zA-Z0-9]{25,}|github_pat_[a-zA-Z0-9_]{30,}|sk-[a-zA-Z0-9_-]{25,})/,
  ],
  ["private workspace path", /\/(?:pfs|root|Users)\/[a-zA-Z0-9_.-]+/],
  ["personal email", /\b[\w.+-]+@(?:gmail|qq|163|126|outlook|hotmail)\.com\b/i],
  ["temporary deployment hostname", /\b[a-z0-9-]+\.(?:trycloudflare\.com|workers\.dev|ts\.net)\b/],
];
function inspect(file, text) {
  for (const [name, pattern] of patterns) if (pattern.test(text)) report(file, name);
  const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  for (const ip of ips)
    if (
      !/^(127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip) &&
      ip.split(".").every((n) => Number(n) <= 255)
    )
      report(file, "non-example IP address");
}
for (const file of files) {
  if (forbidden.test(file) && file !== ".env.example") {
    report(file, "excluded runtime/config/archive file");
    continue;
  }
  let stat;
  try {
    stat = await lstat(file);
  } catch (e) {
    if (e.code === "ENOENT") {
      if (tracked.has(file)) report(file, "staged file absent from working tree; review deletion");
      continue;
    }
    throw e;
  }
  if (stat.isSymbolicLink()) {
    report(file, "symlink in publish candidates");
    continue;
  }
  const binary = /\.(png|webp|jpe?g|gif|ico|mp4)$/i.test(file);
  if (binary) continue;
  const content = await readFile(file, "utf8");
  inspect(file, content);
  if (tracked.has(file)) {
    try {
      inspect(file + " [index]", git("show", ":" + file));
    } catch {
      report(file, "cannot inspect index");
    }
  }
  if (/\.(?:m?js)$/.test(file)) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--check", file], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve() : reject(Error("syntax"))));
      });
    } catch (error) {
      report(
        file,
        error.code ? "syntax check could not run: " + error.code : "JavaScript syntax error",
      );
    }
  }
  if (/\.json$/.test(file)) {
    try {
      JSON.parse(content);
    } catch {
      report(file, "invalid JSON");
    }
  }
  if (file.endsWith(".md")) {
    for (const match of content.matchAll(/\]\(([^)]+)\)|(?:src|href)="([^"]+)"/g)) {
      const link = (match[1] || match[2]).split("#")[0];
      if (!link || /^(https?:|mailto:)/.test(link)) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(link));
      if (!resolved.startsWith(process.cwd() + path.sep)) {
        report(file, "link outside repository");
        continue;
      }
      try {
        await access(resolved);
      } catch {
        report(file, "missing local link: " + link);
      }
    }
  }
}
if (problems.length) {
  console.error([...new Set(problems)].join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Checked ${files.length} publish candidates: syntax, local Markdown links and common sensitive patterns. Review images and staged changes manually before publishing.`,
  );
