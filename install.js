#!/usr/bin/env node
// rlm-opencode installer: copies plugin + kernel to ~/.config/opencode/
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configDir = join(homedir(), ".config", "opencode");
const pluginDir = join(configDir, "plugins");
const kernelDir = join(configDir, "rlm-kernel");

mkdirSync(pluginDir, { recursive: true });
mkdirSync(kernelDir, { recursive: true });

copyFileSync(join(here, "plugin", "rlm.ts"), join(pluginDir, "rlm.ts"));
copyFileSync(join(here, "kernel", "kernel.py"), join(kernelDir, "kernel.py"));

console.log("rlm-opencode installed:");
console.log(`  plugin  → ${join(pluginDir, "rlm.ts")}`);
console.log(`  kernel  → ${join(kernelDir, "kernel.py")}`);
console.log("Restart opencode to activate.");