// Atualizador dos dados do catálogo do jogo (a "Pokepedia").
//
// A Pokepedia do Poke Idle World lê arquivos ESTÁTICOS e PÚBLICOS do jogo
// (não precisam de login). Este script baixa esses arquivos para a pasta
// `game-data/`, para servirem de base de consulta (inclusive para o Claude
// ajudar com o jogo). Como o jogo atualiza direto, rode de novo quando quiser
// os dados mais recentes.
//
//   node update-gamedata.js      (ou: npm run update-data)
//
// Sem dependências externas — usa só o `https` do Node.

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'game-data');

// Fontes mapeadas em jul/2026 (via captura de rede da Pokepedia).
const SOURCES = [
  { name: 'creatures.json', url: 'https://poke.idleworld.online/game/creatures.json' },
  { name: 'items.json', url: 'https://poke.idleworld.online/game/items.json' },
  { name: 'moves-index.json', url: 'https://poke.idleworld.online/assets/effects/moves/index.json' },
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'PokeIdle-DataUpdater/1.0' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const summary = [];
  for (const s of SOURCES) {
    process.stdout.write('Baixando ' + s.name + ' ... ');
    try {
      const body = await fetchText(s.url);
      const parsed = JSON.parse(body); // valida que é JSON
      const count = Array.isArray(parsed)
        ? parsed.length
        : parsed && typeof parsed === 'object'
        ? Object.keys(parsed).length
        : 0;
      fs.writeFileSync(path.join(OUT, s.name), body);
      const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
      console.log('ok — ' + kb + ' KB, ' + count + ' entradas');
      summary.push(s.name + ': ' + kb + ' KB, ' + count + ' entradas');
    } catch (e) {
      console.log('FALHOU (' + e.message + ')');
      summary.push(s.name + ': FALHOU (' + e.message + ')');
    }
  }
  fs.writeFileSync(
    path.join(OUT, '_atualizado-em.txt'),
    'Atualizado em: ' + new Date().toISOString() + '\n\n' + summary.join('\n') + '\n'
  );
  console.log('\nPronto. Dados salvos em: ' + OUT);
})();
