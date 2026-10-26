// Ad-hoc sign the merged universal app before the dmg is built. Apple Silicon will not
// run an unsigned bundle, and electron-builder only signs with a real identity.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (!context.appOutDir.endsWith('mac-universal')) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
