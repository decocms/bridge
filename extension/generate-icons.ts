/**
 * Generate PNG icons from SVG for the extension
 * Run: bun extension/generate-icons.ts
 */

import { $ } from "bun";

const sizes = [16, 48, 128];
const svgPath = "extension/icons/icon.svg";

async function generateIcons() {
  for (const size of sizes) {
    const outPath = `extension/icons/icon-${size}.png`;
    console.log(`Generating ${outPath}...`);

    // Use ImageMagick's convert command
    await $`convert -background none -resize ${size}x${size} ${svgPath} ${outPath}`.quiet();
  }

  console.log("Done! Icons generated.");
}

generateIcons().catch(console.error);
