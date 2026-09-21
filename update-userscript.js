// Atualizador dos userscripts da comunidade que o app roda dentro do jogo
// (PIW-QOL e JustPokédex).
//
// Baixa a versão mais recente direto do repositório oficial de cada autor e
// confere antes de gravar:
//   - integridade: se vier lixo (página de erro, download cortado), o arquivo
//     que já funciona NÃO é substituído;
//   - segurança: se o código novo passar a falar com um site que ele não usava
//     (fora da lista `hosts`), ou passar a montar código em tempo de execução
//     (eval / new Function / import dinâmico), a atualização é SEGURADA para
//     revisão em vez de instalada. É uma trava contra o pior caso — a conta do
//     autor ser invadida e alguém publicar um script que rouba a sessão do
//     jogo. Não é infalível (código ofuscado passaria), mas pega o óbvio.
//
// "Tem novidade" é decidido pelo CONTEÚDO, não pelo número da versão: os
// autores às vezes publicam mudanças sem subir o @version.
//
// Dois modos de uso:
//
//   1) Pela linha de comando, para atualizar as cópias que vão junto no app:
//        node update-userscript.js              (ou: npm run update-script)
//        node update-userscript.js justpokedex  (só um deles)
//      Grava em `userscripts/` aqui na pasta do projeto.
//
//   2) Pelo app (automático a cada 6h, ou pelo menu), que chama
//      `baixarUserscript()` daqui. Nesse caso grava na pasta de dados do
//      usuário, porque dentro do app instalado a pasta do programa é somente
//      leitura (fica empacotada no app.asar).
//
// Sem dependências externas — usa só o `https` do Node.

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cada script: de onde baixa, com que nome grava e como reconhecer que o que
// chegou é mesmo ele. A ORDEM importa: é a ordem de injeção na página (os dois
// trocam o `window.WebSocket` do jogo e se encadeiam um sobre o outro).
// `hosts` = sites que o script já usava quando foi auditado (set/2026).
const SCRIPTS = [
  {
    id: 'piwqol',
    nome: 'PIW-QOL',
    rotulo: 'PIW-QOL — melhorias do jogo',
    descricao: 'PIW-QOL (Poke Idle World - Quality of Life)',
    autor: 'Desjunior (JulianoCLI)',
    repo: 'https://github.com/JulianoCLI/PIW-QOL',
    url: 'https://raw.githubusercontent.com/JulianoCLI/PIW-QOL/main/piw-qol.user.js',
    arquivo: 'piw-qol.user.js',
    versaoArquivo: '_versao.txt',
    nomeCabecalho: /@name\s+.*PIW-QOL/i,
    atalho: 'CmdOrCtrl+Alt+Q',
    hosts: ['poke.idleworld.online', 'raw.githubusercontent.com', 'piwtools.com.br', 'tampermonkey.net'],
  },
  {
    id: 'justpokedex',
    nome: 'JustPokédex',
    rotulo: 'JustPokédex — IVs, mercado e shiny',
    descricao: 'JustPokédex (leitor de Pokémon, IVs, mercado e detector de shiny)',
    autor: 'guilherme-se',
    repo: 'https://github.com/guilherme-se/justpokedex',
    url: 'https://raw.githubusercontent.com/guilherme-se/justpokedex/main/JustPokedex.js',
    arquivo: 'justpokedex.user.js',
    versaoArquivo: '_versao-justpokedex.txt',
    nomeCabecalho: /@name\s+.*JustPokedex/i,
    atalho: 'CmdOrCtrl+Alt+J',
    hosts: [
      'poke.idleworld.online',
      'raw.githubusercontent.com',
      'github.com',
      'pokeapi.co',
      'piwtools.pages.dev',
      'www.myinstants.com',
    ],
  },
];

function spec(id) {
  const s = SCRIPTS.find((x) => x.id === id);
  if (!s) throw new Error('userscript desconhecido: ' + id);
  return s;
}

// Baixa um texto, seguindo redirecionamentos (o raw.githubusercontent às vezes
// redireciona) e com teto de tamanho para não engolir um download maluco.
function baixarTexto(url, saltos = 0) {
  return new Promise((resolve, reject) => {
    if (saltos > 5) return reject(new Error('redirecionamentos demais'));
    const req = https
      .get(url, { headers: { 'User-Agent': 'PokeIdle-UserscriptUpdater/1.0' } }, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          return resolve(baixarTexto(new URL(headers.location, url).href, saltos + 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + statusCode));
        }
        let dados = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          dados += c;
          if (dados.length > 5 * 1024 * 1024) {
            res.destroy();
            reject(new Error('arquivo grande demais (>5 MB)'));
          }
        });
        res.on('end', () => resolve(dados));
      })
      .on('error', reject);
    // Sem internet "pendurada" travando a checagem automática para sempre.
    req.setTimeout(30000, () => req.destroy(new Error('tempo esgotado')));
  });
}

// Confere que o que chegou é mesmo o script esperado, e não uma página de erro
// ou um download pela metade. Devolve a versão declarada no cabeçalho.
function validar(texto, s) {
  if (!texto.includes('// ==UserScript==')) throw new Error('não parece um userscript');
  if (!s.nomeCabecalho.test(texto)) throw new Error('não é o ' + s.nome);
  if (!texto.includes('// ==/UserScript==')) throw new Error('cabeçalho incompleto');
  // Os dois terminam numa IIFE fechada; se veio cortado, isto pega.
  if (!/\}\)\(\);?\s*$/.test(texto)) throw new Error('download incompleto');
  const m = texto.match(/@version\s+([0-9][\w.\-]*)/);
  if (!m) throw new Error('sem número de versão');
  return m[1];
}

// Trava de segurança (ver o topo do arquivo). Devolve a lista de motivos para
// segurar a atualização; lista vazia = pode instalar.
function motivosParaSegurar(texto, s) {
  const motivos = [];
  if (!/@grant\s+none/.test(texto)) {
    motivos.push('deixou de declarar "@grant none" (passou a pedir permissões do Tampermonkey)');
  }
  const perigosos = [
    [/\beval\s*\(/, 'usa eval()'],
    [/\bnew\s+Function\s*\(/, 'usa new Function()'],
    [/\bimport\s*\(\s*[^)'"`\s]/, 'carrega módulo por import() dinâmico'],
    [/\bimportScripts\s*\(/, 'usa importScripts()'],
  ];
  for (const [re, motivo] of perigosos) if (re.test(texto)) motivos.push(motivo);
  const novos = new Set();
  for (const m of texto.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1].toLowerCase().replace(/\.$/, '');
    if (!s.hosts.includes(host)) novos.add(host);
  }
  if (novos.size) motivos.push('passou a acessar site(s) novo(s): ' + [...novos].join(', '));
  return motivos;
}

const hash = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

// Lê o texto de um arquivo, ou null se não existir.
function lerOuNull(p) {
  try {
    return p ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

function versaoDoTexto(texto) {
  const m = texto && texto.match(/@version\s+([0-9][\w.\-]*)/);
  return m ? m[1] : null;
}

// Baixa, confere e grava em `pastaDestino`.
//   `atual` = caminho do arquivo que o app está usando agora (pode ser a cópia
//   que veio no instalador). Serve para saber se há novidade de verdade e para
//   guardar a versão anterior (`<arquivo>.anterior`), que o menu usa para
//   voltar atrás se uma atualização quebrar algo.
// Nunca lança por causa da trava de segurança: devolve `segurado` com os
// motivos, e quem chamou decide como avisar.
async function baixarUserscript(pastaDestino, id, atual) {
  const s = spec(id);
  const destino = path.join(pastaDestino, s.arquivo);
  const textoAtual = lerOuNull(atual || destino);
  const anterior = versaoDoTexto(textoAtual);

  const texto = await baixarTexto(s.url);
  const versao = validar(texto, s);
  const bytes = Buffer.byteLength(texto);
  const base = { versao, anterior, bytes, caminho: destino, hash: hash(texto) };

  if (textoAtual !== null && hash(textoAtual) === base.hash) {
    return { ...base, novidade: false };
  }
  const motivos = motivosParaSegurar(texto, s);
  if (motivos.length) return { ...base, novidade: true, segurado: motivos };

  fs.mkdirSync(pastaDestino, { recursive: true });
  // Guarda o que estava em uso, para poder voltar atrás.
  if (textoAtual !== null) fs.writeFileSync(destino + '.anterior', textoAtual);
  // Gravação atômica: escreve num temporário e só então renomeia, para nunca
  // deixar um arquivo pela metade no lugar do bom.
  const temporario = destino + '.tmp';
  fs.writeFileSync(temporario, texto);
  fs.renameSync(temporario, destino);

  fs.writeFileSync(
    path.join(pastaDestino, s.versaoArquivo),
    s.descricao + '\n' +
      'Autor: ' + s.autor + '\n' +
      'Fonte: ' + s.repo + '\n\n' +
      'Versao: ' + versao + '\n' +
      'Baixado em: ' + new Date().toISOString() + '\n' +
      'Tamanho: ' + bytes + ' bytes\n' +
      'SHA-256: ' + base.hash + '\n'
  );

  return { ...base, novidade: true };
}

// Volta para a versão guardada em `<arquivo>.anterior` (troca as duas de lugar,
// então usar de novo desfaz). Devolve a versão que ficou valendo.
function voltarVersaoAnterior(pastaDestino, id) {
  const destino = path.join(pastaDestino, spec(id).arquivo);
  const guardada = destino + '.anterior';
  if (!fs.existsSync(guardada)) throw new Error('não há versão anterior guardada');
  const textoGuardado = fs.readFileSync(guardada, 'utf8');
  const textoAtual = lerOuNull(destino);
  if (textoAtual !== null) fs.writeFileSync(guardada, textoAtual);
  fs.writeFileSync(destino + '.tmp', textoGuardado);
  fs.renameSync(destino + '.tmp', destino);
  return versaoDoTexto(textoGuardado);
}

module.exports = { baixarUserscript, voltarVersaoAnterior, motivosParaSegurar, SCRIPTS };

// Execução direta pela linha de comando: atualiza as cópias do projeto.
if (require.main === module) {
  const pasta = path.join(__dirname, 'userscripts');
  const pedido = process.argv[2];
  const alvos = pedido ? [spec(pedido)] : SCRIPTS;
  (async () => {
    for (const s of alvos) {
      process.stdout.write('Baixando ' + s.nome + ' ... ');
      try {
        const r = await baixarUserscript(pasta, s.id);
        const kb = (r.bytes / 1024).toFixed(1);
        if (r.segurado) {
          console.log('SEGURADO para revisão (versao ' + r.versao + '):');
          r.segurado.forEach((m) => console.log('  - ' + m));
          console.log('  O arquivo que ja estava la NAO foi alterado.');
          process.exitCode = 1;
          continue;
        }
        console.log('ok — versao ' + r.versao + ', ' + kb + ' KB');
        if (!r.novidade) console.log('  (sem mudancas: igual ao que ja estava)');
        else if (r.anterior) console.log('  (codigo novo; antes: ' + r.anterior + ')');
        console.log('  Salvo em: ' + r.caminho);
      } catch (e) {
        console.log('FALHOU (' + e.message + ')');
        console.log('  O arquivo que ja estava la NAO foi alterado.');
        process.exitCode = 1;
      }
    }
  })();
}
