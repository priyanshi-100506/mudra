/**
 * Prints the SHA-256 and byte size of every bundled model, for the provenance
 * table in public/models/README.md.
 *
 * The hash is recorded by hand rather than generated into the README on
 * purpose: its value is that a human checked what they downloaded against
 * what upstream published. A hash written automatically from whatever file
 * happens to be on disk records nothing at all.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/models');
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.onnx'))
  : [];

if (files.length === 0) {
  console.error(`No .onnx files in ${dir}.`);
  console.error('The build still succeeds; the pipeline will fail closed and send no image.');
  process.exit(1);
}

for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  console.log(`${f}`);
  console.log(`  SHA-256  ${createHash('sha256').update(buf).digest('hex')}`);
  console.log(`  Size     ${buf.length.toLocaleString()} bytes`);
}
