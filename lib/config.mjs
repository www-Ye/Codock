import path from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostname = (value) =>
  typeof value === "string" &&
  value.length <= 253 &&
  value.split(".").length >= 2 &&
  value.split(".").every((x) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x));
export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Configuration must be an object");
  const keys = [
    "origin",
    "previewSuffix",
    "socket",
    "projectRoot",
    "allowed",
    "port",
    "authMode",
    "githubOwner",
    "codexHome",
    "chatEnabled",
    "previewPorts",
    "brand",
  ];
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw Error("Unknown config field: " + key);
  const c = {
    port: 8790,
    authMode: "github",
    chatEnabled: true,
    previewPorts: [],
    codexHome: path.join(homedir(), ".codex"),
    ...input,
  };
  let url;
  try {
    url = new URL(c.origin);
  } catch {
    throw Error("origin must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !hostname(url.hostname)
  )
    throw Error("origin must be an HTTPS hostname, without path or port");
  c.origin = url.origin;
  if (
    !hostname(c.previewSuffix) ||
    url.hostname === c.previewSuffix ||
    url.hostname.endsWith("." + c.previewSuffix)
  )
    throw Error("previewSuffix must not contain the terminal origin");
  // Same-site is required by the preview Strict cookie. Public-suffix ownership is reviewed during deployment.
  for (const key of ["socket", "projectRoot", "codexHome"])
    if (typeof c[key] !== "string" || !path.isAbsolute(c[key]) || /[\r\n\0]/.test(c[key]))
      throw Error(key + " must be an absolute path");
  c.projectRoot = path.resolve(c.projectRoot);
  if (c.projectRoot === "/") throw Error("projectRoot cannot be filesystem root");
  if (
    !Array.isArray(c.allowed) ||
    !c.allowed.length ||
    c.allowed.length > 100 ||
    new Set(c.allowed).size !== c.allowed.length ||
    c.allowed.some((n) => typeof n !== "string" || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(n))
  )
    throw Error("allowed must list unique tmux names");
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)
    throw Error("Invalid listen port");
  if (!["github", "local"].includes(c.authMode)) throw Error("authMode must be github or local");
  if (
    c.authMode === "github" &&
    (!c.githubOwner ||
      !Number.isSafeInteger(c.githubOwner.id) ||
      c.githubOwner.id <= 0 ||
      typeof c.githubOwner.login !== "string" ||
      !/^[a-zA-Z0-9-]{1,39}$/.test(c.githubOwner.login))
  )
    throw Error("Configure the approved GitHub numeric user ID and login");
  if (typeof c.chatEnabled !== "boolean") throw Error("chatEnabled must be boolean");
  if (
    !Array.isArray(c.previewPorts) ||
    c.previewPorts.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535 || p === c.port)
  )
    throw Error("previewPorts must explicitly allow trusted local ports, excluding this service");
  if (c.brand !== undefined && (!c.brand || typeof c.brand !== "object" || Array.isArray(c.brand)))
    throw Error("brand must be an object");
  for (const key of Object.keys(c.brand || {}))
    if (!["name", "tagline", "preset", "mascot", "character", "accent", "legalText"].includes(key))
      throw Error("Unknown brand field: " + key);
  c.brand = {
    name: "Codock",
    tagline: "Your Codex, anywhere.",
    preset: "graphite",
    mascot: true,
    character: "nailong",
    accent: null,
    legalText: "",
    ...c.brand,
  };
  for (const key of ["name", "tagline", "legalText"])
    if (typeof c.brand[key] !== "string" || c.brand[key].length > 120)
      throw Error("Invalid brand text");
  if (!["graphite", "midnight", "paper"].includes(c.brand.preset))
    throw Error("Unknown brand.preset");
  if (typeof c.brand.mascot !== "boolean") throw Error("Invalid brand.mascot");
  if (!["nailong", "duck", "cat", "robot"].includes(c.brand.character))
    throw Error("Unknown brand.character");
  if (c.brand.accent !== null && !/^#[0-9a-f]{6}$/i.test(c.brand.accent))
    throw Error("brand.accent must be a six-digit hex color");
  return {
    ...c,
    runtime: path.join(root, "runtime"),
    secure: true,
    trustProxy: true,
  };
}
export async function loadConfig(file = process.env.DESK_CONFIG || path.join(root, "config.json")) {
  try {
    return validateConfig(JSON.parse(await readFile(file, "utf8")));
  } catch (e) {
    if (e.code === "ENOENT")
      throw Error("Create config.json from config.example.json before starting");
    throw e;
  }
}
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
export function renderIndex(html, brand = {}) {
  const values = {
    BRAND_NAME: brand.name || "Codock",
    BRAND_TAGLINE: brand.tagline || "Your Codex, anywhere.",
    BRAND_PRESET: ["graphite", "midnight", "paper"].includes(brand.preset)
      ? brand.preset
      : "graphite",
    BRAND_MASCOT: brand.mascot === false ? "off" : "on",
    BRAND_CHARACTER: ["nailong", "duck", "cat", "robot"].includes(brand.character)
      ? brand.character
      : "nailong",
    LEGAL_TEXT: brand.legalText || "",
  };
  return html.replace(
    /\{\{(BRAND_NAME|BRAND_TAGLINE|BRAND_PRESET|BRAND_MASCOT|BRAND_CHARACTER|LEGAL_TEXT)\}\}/g,
    (_, key) => escapeHtml(values[key]),
  );
}
