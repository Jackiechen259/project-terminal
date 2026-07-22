#!/usr/bin/env node
// Synchronizes the project version across all the places it lives:
//   - package.json
//   - src-tauri/tauri.conf.json
//   - src-tauri/Cargo.toml
//   - src-tauri/Cargo.lock
//
// Usage:
//   pnpm bump <patch|minor|major|prerelease> [preid]
//   pnpm bump <explicit-version>          # e.g. 1.0.0, 0.3.0-beta.1
//   pnpm bump patch --dry-run             # preview without writing
//   pnpm bump 1.0.0 --force               # allow non-increasing version
//
// Examples:
//   pnpm bump patch
//   pnpm bump minor
//   pnpm bump prerelease beta            # 0.2.1 -> 0.2.2-beta.0
//   pnpm bump 0.3.0

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = {
  packageJson: join(ROOT, "package.json"),
  tauriConf: join(ROOT, "src-tauri", "tauri.conf.json"),
  cargoToml: join(ROOT, "src-tauri", "Cargo.toml"),
  cargoLock: join(ROOT, "src-tauri", "Cargo.lock"),
};

const PKG_NAME = "project-terminal";

// --- arg parsing -----------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set();
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") flags.add("dry-run");
  else if (a === "--force") flags.add("force");
  else if (a === "--help" || a === "-h") flags.add("help");
  else if (a === "--preid") {
    i += 1;
    if (i >= args.length) fail("--preid requires a value");
    flags.add(`preid:${args[i]}`);
  } else positional.push(a);
}

if (flags.has("help") || positional.length === 0) {
  process.stderr.write(`Usage: pnpm bump <patch|minor|major|prerelease> [preid]
       pnpm bump <version>
       pnpm bump <...> --dry-run | --force

Bumps and syncs the version in package.json, tauri.conf.json, Cargo.toml, Cargo.lock.
After bumping, tag and push to trigger the release workflow:
  git add -A && git commit -m "chore: release v<version>"
  git tag v<version> && git push origin v<version>
`);
  process.exit(flags.has("help") ? 0 : 1);
}

const target = positional[0];
const preid = (() => {
  for (const f of flags) if (f.startsWith("preid:")) return f.slice(6);
  return positional.length > 1 ? positional[1] : null;
})();

// --- minimal semver --------------------------------------------------------

function parseSemver(v) {
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return {
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    pre: m[4] ?? null,
    build: m[5] ?? null,
  };
}

function stringifySemver(s) {
  let out = `${s.major}.${s.minor}.${s.patch}`;
  if (s.pre) out += `-${s.pre}`;
  if (s.build) out += `+${s.build}`;
  return out;
}

function comparePre(a, b) {
  const ap = a.split(".");
  const bp = b.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (i >= ap.length) return -1;
    if (i >= bp.length) return 1;
    const an = /^\d+$/.test(ap[i]);
    const bn = /^\d+$/.test(bp[i]);
    if (an && bn) {
      const d = +ap[i] - +bp[i];
      if (d !== 0) return Math.sign(d);
    } else if (an) return -1; // numeric prerelease fields sort before alphanumeric
    else if (bn) return 1;
    else if (ap[i] !== bp[i]) return ap[i] < bp[i] ? -1 : 1;
  }
  return 0;
}

function compareSemver(a, b) {
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch);
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  if (a.pre && b.pre) return comparePre(a.pre, b.pre);
  return 0;
}

function bumpVersion(sem, type, preid) {
  const next = { ...sem };
  switch (type) {
    case "major":
      next.major += 1;
      next.minor = 0;
      next.patch = 0;
      next.pre = null;
      break;
    case "minor":
      next.minor += 1;
      next.patch = 0;
      next.pre = null;
      break;
    case "patch":
      next.patch += 1;
      next.pre = null;
      break;
    case "prerelease":
      if (sem.pre) {
        const parts = sem.pre.split(".");
        let i = parts.length - 1;
        while (i >= 0 && !/^\d+$/.test(parts[i])) i -= 1;
        if (i >= 0) parts[i] = String(+parts[i] + 1);
        else parts.push("0");
        next.pre = parts.join(".");
      } else {
        next.patch += 1;
        next.pre = preid ? `${preid}.0` : "0";
      }
      break;
    default:
      fail(`Unknown bump type: ${type}`);
  }
  return next;
}

// --- file helpers ----------------------------------------------------------

function readText(path) {
  return readFileSync(path, "utf8");
}

function writeText(path, content) {
  writeFileSync(path, content);
}

// Replace the `version = "..."` belonging to the [package] table in Cargo.toml.
function setCargoTomlVersion(content, version) {
  const re = /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]*)(")/;
  if (!re.test(content)) throw new Error("Could not find [package] version in Cargo.toml");
  return content.replace(re, `$1${version}$3`);
}

// Replace the version of the local package entry in Cargo.lock.
function setCargoLockVersion(content, version) {
  const re = new RegExp(
    `(name\\s*=\\s*"${PKG_NAME}"[\\s\\S]*?\\nversion\\s*=\\s*")([^"]*)(")`
  );
  if (!re.test(content)) throw new Error(`Could not find ${PKG_NAME} version in Cargo.lock`);
  return content.replace(re, `$1${version}$3`);
}

// Replace the top-level "version" field in a JSON config, preserving all other formatting.
function setJsonVersion(content, version) {
  const re = /("version"\s*:\s*")([^"]*)(")/;
  if (!re.test(content)) throw new Error('Could not find "version" field in JSON config');
  return content.replace(re, `$1${version}$3`);
}

// --- main ------------------------------------------------------------------

const pkgRaw = readText(FILES.packageJson);
const pkg = JSON.parse(pkgRaw);
const current = pkg.version;
const curSem = parseSemver(current);
if (!curSem) fail(`Current package.json version is not valid semver: ${current}`);

const KEYS = ["patch", "minor", "major", "prerelease"];
let newSem;
if (KEYS.includes(target)) {
  newSem = bumpVersion(curSem, target, preid);
} else {
  newSem = parseSemver(target);
  if (!newSem) fail(`Not a valid version or bump type: ${target}`);
}

const newVersion = stringifySemver(newSem);

if (compareSemver(newSem, curSem) <= 0 && !flags.has("force")) {
  fail(
    `New version ${newVersion} is not greater than current ${current}. Re-run with --force to override.`
  );
}

if (newVersion === current) {
  process.stdout.write(`Version is already ${current}. Nothing to do.\n`);
  process.exit(0);
}

if (flags.has("dry-run")) {
  process.stdout.write(`[dry-run] ${current} -> ${newVersion}\n`);
  process.exit(0);
}

// All four files: targeted text replacement so only the version field changes,
// preserving the maintainer's existing formatting everywhere else.
writeText(FILES.packageJson, setJsonVersion(readText(FILES.packageJson), newVersion));
writeText(FILES.tauriConf, setJsonVersion(readText(FILES.tauriConf), newVersion));
writeText(FILES.cargoToml, setCargoTomlVersion(readText(FILES.cargoToml), newVersion));
writeText(FILES.cargoLock, setCargoLockVersion(readText(FILES.cargoLock), newVersion));

process.stdout.write(`Bumped ${current} -> ${newVersion}\n`);
process.stdout.write(
  `  updated: package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock\n`
);
process.stdout.write(
  `\nNext:\n  git add -A && git commit -m "chore: release v${newVersion}"\n  git tag v${newVersion} && git push origin v${newVersion}\n`
);

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
