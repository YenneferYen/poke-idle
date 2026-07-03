// Hook do electron-builder: roda depois de empacotar o app, antes de gerar o
// instalador. Como desativamos a "edição/assinatura" nativa (para evitar um
// componente de assinatura que exige privilégios de link simbólico no Windows),
// aplicamos aqui o ícone da Pokébola e os metadados de versão no executável,
// usando o rcedit (que não precisa daquele componente).
const path = require('path');
const { rcedit } = require('rcedit');

exports.default = async function (context) {
  // Só faz sentido no Windows.
  if (context.electronPlatformName !== 'win32') return;

  const app = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${app.productFilename}.exe`);
  const icon = path.join(__dirname, 'assets', 'pokeball.ico');

  await rcedit(exePath, {
    icon,
    'file-version': app.version,
    'product-version': app.version,
    'version-string': {
      ProductName: 'Poke Idle',
      FileDescription: 'Poke Idle',
      CompanyName: 'Poke Idle',
      LegalCopyright: '',
      OriginalFilename: `${app.productFilename}.exe`,
    },
  });
};
