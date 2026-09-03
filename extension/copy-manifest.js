import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcPath = path.join(__dirname, 'src', 'manifest.json');
const destPath = path.join(__dirname, 'dist', 'manifest.json');

try {
  const manifestRaw = fs.readFileSync(srcPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  // Update TS extensions to JS for the compiled output
  if (manifest.background && manifest.background.service_worker) {
    manifest.background.service_worker = manifest.background.service_worker.replace(/\.ts$/, '.js');
  }

  if (manifest.content_scripts) {
    manifest.content_scripts = manifest.content_scripts.map(script => {
      if (script.js) {
        script.js = script.js.map(jsFile => jsFile.replace(/\.ts$/, '.js'));
      }
      return script;
    });
  }

  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Manifest copied and updated successfully to dist/manifest.json');
} catch (err) {
  console.error('Error copying manifest:', err);
  process.exit(1);
}
