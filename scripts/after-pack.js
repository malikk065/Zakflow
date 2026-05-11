// After-Pack Hook: Ad-hoc Code-Signing für macOS
// Entfernt die Gatekeeper-Warnung ohne Apple Developer Account

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  // Nur auf macOS relevant
  if (process.platform !== 'darwin') return;
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  console.log(`\n🔐 Ad-hoc Signing: ${appPath}\n`);

  try {
    // Ad-hoc signieren (kostenlos, kein Developer Account nötig)
    // --force: überschreibt bestehende Signatur
    // --deep: signiert auch alle enthaltenen Frameworks/Binaries
    execSync(`codesign --force --deep --sign - "${appPath}"`, {
      stdio: 'inherit',
    });
    console.log('✅ App erfolgreich signiert\n');
  } catch (err) {
    console.warn('⚠️ Signing fehlgeschlagen (App funktioniert trotzdem):', err.message);
  }
};
