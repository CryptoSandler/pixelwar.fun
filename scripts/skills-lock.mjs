#!/usr/bin/env node
/**
 * Hashes the vendored skills in .claude/skills and checks them against
 * skills-lock.json.
 *
 * Skills are prompt injection with a filesystem path: whatever is in them gets
 * read as instructions by an agent with tools. This repo therefore vendors
 * them — downloaded by hand, audited, committed — rather than installing them
 * from a registry at runtime. The lock file is what makes a later change
 * visible: an edited skill changes a hash, and a changed hash fails this check.
 *
 *   node scripts/skills-lock.mjs verify   exit 1 on any mismatch
 *   node scripts/skills-lock.mjs write    regenerate after a reviewed change
 *
 * `write` is not an update mechanism. Re-audit first, then write.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILLS_DIR = join(ROOT, ".claude", "skills");
const LOCK_PATH = join(ROOT, "skills-lock.json");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** One hash for the whole skill, over sorted "path sha256" lines. */
function treeHash(files) {
  const lines = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, hash]) => `${hash}  ${path}\n`)
    .join("");
  return sha256(Buffer.from(lines, "utf8"));
}

async function hashSkill(name) {
  const dir = join(SKILLS_DIR, name);
  const files = {};
  for (const path of await walk(dir)) {
    files[relative(dir, path)] = sha256(await readFile(path));
  }
  return { files, tree: treeHash(files) };
}

const mode = process.argv[2] ?? "verify";
const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
const installed = (await readdir(SKILLS_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let failed = false;

for (const name of installed) {
  const { files, tree } = await hashSkill(name);
  const recorded = lock.skills[name];

  if (!recorded) {
    console.error(`UNLOCKED  ${name} — installed but absent from skills-lock.json`);
    failed = true;
    continue;
  }

  if (mode === "write") {
    recorded.files = files;
    recorded.treeSha256 = tree;
    console.log(`written   ${name} (${Object.keys(files).length} files)`);
    continue;
  }

  if (recorded.treeSha256 !== tree) {
    console.error(`CHANGED   ${name}`);
    for (const [path, hash] of Object.entries(files)) {
      if (recorded.files[path] !== hash) {
        console.error(`  ${recorded.files[path] ? "modified" : "added   "}  ${path}`);
      }
    }
    for (const path of Object.keys(recorded.files)) {
      if (!files[path]) console.error(`  removed   ${path}`);
    }
    failed = true;
  } else {
    console.log(`ok        ${name} (${Object.keys(files).length} files)`);
  }
}

for (const name of Object.keys(lock.skills)) {
  if (!installed.includes(name)) {
    console.error(`MISSING   ${name} — in skills-lock.json but not installed`);
    failed = true;
  }
}

if (mode === "write") {
  await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`\nwrote ${relative(ROOT, LOCK_PATH)}`);
} else if (failed) {
  console.error("\nSkills do not match the lock file. Re-audit before writing new hashes.");
  process.exit(1);
} else {
  console.log("\nAll vendored skills match skills-lock.json.");
}
