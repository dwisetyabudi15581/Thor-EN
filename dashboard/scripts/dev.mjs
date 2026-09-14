#!/usr/bin/env node
/**
 * dev.mjs — `next dev` with a Webpack fallback for Android/Termux.
 *
 * Next 16 uses Turbopack for the dev server; its native binaries are not
 * available on android/arm64 (Termux). On Android `--webpack` is added
 * automatically; other platforms keep Turbopack (the default).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isAndroid = process.platform === "android";
const port = process.env.PORT || "3000";

const command = isAndroid
  ? `next dev -p ${port} --webpack`
  : `next dev -p ${port}`;

// shell: true so `next` resolves through PATH on any platform.
const PATH = `${path.join(root, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`;
console.log(`$ ${command}`);
const child = spawn(command, { stdio: "inherit", cwd: root, shell: true, env: { ...process.env, PATH } });
child.on("exit", (code) => process.exit(code ?? 0));
