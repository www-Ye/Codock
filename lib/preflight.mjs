import { lstat, readFile } from "node:fs/promises";
import { validateCredentials } from "./auth.mjs";
import { validateGithubConfig } from "./github-auth.mjs";

export async function checkCredentials(config, uid = process.getuid()) {
  const info = await lstat(config.runtime);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o077)
    throw Error("runtime must be an owner-only directory, mode 0700");
  const file = config.runtime + "/" + (config.authMode === "github" ? "github.json" : "auth.json");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o077)
    throw Error("credential file must be owner-only, mode 0600");
  try {
    const record = JSON.parse(await readFile(file, "utf8"));
    (config.authMode === "github" ? validateGithubConfig : validateCredentials)(record);
  } catch {
    // JSON parse errors can contain fragments of secrets.
    throw Error("Invalid credentials; complete the selected authentication setup");
  }
}
