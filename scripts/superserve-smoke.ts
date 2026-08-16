/** Proves the per-order VM lifecycle: create -> write -> exec -> pause -> reconnect. */
import { Sandbox } from "@superserve/sdk";

const sb: any = await Sandbox.create({ name: "landline-smoke", timeoutSeconds: 600, metadata: { product: "landline" } });
console.log("  created:", sb.id);

await sb.commands.run("mkdir -p /site");
await sb.files.write("/site/v0.html", "<!doctype html><html lang=en><title>hi</title><body>ok</body></html>");
const dec = (v: any) => (typeof v === "string" ? v : Buffer.from(v instanceof Uint8Array ? v : Object.values(v)).toString("utf8"));
const back = dec(await sb.files.read("/site/v0.html"));
console.log("  file roundtrip:", back.includes("<title>hi</title>") ? "ok" : "MISMATCH");

const probe = await sb.commands.run("command -v chromium || command -v chromium-browser || command -v google-chrome || echo NONE");
console.log("  chromium in VM:", (probe.output ?? probe.stdout ?? "").trim().split("\n")[0]);

await sb.pause();
console.log("  paused");

const again: any = await Sandbox.connect(sb.id);
const survived = dec(await again.files.read("/site/v0.html"));
console.log("  resumed:", again.id, "| same id:", again.id === sb.id, "| file survived:", survived.includes("ok"));

await Sandbox.killById(sb.id);
console.log("  cleaned up");
