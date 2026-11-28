import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Makers as people say them, from what firmware writes ("ASUSTeK COMPUTER INC.", "Hewlett-Packard"). */
const MAKERS: [RegExp, string][] = [
  [/^asus/i, "ASUS"],
  [/hewlett|^hp\b/i, "HP"],
  [/^lenovo/i, "Lenovo"],
  [/^dell/i, "Dell"],
  [/^acer/i, "Acer"],
  [/micro-star|^msi\b/i, "MSI"],
  [/^samsung/i, "Samsung"],
  [/^microsoft/i, "Microsoft"],
  [/^gigabyte/i, "Gigabyte"],
  [/^razer/i, "Razer"],
  [/^framework/i, "Framework"],
  [/^lg electronics/i, "LG"],
];

/**
 * "Dell Inspiron 15 3520", "ThinkPad X1 Carbon Gen 9", "Surface Laptop 5" from the maker, product and version the
 * firmware says (Lenovo keeps its product's name in the version, its model field holds a part number). The server
 * leaves out filler and virtual machines (`reportedModel`).
 */
export function modelFrom(parts: { vendor?: string; product?: string; version?: string }) {
  const vendor = (parts.vendor ?? "").trim();
  const maker = MAKERS.find(([pattern]) => pattern.test(vendor))?.[1] ?? "";
  const version = (parts.version ?? "").trim();
  const lenovo = maker === "Lenovo" && /\p{L}{3,}/u.test(version);
  const product = lenovo ? version : (parts.product ?? "").trim();
  if (!product) return "";
  // Surface and ThinkPad say who made them on their own.
  const named = lenovo || maker === "Microsoft" || product.toLowerCase().startsWith(maker.toLowerCase());
  return (named || !maker ? product : `${maker} ${product}`).replace(/\s+/g, " ").slice(0, 100);
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) =>
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout))),
  );

const dmi = (field: string) => readFile(`/sys/class/dmi/id/${field}`, "utf8").catch(() => "");

/** This computer's model ("MacBook Pro"), for its default name on the server; empty when it can't tell. */
export async function machineModel(): Promise<string> {
  try {
    if (process.platform === "darwin") {
      const out = JSON.parse((await run("system_profiler", ["SPHardwareDataType", "-json"])) || "{}");
      return String(out.SPHardwareDataType?.[0]?.machine_name ?? "").slice(0, 100);
    }
    if (process.platform === "win32") {
      const [vendor, product, version] = (
        await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$s=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_ComputerSystemProduct; $s.Manufacturer; $s.Model; $p.Version",
        ])
      ).split(/\r?\n/);
      return modelFrom({ vendor, product, version });
    }
    if (process.platform === "linux") {
      const [vendor, product, version] = await Promise.all(["sys_vendor", "product_name", "product_version"].map(dmi));
      return modelFrom({ vendor, product, version });
    }
  } catch {
    // An unreadable answer names it by its system instead.
  }
  return "";
}
