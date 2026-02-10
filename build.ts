import { $ } from "bun";
import { mkdir } from "node:fs/promises";

const targets = [
  { name: "darwin-arm64", label: "macOS (Apple Silicon)" },
  { name: "darwin-x64", label: "macOS (Intel)" },
  { name: "linux-arm64", label: "Linux (ARM64)" },
  { name: "linux-x64", label: "Linux (x86_64)" },
];

const entrypoint = "./index.ts";
const outDir = "./dist";
const binName = "ez-ralph-loop";

await mkdir(outDir, { recursive: true });

console.log(`Building ${binName} for ${targets.length} targets...\n`);

for (const target of targets) {
  const outfile = `${outDir}/${binName}-${target.name}`;

  console.log(`  ${target.label} (bun-${target.name})`);

  try {
    await $`bun build ${entrypoint} --compile --target=bun-${target.name} --outfile ${outfile}`.quiet();
    console.log(`    -> ${outfile}\n`);
  } catch (err) {
    console.error(`    !! Failed to build for ${target.label}\n`);
  }
}

console.log("Done!");
