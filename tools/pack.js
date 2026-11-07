// Genera strip-tracking.zip con solo los archivos de la extensión (sin tests, tools ni _metadata).
// Uso: npm run pack   (requiere Python 3 en el PATH)
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['manifest.json', 'background.js', 'shared.js', 'cookies.js', 'params.json', 'popup.html', 'popup.css', 'popup.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'];
const py = `import zipfile,sys
with zipfile.ZipFile('strip-tracking.zip','w',zipfile.ZIP_DEFLATED) as z:
    for f in sys.argv[1:]: z.write(f,f)
print(len(sys.argv)-1,'archivos -> strip-tracking.zip')`;
for (const cmd of ['python', 'python3', 'py']) {
  try { execFileSync(cmd, ['-I', '-c', py, ...files], { cwd: root, stdio: 'inherit' }); process.exit(0); } catch {}
}
console.error('No se encontró Python 3 para crear el zip.');
process.exit(1);
