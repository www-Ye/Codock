import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const percent = (used, total) =>
  total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : null;
function cpuSample(text) {
  const line = text.split("\n").find((value) => value.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((x) => !Number.isFinite(x))) return null;
  return { total: values.reduce((a, b) => a + b, 0), idle: values[3] + (values[4] || 0) };
}
function memorySample(text) {
  const values = Object.fromEntries(
    [...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map(([, key, value]) => [
      key,
      Number(value),
    ]),
  );
  if (!values.MemTotal || !Number.isFinite(values.MemAvailable)) return null;
  return {
    totalMiB: Math.round(values.MemTotal / 1024),
    usedMiB: Math.round((values.MemTotal - values.MemAvailable) / 1024),
    percent: percent(values.MemTotal - values.MemAvailable, values.MemTotal),
  };
}
function gpuSample(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((value) => value.trim());
      if (parts.length !== 6) return null;
      const [index, utilization, usedMiB, totalMiB, temperatureC, name] = parts;
      const numbers = [index, utilization, usedMiB, totalMiB, temperatureC].map(Number);
      if (numbers.some((n) => !Number.isFinite(n)) || numbers[0] < 0 || numbers[3] <= 0)
        return null;
      return {
        index: numbers[0],
        name: name.slice(0, 80),
        utilization: Math.max(0, Math.min(100, numbers[1])),
        usedMiB: numbers[2],
        totalMiB: numbers[3],
        memoryPercent: percent(numbers[2], numbers[3]),
        temperatureC: numbers[4],
      };
    })
    .filter(Boolean);
}
export class SystemStatus {
  constructor({ read = readFile, run = exec, clock = () => Date.now() } = {}) {
    this.read = read;
    this.run = run;
    this.clock = clock;
    this.previous = null;
    this.value = null;
    this.until = 0;
    this.pending = null;
  }
  async init() {
    try {
      this.previous = cpuSample(await this.read("/proc/stat", "utf8"));
    } catch {
      /* CPU unavailable is displayed, not fatal. */
    }
  }
  async snapshot() {
    if (this.value && this.clock() < this.until) return this.value;
    if (this.pending) return this.pending;
    this.pending = this.measure()
      .then((value) => {
        this.value = value;
        this.until = this.clock() + 5000;
        return value;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async measure() {
    const [stat, mem, gpu] = await Promise.allSettled([
      this.read("/proc/stat", "utf8"),
      this.read("/proc/meminfo", "utf8"),
      this.run(
        "nvidia-smi",
        [
          "--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,name",
          "--format=csv,noheader,nounits",
        ],
        { timeout: 2500, maxBuffer: 12000 },
      ),
    ]);
    const current = stat.status === "fulfilled" ? cpuSample(stat.value) : null,
      previous = this.previous;
    this.previous = current;
    const total = current && previous ? current.total - previous.total : 0,
      idle = current && previous ? current.idle - previous.idle : 0;
    return {
      checkedAt: this.clock(),
      cpuPercent: total > 0 ? percent(total - idle, total) : null,
      memory: mem.status === "fulfilled" ? memorySample(mem.value) : null,
      gpus: gpu.status === "fulfilled" ? gpuSample(gpu.value.stdout) : [],
      gpuAvailable: gpu.status === "fulfilled",
    };
  }
}
