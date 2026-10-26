// electron-builder afterPack hook, run once the app folder is assembled.
//
// macOS: ad-hoc sign the merged universal app. Apple Silicon will not run an
// unsigned bundle, and electron-builder only signs with a real identity.
//
// Windows: stamp BackQuant Terminal.exe with its icon and version details.
// electron-builder normally does this with rcedit under Wine, which does not run
// on Apple Silicon; resedit edits the same resources in plain JavaScript.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COMPANY = 'BackQuant';

async function stampWindowsExe(context) {
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const appInfo = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const icoPath = path.join(__dirname, 'icon-win.ico');

  const exe = PE.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = PE.NtExecutableResource.from(exe);

  // Replace the existing main icon group in place (same id and language).
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) throw new Error(`no icon group in ${exePath}`);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groups[0].id,
    groups[0].lang,
    iconFile.icons.map((i) => i.data),
  );

  // Version details shown in Explorer > Properties > Details and Task Manager.
  const [major, minor, patch] = appInfo.version.split('.').map((n) => parseInt(n, 10) || 0);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const lang = { lang: 1033, codepage: 1200 };
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues(lang, {
    CompanyName: COMPANY,
    FileDescription: appInfo.productName,
    ProductName: appInfo.productName,
    InternalName: appInfo.productName,
    OriginalFilename: `${appInfo.productFilename}.exe`,
    LegalCopyright: COMPANY,
    FileVersion: appInfo.version,
    ProductVersion: appInfo.version,
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    await stampWindowsExe(context);
    return;
  }
  if (context.electronPlatformName === 'darwin' && context.appOutDir.endsWith('mac-universal')) {
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  }
};
