const {
  app,
  BrowserWindow,
  powerSaveBlocker,
  Menu,
  Tray,
  shell,
  globalShortcut,
  screen,
  dialog,
  Notification,
  nativeImage,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const {
  baixarUserscript,
  voltarVersaoAnterior,
  SCRIPTS: USERSCRIPTS,
} = require('./update-userscript');

// ---------------------------------------------------------------------------
// Multi-conta (o jogo permite até 4 contas no mesmo IP).
// Cada conta roda numa instância separada com a SUA PRÓPRIA pasta de dados, ou
// seja: login, preferências e backups totalmente independentes — a conta 2 NÃO
// herda o login já feito da 1. Sem o parâmetro, usa a pasta de sempre.
//   "Poke Idle.exe" --conta=2
// Como o "instância única" do Electron é por pasta de dados, as contas podem
// rodar ao mesmo tempo; abrir a MESMA conta duas vezes continua bloqueado
// (traz a janela existente para a frente).
// IMPORTANTE: precisa vir antes de qualquer app.getPath('userData').
// ---------------------------------------------------------------------------
const MAX_ACCOUNTS = 4;
const ACCOUNT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--conta='));
  const n = arg ? parseInt(arg.split('=')[1], 10) : 1;
  return Number.isInteger(n) && n >= 1 && n <= MAX_ACCOUNTS ? n : 1;
})();
if (ACCOUNT > 1) {
  app.setPath('userData', path.join(app.getPath('appData'), 'poke-idle-conta' + ACCOUNT));
}
// Sufixo usado no título da janela e na bandeja, para diferenciar as contas.
const ACCOUNT_SUFFIX = ACCOUNT > 1 ? ' — Conta ' + ACCOUNT : '';

// Abre outra conta numa nova instância (nova pasta de dados = login do zero).
function openAccount(n) {
  const args = ['--conta=' + n];
  try {
    if (app.isPackaged) {
      spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Em desenvolvimento, o executável é o electron: passa o caminho do app.
      spawn(process.execPath, [app.getAppPath(), ...args], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.warn('[Poke Idle] Falha ao abrir a conta ' + n + ':', e && e.message);
  }
}

const GAME_URL = 'https://poke.idleworld.online/';
const ICON_PATH = path.join(__dirname, 'assets', 'pokeball.ico');
// Base do ícone da bandeja. Nas contas extras usa a pokébola com o número, para
// dar pra diferenciar as instâncias de relance ao lado do relógio.
const PNG_ICON_PATH = path.join(
  __dirname,
  'assets',
  ACCOUNT > 1 ? 'pokeball-' + ACCOUNT + '.png' : 'pokeball.png'
);
const TOGGLE_HOTKEY = 'CommandOrControl+Alt+P';

// Backup automático do localStorage do jogo (preferências + caças poke:hunts:*).
// O progresso em si é server-authoritative; isto protege hunts/preferências.
const BACKUP_DIR = path.join(app.getPath('userData'), 'backups');
const BACKUP_INTERVAL_MS = 10 * 60 * 1000; // a cada 10 minutos
const MAX_BACKUPS = 30; // mantém os 30 mais recentes (~5h de histórico)

// Chaves sensíveis que NÃO devem ir para os arquivos de backup (tokens de login).
// A chave real usada pelo jogo é 'pokeweb:tokens' (confirmado jul/2026). Antes
// aqui havia 'accessToken'/'refreshToken', que NÃO existem — ou seja, o token de
// login estava vazando para os arquivos de backup em texto puro.
const SENSITIVE_KEYS = ['pokeweb:tokens', 'accessToken', 'refreshToken'];

// Trecho de URL que indica que a sessão caiu (o app vai para a tela de login).
const LOGIN_PATH = '/login';

// Passado pelo atalho de inicialização do Windows: abre já minimizado.
const START_MINIMIZED = process.argv.includes('--minimized');

// Agrupa a janela na barra de tarefas com ícone/nome próprios. Cada conta ganha
// um id distinto para virar um grupo separado na barra de tarefas.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.poke.idle' + (ACCOUNT > 1 ? '.conta' + ACCOUNT : ''));
}

// Impede que o Chromium reduza a prioridade / a taxa de frames de janelas
// que estão em segundo plano. Sem isso, o Windows "adormece" a janela do jogo
// quando ela não está em foco e o jogo idle para de progredir.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Garante uma única instância: se você clicar de novo no atalho, ele traz a
// janela já aberta para a frente em vez de abrir uma segunda cópia.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWin = null;
let splashWin = null; // tela de carregamento (fecha quando o jogo aparece)
let aboutWin = null; // janela "Sobre"
let tray = null;
let powerBlockerId = null;
let isQuitting = false; // vira true só quando o usuário escolhe "Sair" de verdade
let saveTimer = null;
let backupTimer = null;
let reloadTimer = null; // reconexão agendada (evita empilhar recarregamentos)
let loggedOut = false; // true quando o app está na tela de login
let miniMode = false; // true quando a janela está no "modo mini"
let preMiniBounds = null; // tamanho/posição antes de entrar no modo mini
let miniCssKey = null; // chave do CSS injetado que enxuga a HUD no modo mini
let startInMini = false; // true se a última sessão foi fechada no modo mini
let miniRestored = false; // garante que só restauramos o mini uma vez ao abrir
let connTimer = null; // poll do status de conexão do jogo
let connDown = false; // true quando já avisamos que a conexão caiu
let connMisses = 0; // leituras seguidas "desconectado" (evita alarme por blip)
let chatDotMissingWarned = false; // avisa 1x se o seletor do vigia sumir (layout mudou)
let lastCaptures = null; // último total de capturas lido do Hunt Analyzer do jogo
let trayIconOk = null; // ícone da bandeja: conectado (pontinho verde)
let trayIconBad = null; // ícone da bandeja: problema (pontinho vermelho)
let trayMenu = null; // menu da bandeja (guardado para sincronizar marcadores)

const CONN_POLL_MS = 20 * 1000; // frequência do vigia de conexão

// Preferências lembradas entre sessões (mudo, sempre-no-topo, zoom).
// `userscripts` guarda o liga/desliga de cada script da comunidade, por id.
// `userscriptsAuto` = baixar sozinho as versões novas desses scripts.
const settings = { muted: false, alwaysOnTop: false, zoom: 1, userscripts: {}, userscriptsAuto: true };

// ---------------------------------------------------------------------------
// Memória da janela: lembra tamanho/posição entre sessões.
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Só reaproveita a posição salva se ela ainda cair em algum monitor conectado
// (evita a janela "sumir" fora da tela se você desconectou um monitor).
function boundsOnScreen(b) {
  if (typeof b.x !== 'number' || typeof b.y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      b.x < a.x + a.width &&
      b.x + b.width > a.x &&
      b.y < a.y + a.height &&
      b.y + b.height > a.y
    );
  });
}

function saveWindowState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const state = { isMaximized: mainWin.isMaximized() };
  // Se está no modo mini, salva as bounds "de verdade" (pré-mini), não as do
  // quadradinho — assim, ao reabrir, a janela normal volta ao tamanho certo.
  const b = miniMode && preMiniBounds ? preMiniBounds : mainWin.getNormalBounds();
  Object.assign(state, b);
  // Preferências lembradas (usa os valores "de intenção", não o estado transitório
  // do modo mini, que muda zoom/always-on-top temporariamente).
  state.muted = settings.muted;
  state.alwaysOnTop = settings.alwaysOnTop;
  state.zoom = settings.zoom;
  // Um campo por script (`piwqol`, `justpokedex`), no mesmo formato de antes.
  for (const us of USERSCRIPTS) state[us.id] = settings.userscripts[us.id];
  state.userscriptsAuto = settings.userscriptsAuto;
  state.mini = miniMode; // lembra se estava no modo mini
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    /* disco cheio / sem permissão: apenas ignora */
  }
}

// Carrega as preferências salvas para o objeto `settings`.
function loadSettings() {
  const s = loadWindowState();
  settings.muted = !!s.muted;
  settings.alwaysOnTop = !!s.alwaysOnTop;
  settings.zoom = typeof s.zoom === 'number' && s.zoom > 0 ? s.zoom : 1;
  // Nunca ligado antes (primeira vez que roda esta versão): entra ligado.
  for (const us of USERSCRIPTS) {
    settings.userscripts[us.id] = typeof s[us.id] === 'boolean' ? s[us.id] : true;
  }
  settings.userscriptsAuto = typeof s.userscriptsAuto === 'boolean' ? s.userscriptsAuto : true;
  startInMini = !!s.mini;
}

// Ajusta o zoom (com limites), aplica na janela e agenda gravação da preferência.
function setZoom(z) {
  settings.zoom = Math.min(3, Math.max(0.3, z));
  if (mainWin && !mainWin.isDestroyed() && !miniMode) {
    mainWin.webContents.setZoomFactor(settings.zoom);
  }
  scheduleSave();
}
function changeZoom(delta) {
  setZoom((settings.zoom || 1) + delta);
}

// Evita gravar em disco a cada pixel: agrupa em 500ms.
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowState, 500);
}

// Reagenda um recarregamento do jogo, cancelando qualquer um pendente. Assim,
// se vários eventos de falha dispararem juntos, só um reload acontece.
function scheduleReload(delay) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(GAME_URL);
  }, delay);
}

// ---------------------------------------------------------------------------
// Backup automático do localStorage (preferências + caças poke:hunts:*). O
// progresso vivo é server-authoritative, então isto NÃO é o "save" do jogo —
// serve para não perder a configuração de hunts/preferências ao limpar cache
// ou trocar de PC. Copia para arquivos datados em userData/backups, mantendo
// só os mais recentes.
// ---------------------------------------------------------------------------
// Roda uma LEITURA na página num "mundo isolado": vê o mesmo DOM e o mesmo
// localStorage do jogo, mas num JavaScript separado do dele. Assim o jogo não
// tem como perceber a leitura (ex.: se ele trocasse o document.querySelector
// por uma versão espiã, a nossa chamada não passaria por ela). O mundo 999 é o
// do preload (contextIsolation); 1000 é só nosso.
const MUNDO_LEITURA = 1000;
function lerNaPagina(code) {
  return mainWin.webContents.executeJavaScriptInIsolatedWorld(MUNDO_LEITURA, [{ code }]);
}

async function backupSave() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    const drop = JSON.stringify(SENSITIVE_KEYS);
    const json = await lerNaPagina(
      'JSON.stringify(Object.fromEntries(Object.entries(localStorage)' +
        '.filter(([k]) => !' +
        drop +
        '.includes(k))))'
    );
    // Nada salvo ainda (ex.: não logou) — não gera arquivo vazio.
    if (!json || json === '{}') return;

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_DIR, `save-${stamp}.json`), json);

    // Poda: mantém apenas os MAX_BACKUPS mais recentes.
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('save-') && f.endsWith('.json'))
      .sort();
    for (const old of files.slice(0, -MAX_BACKUPS)) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, old));
      } catch {
        /* ignora */
      }
    }
  } catch {
    /* página não pronta / sem localStorage: tenta de novo no próximo ciclo */
  }
}

// ---------------------------------------------------------------------------
// Limpeza de cache. Útil quando o jogo trava/fica em branco ao carregar por
// causa de arquivos antigos em cache ou um service worker quebrado.
//
// IMPORTANTE: o progresso do jogo é server-authoritative (fica na conta, no
// servidor). O localStorage guarda só preferências de tela, a configuração de
// caças (poke:hunts:*) e os tokens de login. Por isso a limpeza NUNCA apaga o
// localStorage (para manter hunts + login) e, por garantia, faz um backup do
// localStorage ANTES de mexer em qualquer coisa. Duas modalidades:
//   - 'cache'  : só cache HTTP + service workers + cache storage. Mantém hunts
//                E login. É o que resolve 99% dos travamentos de carregamento.
//   - 'full'   : o acima + cookies (desloga). Mantém hunts/preferências; você
//                só precisa logar de novo. Útil quando o login está "bugado".
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Limpeza automática de cache.
// O cache HTTP do jogo cresce com o tempo (medido: ~210 MB numa conta; com 4
// contas seriam ~800 MB, já que cada uma tem pasta própria). Aqui só medimos o
// cache HTTP e limpamos se passar do limite. É a limpeza mais leve possível:
// NÃO mexe em cookies, localStorage, service workers, login nem hunts — no pior
// caso o jogo só rebaixa alguns assets. Silencioso, sem recarregar a página.
// ---------------------------------------------------------------------------
const CACHE_LIMIT_BYTES = 250 * 1024 * 1024; // 250 MB
const CACHE_CHECK_MS = 6 * 60 * 60 * 1000; // a cada 6h

async function autoTrimCache() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    const ses = mainWin.webContents.session;
    const size = await ses.getCacheSize();
    if (size > CACHE_LIMIT_BYTES) {
      await ses.clearCache();
      console.log(
        '[Poke Idle] Cache automático: limpo (estava com ' +
          (size / 1048576).toFixed(0) +
          ' MB, limite ' +
          (CACHE_LIMIT_BYTES / 1048576).toFixed(0) +
          ' MB).'
      );
    }
  } catch (e) {
    console.warn('[Poke Idle] Falha na limpeza automática de cache:', e && e.message);
  }
}

async function clearCache(mode = 'cache') {
  if (!mainWin || mainWin.isDestroyed()) return;

  const full = mode === 'full';
  const detail = full
    ? 'Vai limpar o cache, os service workers E os cookies (você vai precisar ' +
      'logar de novo).\n\nSuas caças (hunts) e preferências são preservadas e um ' +
      'backup é feito antes. A janela recarrega em seguida.'
    : 'Vai limpar o cache e os service workers do jogo.\n\nSuas caças (hunts) e o ' +
      'login são preservados e um backup é feito antes. A janela recarrega em seguida.';

  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'question',
    buttons: ['Limpar e recarregar', 'Cancelar'],
    defaultId: 0,
    cancelId: 1,
    title: 'Limpar cache',
    message: full ? 'Limpar cache e sair do login?' : 'Limpar cache do jogo?',
    detail,
    icon: ICON_PATH,
  });
  if (response !== 0) return;

  // Backup de segurança antes de tocar em qualquer armazenamento.
  await backupSave();

  const ses = mainWin.webContents.session;
  // Tudo, menos localstorage (hunts/preferências/login) — cookies só no 'full'.
  const storages = ['cachestorage', 'serviceworkers', 'shadercache'];
  if (full) storages.push('cookies');

  try {
    await ses.clearCache();
    await ses.clearStorageData({ storages });
  } catch {
    /* segue para recarregar mesmo assim */
  }

  if (mainWin && !mainWin.isDestroyed()) mainWin.reload();
}

// ---------------------------------------------------------------------------
// Mostrar / esconder (usado pela bandeja e pelo atalho global).
// ---------------------------------------------------------------------------
function showWindow() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function toggleWindow() {
  if (!mainWin) return;
  if (mainWin.isVisible() && !mainWin.isMinimized()) {
    mainWin.hide();
  } else {
    showWindow();
  }
}

// ---------------------------------------------------------------------------
// Alerta de desconexão / logout.
// Quando a sessão do jogo cai, o app navega para a tela de login (/login). Como
// a janela costuma ficar minimizada/escondida num idle, avisamos com uma
// notificação do Windows (clicável) e mudamos o tooltip da bandeja — assim você
// não fica horas achando que está progredindo enquanto na verdade deslogou.
// ---------------------------------------------------------------------------
function handleNavigation(url) {
  const onLogin = typeof url === 'string' && url.includes(LOGIN_PATH);
  if (onLogin && !loggedOut) {
    loggedOut = true;
    updateTrayStatus();
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'Poke Idle — você foi desconectado',
          body: 'A sessão caiu (tela de login). Clique para voltar e entrar de novo.',
          icon: ICON_PATH,
        });
        n.on('click', showWindow);
        n.show();
      }
    } catch {
      /* notificações indisponíveis: ignora */
    }
  } else if (!onLogin && loggedOut) {
    // Voltou para o jogo: limpa o estado de "desconectado".
    loggedOut = false;
    updateTrayStatus();
  }
}

// ---------------------------------------------------------------------------
// CSS injetado no modo mini. O jogo já tem um painel de estatísticas ótimo
// ("📊 Hunt Analyzer", div.ha-window: XP/h, $/h, derrotados, saldo), então no
// espaço pequeno priorizamos ELE: escondemos o resto da HUD, cortamos as partes
// longas do painel (lista de drops e rodapé) e o encostamos no canto superior
// esquerdo. Se você fechar o painel pelo × do jogo, o mini mostra só o mapa.
// Totalmente reversível (removido ao sair do mini). Seletores mapeados jul/2026.
// ---------------------------------------------------------------------------
const MINI_HIDE_CSS = [
  // Fora do caminho no modo mini.
  [
    'nav.game-dock',
    'div.chat-box',
    'button.chat-fab', // o chat virou um botão flutuante quando recolhido
    'div.ah-panel',
    'button.market-cta',
    'div.field-hud',
    'div.phud',
    'div.cap-panel',
  ].join(',') + '{display:none !important;}',
  // Enxuga o Hunt Analyzer: sem a lista de drops nem o rodapé.
  [
    '.ha-window .ha-drops',
    '.ha-window .ha-drops-head',
    '.ha-window .ha-clog-btn',
    '.ha-window .ha-note',
  ].join(',') + '{display:none !important;}',
  // Encosta o painel no canto e deixa a altura acompanhar o conteúdo.
  '.ha-window{top:6px !important;left:6px !important;right:auto !important;' +
    'bottom:auto !important;height:auto !important;max-height:none !important;}',
].join('\n');

async function applyMiniHudCss() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    miniCssKey = await mainWin.webContents.insertCSS(MINI_HIDE_CSS);
  } catch (e) {
    console.warn('[Poke Idle] Falha ao aplicar o CSS do modo mini:', e && e.message);
  }
}

async function clearMiniHudCss() {
  const wc = mainWin && !mainWin.isDestroyed() ? mainWin.webContents : null;
  if (wc && miniCssKey) {
    try {
      await wc.removeInsertedCSS(miniCssKey);
    } catch (_) {
      /* ignora */
    }
  }
  miniCssKey = null;
}

// ---------------------------------------------------------------------------
// Modo mini: encolhe a janela num quadradinho sempre-no-topo, no canto da tela,
// para acompanhar o jogo enquanto você faz outra coisa. Alternar de novo volta
// ao tamanho/posição e zoom anteriores.
// ---------------------------------------------------------------------------
function toggleMiniMode() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const wc = mainWin.webContents;

  if (!miniMode) {
    preMiniBounds = mainWin.getBounds();
    if (mainWin.isMaximized()) mainWin.unmaximize();

    const area = screen.getDisplayMatching(mainWin.getBounds()).workArea;
    const w = 480;
    const h = 340;
    const margin = 12;
    mainWin.setMinimumSize(280, 200);
    mainWin.setAlwaysOnTop(true);
    mainWin.setBounds({
      x: area.x + area.width - w - margin,
      y: area.y + area.height - h - margin,
      width: w,
      height: h,
    });
    wc.setZoomFactor(0.6); // cabe mais coisa no espaço pequeno
    showWindow();
    mainWin.setOpacity(0.92); // levemente transparente, discreto sobre outras janelas
    miniMode = true;
    applyMiniHudCss(); // enxuga a HUD (esconde barra/chat/auto-helper)
  } else {
    // Restaura as preferências (não o estado transitório do modo mini).
    clearMiniHudCss(); // devolve a HUD completa
    mainWin.setOpacity(1);
    mainWin.setAlwaysOnTop(settings.alwaysOnTop);
    wc.setZoomFactor(settings.zoom || 1);
    if (preMiniBounds) mainWin.setBounds(preMiniBounds);
    miniMode = false;
  }
}

// ---------------------------------------------------------------------------
// Vigia de conexão do jogo.
// Dentro do jogo há um "pontinho" de status do chat (span.chat-dot): tem a
// classe 'on' quando conectado. Se a conexão (websocket) cair, a página
// continua aberta mas o jogo para de receber dados — o idle "trava" em silêncio,
// sem ir para /login. Aqui lemos esse pontinho de tempos em tempos e avisamos.
// Só leitura de DOM; não interage com o jogo.
// ---------------------------------------------------------------------------
function notifyConnection(reconnected) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification(
      reconnected
        ? {
            title: 'Poke Idle — reconectado',
            body: 'A conexão do jogo voltou.',
            icon: ICON_PATH,
          }
        : {
            title: 'Poke Idle — conexão caiu',
            body: 'O jogo perdeu a conexão (o progresso idle pode ter parado). Clique para abrir.',
            icon: ICON_PATH,
          }
    );
    if (!reconnected) n.on('click', showWindow);
    n.show();
  } catch {
    /* notificações indisponíveis: ignora */
  }
}

// ---------------------------------------------------------------------------
// Aviso de captura.
// O jogo tem um painel próprio ("📊 Hunt Analyzer") com um contador de
// capturados. Aqui só LEMOS esse número: quando ele sobe, avisamos — útil com o
// app rodando escondido. O contador zera ao trocar de hunt; nesse caso apenas
// reajustamos a referência (sem avisar).
// ---------------------------------------------------------------------------
function notifyCapture(delta, total) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'Poke Idle' + ACCOUNT_SUFFIX + ' — captura!',
      body:
        (delta === 1 ? 'Você capturou um Pokémon!' : 'Você capturou ' + delta + ' Pokémon!') +
        ' (total da sessão: ' + total + ')',
      icon: ICON_PATH,
    });
    n.on('click', showWindow);
    n.show();
  } catch {
    /* notificações indisponíveis: ignora */
  }
}

function checkCaptures(raw) {
  // Painel fechado / fora do jogo: esquece a referência para não avisar errado.
  if (raw === null || raw === undefined || raw === '') {
    lastCaptures = null;
    return;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return;
  if (lastCaptures === null) {
    lastCaptures = n; // primeira leitura: só serve de referência
    return;
  }
  if (n > lastCaptures) notifyCapture(n - lastCaptures, n);
  lastCaptures = n; // também cobre o reset (n < lastCaptures) ao trocar de hunt
}

async function pollConnection() {
  if (!mainWin || mainWin.isDestroyed()) return;
  let state = null;
  try {
    // Uma leitura só para as duas coisas: o pontinho de conexão e o contador de
    // capturas do Hunt Analyzer (evita dois eval por ciclo).
    state = await lerNaPagina(
      "(()=>{const d=document.querySelector('.chat-dot');" +
        "const c=document.querySelector('.ha-card.ha-catch b');" +
        "return {on: d ? d.classList.contains('on') : null," +
        " cap: c ? c.textContent.replace(/[^0-9]/g,'') : null};})()"
    );
  } catch {
    return; // página não pronta: tenta no próximo ciclo
  }
  if (!state) return;

  checkCaptures(state.cap);

  // Fora do jogo (login/landing não têm o pontinho): não é queda, apenas ignora.
  if (state.on === null) {
    connMisses = 0;
    // Se estamos no jogo (não deslogado) e mesmo assim o pontinho não existe, o
    // layout do jogo provavelmente mudou — avisa uma vez para facilitar o ajuste.
    if (!loggedOut && !chatDotMissingWarned) {
      chatDotMissingWarned = true;
      console.warn(
        '[Poke Idle] .chat-dot não encontrado com o jogo aberto — o layout do ' +
          'jogo pode ter mudado; o vigia de conexão pode precisar de ajuste.'
      );
    }
    return;
  }
  chatDotMissingWarned = false; // achou o pontinho: reseta o aviso

  if (!state.on) {
    connMisses++;
    // Exige 2 leituras seguidas para não alarmar por um blip momentâneo.
    if (connMisses >= 2 && !connDown) {
      connDown = true;
      updateTrayStatus();
      notifyConnection(false);
    }
  } else {
    if (connDown) {
      connDown = false;
      updateTrayStatus();
      notifyConnection(true);
    }
    connMisses = 0;
  }
}

// Tela de carregamento: janelinha sem moldura com a Pokébola, mostrada enquanto
// o jogo carrega. Fecha quando a janela principal está pronta (ou por segurança
// após um tempo, para nunca ficar presa).
function createSplash() {
  splashWin = new BrowserWindow({
    width: 400,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    icon: ICON_PATH,
    webPreferences: {},
  });
  splashWin.loadFile(path.join(__dirname, 'splash.html'));
  splashWin.once('ready-to-show', () => {
    if (splashWin && !splashWin.isDestroyed()) splashWin.show();
  });
  // Segurança: se algo travar no carregamento, não deixa a splash eterna.
  setTimeout(closeSplash, 30000);
}

function closeSplash() {
  if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  splashWin = null;
}

// Janela "Sobre": versão, novidades e atalhos, no estilo do app.
function createAboutWindow() {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 440,
    height: 580,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Sobre o Poke Idle',
    backgroundColor: '#15161b',
    icon: ICON_PATH,
    parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined,
    show: false,
    webPreferences: {},
  });
  aboutWin.loadFile(path.join(__dirname, 'about.html'), { query: { v: app.getVersion() } });
  aboutWin.once('ready-to-show', () => aboutWin.show());
  aboutWin.on('closed', () => {
    aboutWin = null;
  });
}

// ---------------------------------------------------------------------------
// Userscripts da comunidade: PIW-QOL e JustPokédex.
//
// São os mesmos scripts que se usam no Tampermonkey:
//   - PIW-QOL (Desjunior/JulianoCLI): lista de hunts no lugar do mapa, lojas e
//     depósito portáteis, analisador de hunt, filtros na Pokédex;
//   - JustPokédex (guilherme-se): leitor de Pokémon com cálculo de IV,
//     mercado global portátil, detector/contador de shiny, lembrete do
//     presente diário (abre/fecha no jogo com Alt+P).
// Os dois declaram `@grant none`, então são JavaScript comum e rodam direto —
// quem os coloca dentro da página é o `preload-userscripts.js`. A lista (URL,
// arquivo, ordem de injeção) fica no `update-userscript.js`.
//
// De onde vem cada arquivo, em ordem de preferência:
//   1. pasta de dados do usuário — onde o "Atualizar ..." grava;
//   2. pasta do app — a cópia que vem junto na instalação.
// Essa ordem existe porque, no app instalado, a pasta do programa fica dentro
// do app.asar (somente leitura): sem ela, atualizar um script exigiria
// publicar uma versão nova do Poke Idle inteiro.
// ---------------------------------------------------------------------------
const USERSCRIPT_PASTA_APP = path.join(__dirname, 'userscripts');
const USERSCRIPT_PASTA_USUARIO = path.join(app.getPath('userData'), 'userscripts');

const userscriptCache = {}; // código já lido do disco, por id (evita reler a cada navegação)

function userscriptSpec(id) {
  return USERSCRIPTS.find((s) => s.id === id);
}

// Compara versões "10.1.1" x "10.2" (número a número). >0 = a é mais nova.
function compararVersao(a, b) {
  const pa = String(a || '0').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Caminho do arquivo que vale agora, ou null se não houver nenhum.
// Normalmente é a cópia da pasta do usuário (a que o atualizador mantém). Mas
// se um Poke Idle novo trouxer no instalador uma versão MAIOR do que a baixada
// (ex.: atualização automática desligada), vale a do instalador — senão uma
// cópia velha na pasta do usuário ganharia para sempre.
function userscriptCaminho(id) {
  const s = userscriptSpec(id);
  const doUsuario = path.join(USERSCRIPT_PASTA_USUARIO, s.arquivo);
  const doApp = path.join(USERSCRIPT_PASTA_APP, s.arquivo);
  const temUsuario = fs.existsSync(doUsuario);
  const temApp = fs.existsSync(doApp);
  if (temUsuario && temApp) {
    return compararVersao(versaoDoArquivo(doApp), versaoDoArquivo(doUsuario)) > 0 ? doApp : doUsuario;
  }
  return temUsuario ? doUsuario : temApp ? doApp : null;
}

// Versão declarada no cabeçalho do script (para mostrar no menu e nos avisos).
function userscriptVersao(id) {
  return versaoDoArquivo(userscriptCaminho(id));
}

function versaoDoArquivo(p) {
  if (!p) return null;
  let fd = null;
  try {
    // O cabeçalho está nas primeiras linhas: lê só o começo, não o arquivo todo.
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(2048);
    const lidos = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = buf.toString('utf8', 0, lidos).match(/@version\s+([0-9][\w.\-]*)/);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nada a fazer */
      }
    }
  }
}

function userscriptCodigo(id) {
  if (userscriptCache[id]) return userscriptCache[id];
  const s = userscriptSpec(id);
  const p = userscriptCaminho(id);
  if (!p) {
    console.warn('[Poke Idle] ' + s.nome + ' ligado, mas o arquivo não foi encontrado.');
    return null;
  }
  try {
    userscriptCache[id] = fs.readFileSync(p, 'utf8');
    return userscriptCache[id];
  } catch (e) {
    console.warn('[Poke Idle] Falha ao ler o ' + s.nome + ':', e && e.message);
    return null;
  }
}

// O preload pede os códigos aqui, de forma síncrona, no início de cada
// carregamento da página. Só vão os que estão ligados, na ordem da lista; se
// todos estiverem desligados, a página carrega limpa, sem nada injetado.
ipcMain.on('userscripts:get-codes', (e) => {
  const entregues = [];
  for (const s of USERSCRIPTS) {
    if (!settings.userscripts[s.id]) {
      console.log('[Poke Idle] ' + s.nome + ': desligado');
      continue;
    }
    const code = userscriptCodigo(s.id);
    if (!code) continue; // o aviso já saiu em userscriptCodigo()
    console.log(
      '[Poke Idle] ' + s.nome + ': entregue (versão ' + userscriptVersao(s.id) + ', ' +
        (code.length / 1024).toFixed(0) + ' KB)'
    );
    entregues.push({ nome: s.nome, code });
  }
  e.returnValue = entregues;
});

// Rótulo do item de menu que volta à versão anterior (só aparece ativo se houver
// uma guardada — o atualizador guarda a que estava em uso a cada troca).
function userscriptTemAnterior(id) {
  return fs.existsSync(path.join(USERSCRIPT_PASTA_USUARIO, userscriptSpec(id).arquivo + '.anterior'));
}

function userscriptRotuloVersao(id) {
  const v = userscriptVersao(id);
  return userscriptSpec(id).nome + (v ? ' ' + v : '');
}

// Deixa os menus coerentes com o estado real — o liga/desliga também pode vir
// da bandeja, e a versão muda sozinha com a atualização automática.
function sincronizarMenuUserscripts() {
  const menu = Menu.getApplicationMenu();
  if (menu) {
    for (const s of USERSCRIPTS) {
      const item = menu.getMenuItemById(s.id + '-toggle');
      if (item) item.checked = settings.userscripts[s.id];
      const versao = menu.getMenuItemById(s.id + '-versao');
      if (versao) versao.label = userscriptRotuloVersao(s.id);
      const voltar = menu.getMenuItemById(s.id + '-voltar');
      if (voltar) voltar.enabled = userscriptTemAnterior(s.id);
    }
    const auto = menu.getMenuItemById('userscripts-auto');
    if (auto) auto.checked = settings.userscriptsAuto;
  }
  // A bandeja tem os mesmos marcadores: precisa acompanhar. No Windows o menu
  // da bandeja só redesenha quando é reatribuído.
  if (tray && !tray.isDestroyed() && trayMenu) {
    for (const s of USERSCRIPTS) {
      const item = trayMenu.getMenuItemById(s.id + '-toggle');
      if (item) item.checked = settings.userscripts[s.id];
    }
    tray.setContextMenu(trayMenu);
  }
}

// Liga/desliga. O script só entra (ou sai) da página num carregamento novo,
// então recarrega o jogo em seguida.
function toggleUserscript(id) {
  settings.userscripts[id] = !settings.userscripts[id];
  sincronizarMenuUserscripts();
  scheduleSave();
  if (mainWin && !mainWin.isDestroyed()) mainWin.reload();
}

// Itens de liga/desliga de cada script, para o menu do app e o da bandeja.
function userscriptToggleItems(comAtalho) {
  return USERSCRIPTS.map((s) => ({
    id: s.id + '-toggle',
    label: s.rotulo,
    type: 'checkbox',
    checked: settings.userscripts[s.id],
    ...(comAtalho && s.atalho ? { accelerator: s.atalho } : {}),
    click: () => toggleUserscript(s.id),
  }));
}

// Submenu "Ferramentas → Scripts da comunidade".
function userscriptSubmenu() {
  return [
    ...userscriptToggleItems(true),
    { type: 'separator' },
    {
      id: 'userscripts-auto',
      label: 'Atualizar sozinho (confere a cada 6h)',
      type: 'checkbox',
      checked: settings.userscriptsAuto,
      click: (item) => {
        settings.userscriptsAuto = item.checked;
        scheduleSave();
        if (item.checked) autoAtualizarUserscripts();
      },
    },
    { label: 'Procurar atualizações agora', click: () => atualizarUserscriptsManual() },
    { type: 'separator' },
    // Só informativo: mostra qual versão está valendo.
    ...USERSCRIPTS.map((s) => ({ id: s.id + '-versao', label: userscriptRotuloVersao(s.id), enabled: false })),
    { type: 'separator' },
    ...USERSCRIPTS.map((s) => ({
      id: s.id + '-voltar',
      label: 'Voltar o ' + s.nome + ' para a versão anterior',
      enabled: userscriptTemAnterior(s.id),
      click: () => voltarUserscript(s.id),
    })),
  ];
}

function userscriptsDialog(type, message, detail, buttons) {
  return dialog.showMessageBox({
    type,
    title: 'Poke Idle — scripts da comunidade',
    message,
    detail,
    buttons: buttons || ['OK'],
    noLink: true,
    icon: ICON_PATH,
  });
}

function notificar(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON_PATH });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch {
    /* notificações indisponíveis: ignora */
  }
}

// Confere e instala as versões novas de todos os scripts. Nunca joga erro:
// devolve um resultado por script ({ s, r } ou { s, erro }).
async function checarUserscripts() {
  const resultados = [];
  for (const s of USERSCRIPTS) {
    try {
      const r = await baixarUserscript(USERSCRIPT_PASTA_USUARIO, s.id, userscriptCaminho(s.id));
      if (r.novidade && !r.segurado) delete userscriptCache[s.id]; // relê no próximo carregamento
      resultados.push({ s, r });
    } catch (e) {
      resultados.push({ s, erro: (e && e.message) || 'erro desconhecido' });
    }
  }
  sincronizarMenuUserscripts();
  return resultados;
}

function recarregarJogo() {
  showWindow();
  if (mainWin && !mainWin.isDestroyed()) mainWin.reload();
}

// Versões seguradas já avisadas (por hash), para não repetir o aviso a cada 6h.
const seguradosAvisados = new Set();
let checagemAutoRodando = false;

// Checagem automática: silenciosa se não houver nada (ou se estiver sem
// internet). NÃO recarrega o jogo sozinha — isso interromperia a hunt; a
// versão nova entra no próximo carregamento, e a notificação oferece recarregar.
async function autoAtualizarUserscripts() {
  if (!settings.userscriptsAuto || checagemAutoRodando) return;
  checagemAutoRodando = true;
  try {
    const resultados = await checarUserscripts();
    const instalados = resultados.filter((x) => x.r && x.r.novidade && !x.r.segurado);
    if (instalados.length) {
      const nomes = instalados.map((x) => x.s.nome + ' ' + x.r.versao).join(' e ');
      console.log('[Poke Idle] Scripts atualizados: ' + nomes);
      notificar(
        'Poke Idle — scripts atualizados',
        nomes + '. Entram na próxima vez que o jogo recarregar. Clique para recarregar agora.',
        recarregarJogo
      );
    }
    for (const { s, r } of resultados) {
      if (!r || !r.segurado || seguradosAvisados.has(r.hash)) continue;
      seguradosAvisados.add(r.hash);
      console.warn('[Poke Idle] Atualização do ' + s.nome + ' SEGURADA: ' + r.segurado.join('; '));
      notificar(
        'Poke Idle — atualização do ' + s.nome + ' segurada',
        'A versão nova mudou de um jeito suspeito e NÃO foi instalada. Você segue na versão atual. Clique para ver o motivo.',
        () => userscriptsDialog('warning', 'Atualização do ' + s.nome + ' segurada', motivoSegurado(s, r))
      );
    }
  } finally {
    checagemAutoRodando = false;
  }
}

function motivoSegurado(s, r) {
  return (
    'A versão ' + r.versao + ' publicada pelo autor ' +
    r.segurado.join('; ') +
    '.\n\nPode ser uma mudança legítima, mas é também o que aconteceria se a conta ' +
    'do autor fosse invadida para roubar sessões do jogo. Por segurança ela não ' +
    'foi instalada — você continua na versão que já estava usando.\n\n' +
    'Peça para revisar o código novo antes de liberar (' + s.repo + ').'
  );
}

// "Procurar atualizações agora": mesmo processo, mas sempre mostra o resultado.
async function atualizarUserscriptsManual() {
  const resultados = await checarUserscripts();
  const linhas = [];
  let algumNovo = false;
  for (const { s, r, erro } of resultados) {
    if (erro) linhas.push(s.nome + ': não consegui verificar (' + erro + ').');
    else if (r.segurado) linhas.push(s.nome + ': versão nova SEGURADA.\n' + motivoSegurado(s, r));
    else if (r.novidade) {
      algumNovo = true;
      linhas.push(s.nome + ': atualizado para a ' + r.versao + (r.anterior ? ' (antes: ' + r.anterior + ')' : '') + '.');
    } else linhas.push(s.nome + ': já está na versão mais recente (' + r.versao + ').');
  }
  const { response } = await userscriptsDialog(
    resultados.some((x) => x.r && x.r.segurado) ? 'warning' : 'info',
    algumNovo ? 'Scripts atualizados' : 'Scripts da comunidade',
    linhas.join('\n\n') + (algumNovo ? '\n\nA versão nova entra quando o jogo recarregar.' : ''),
    algumNovo ? ['Recarregar agora', 'Depois'] : ['OK']
  );
  if (algumNovo && response === 0) recarregarJogo();
}

// Desfaz a última atualização de um script (se ela quebrou alguma coisa).
async function voltarUserscript(id) {
  const s = userscriptSpec(id);
  try {
    const versao = voltarVersaoAnterior(USERSCRIPT_PASTA_USUARIO, id);
    delete userscriptCache[id];
    // Sem isso a checagem automática reinstalaria a mesma versão em 6h.
    if (settings.userscriptsAuto) {
      settings.userscriptsAuto = false;
      scheduleSave();
    }
    sincronizarMenuUserscripts();
    const { response } = await userscriptsDialog(
      'info',
      s.nome + ' voltou para a versão ' + (versao || 'anterior'),
      'A atualização automática foi DESLIGADA para não reinstalar a versão nova ' +
        'sozinha. Religue em Ferramentas → Scripts da comunidade quando quiser.\n\n' +
        'A troca entra quando o jogo recarregar.',
      ['Recarregar agora', 'Depois']
    );
    if (response === 0) recarregarJogo();
  } catch (e) {
    userscriptsDialog('error', 'Não consegui voltar o ' + s.nome, 'Motivo: ' + ((e && e.message) || 'erro desconhecido'));
  }
}

function createWindow() {
  const state = loadWindowState();
  const opts = {
    width: state.width || 1280,
    height: state.height || 860,
    title: 'Poke Idle' + ACCOUNT_SUFFIX,
    icon: ICON_PATH,
    backgroundColor: '#1b1b2f',
    autoHideMenuBar: true,
    show: false, // só exibe no ready-to-show (evita tela branca)
    webPreferences: {
      // A chave de tudo: não deixa o Chromium desacelerar os timers da página
      // quando a janela está minimizada / atrás de outras janelas.
      backgroundThrottling: false,
      // Coloca os userscripts (PIW-QOL, JustPokédex) na página antes dos scripts do jogo. O preload só usa
      // o `ipcRenderer`, então o isolamento de contexto e o sandbox continuam
      // nos padrões seguros do Electron.
      preload: path.join(__dirname, 'preload-userscripts.js'),
    },
  };
  if (boundsOnScreen(state)) {
    opts.x = state.x;
    opts.y = state.y;
  }

  mainWin = new BrowserWindow(opts);
  // Aplica preferências lembradas (mudo e sempre-no-topo persistem no reload;
  // o zoom é reaplicado a cada carregamento, mais abaixo).
  mainWin.setAlwaysOnTop(settings.alwaysOnTop);
  mainWin.webContents.setAudioMuted(settings.muted);
  mainWin.loadURL(GAME_URL);

  mainWin.once('ready-to-show', () => {
    closeSplash(); // o jogo está pronto: tira a tela de carregamento
    if (state.isMaximized) mainWin.maximize();
    if (START_MINIMIZED) {
      mainWin.minimize();
    } else {
      mainWin.show();
    }
  });

  // Lembra tamanho/posição conforme você mexe na janela.
  mainWin.on('resize', scheduleSave);
  mainWin.on('move', scheduleSave);
  mainWin.on('maximize', scheduleSave);
  mainWin.on('unmaximize', scheduleSave);

  // Fechar (X) apenas esconde na bandeja — o jogo continua rodando.
  // Só encerra de verdade quando o usuário escolhe "Sair".
  mainWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      saveWindowState();
      backupSave();
      mainWin.hide();
    }
  });

  // Reconexão automática: se a página falhar ao carregar (queda de internet,
  // servidor fora do ar) ou o processo da página morrer, recarrega sozinho.
  // Um único timer por vez: vários eventos de falha não empilham reloads.
  mainWin.webContents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
    // -3 = ERR_ABORTED (navegação cancelada normalmente); ignora.
    if (isMainFrame && errorCode !== -3) scheduleReload(5000);
  });
  mainWin.webContents.on('render-process-gone', () => scheduleReload(2000));

  // Faz um backup logo após cada carregamento (dá um tempo pro jogo popular o
  // localStorage antes de copiar). Também reaplica mudo e zoom (o zoom volta ao
  // padrão a cada navegação, então precisa ser re-setado aqui).
  mainWin.webContents.on('did-finish-load', () => {
    mainWin.webContents.setAudioMuted(settings.muted);
    if (!miniMode) mainWin.webContents.setZoomFactor(settings.zoom);
    // Recarregar (ex.: reconexão) descarta o CSS injetado; reaplica se estiver no mini.
    if (miniMode) {
      miniCssKey = null;
      applyMiniHudCss();
    }
    // Se a última sessão foi fechada no modo mini, restaura o mini (uma vez).
    if (startInMini && !miniRestored) {
      miniRestored = true;
      setTimeout(() => {
        if (mainWin && !mainWin.isDestroyed() && !miniMode) toggleMiniMode();
      }, 1500);
    }
    setTimeout(backupSave, 8000);
  });

  // Zoom por Ctrl+scroll: persiste a preferência (ignora enquanto no modo mini).
  mainWin.webContents.on('zoom-changed', () => {
    if (miniMode) return;
    setTimeout(() => {
      if (mainWin && !mainWin.isDestroyed()) {
        settings.zoom = mainWin.webContents.getZoomFactor();
        scheduleSave();
      }
    }, 50);
  });

  // Detecta ida/volta da tela de login (para o alerta de desconexão). O jogo é
  // uma SPA, então tanto navegação normal quanto de rota (in-page) importam.
  mainWin.webContents.on('did-navigate', (_e, url) => handleNavigation(url));
  mainWin.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) handleNavigation(url);
  });

  // Abre links externos (ex.: Discord do jogo) no navegador padrão, em vez de
  // dentro da janela do jogo.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes('idleworld.online')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Segurança: mantém a NAVEGAÇÃO da janela principal presa ao domínio do jogo.
  // Se o site (ou um comprometimento dele/redirect) tentar levar a janela para
  // fora, cancela e abre no navegador externo — evita a janela do app virar uma
  // página de phishing com o ícone/nome "Poke Idle".
  mainWin.webContents.on('will-navigate', (e, url) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      e.preventDefault();
      return;
    }
    const host = u.hostname;
    const allowed = host === 'poke.idleworld.online' || host.endsWith('.idleworld.online');
    if (!allowed) {
      e.preventDefault();
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
    }
  });

  // Segurança: nega pedidos de permissão do navegador (câmera, microfone,
  // geolocalização, notificação do site, etc.). O app não usa nada disso — as
  // notificações são geradas pelo processo principal (API do Electron).
  mainWin.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => {
    callback(false);
  });

  mainWin.on('closed', () => {
    clearTimeout(reloadTimer);
    mainWin = null;
  });
}

// Gera o ícone da bandeja com um pontinho de status sobreposto no canto inferior
// direito da pokébola. `dotBGR` é a cor no formato do bitmap (BGR).
function makeTrayIcon(dotBGR) {
  const base = nativeImage.createFromPath(PNG_ICON_PATH);
  if (base.isEmpty()) return nativeImage.createFromPath(ICON_PATH);
  const { width, height } = base.getSize();
  const buf = base.toBitmap(); // BGRA
  const r = Math.max(3, Math.round(width * 0.24));
  const cx = width - r - Math.round(width * 0.06);
  const cy = height - r - Math.round(height * 0.06);
  const [b, g, rr] = dotBGR;
  for (let y = cy - r - 1; y <= cy + r + 1; y++) {
    for (let x = cx - r - 1; x <= cx + r + 1; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * width + x) * 4;
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = rr;
        buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width, height });
}

// Reflete o estado (conexão/login) no ícone e no tooltip da bandeja.
function updateTrayStatus() {
  if (!tray) return;
  const problem = loggedOut || connDown;
  if (trayIconOk && trayIconBad) tray.setImage(problem ? trayIconBad : trayIconOk);
  tray.setToolTip(
    'Poke Idle' +
      ACCOUNT_SUFFIX +
      (loggedOut
        ? ' — DESCONECTADO (faça login)'
        : connDown
          ? ' — conexão caiu (reconectando…)'
          : ' — o jogo continua rodando em segundo plano')
  );
}

// Ícone na bandeja (ao lado do relógio), com menu de contexto.
function createTray() {
  trayIconOk = makeTrayIcon([40, 180, 40]); // verde (BGR)
  trayIconBad = makeTrayIcon([40, 40, 220]); // vermelho (BGR)
  tray = new Tray(trayIconOk);
  tray.setToolTip('Poke Idle' + ACCOUNT_SUFFIX + ' — o jogo continua rodando em segundo plano');
  trayMenu = Menu.buildFromTemplate([
    { label: 'Mostrar / Esconder', click: toggleWindow },
    { label: 'Modo mini (canto da tela)', click: toggleMiniMode },
    ...userscriptToggleItems(false),
    { label: 'Recarregar jogo', click: () => mainWin && mainWin.reload() },
    { label: 'Limpar cache e recarregar', click: () => clearCache('cache') },
    {
      label: 'Ferramentas de desenvolvedor',
      click: () => {
        if (!mainWin) return;
        showWindow();
        mainWin.webContents.openDevTools({ mode: 'right' });
      },
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', toggleWindow); // clique simples mostra/esconde
}

// Segurança extra: enquanto o app estiver aberto, impede o Windows de entrar em
// suspensão. Assim o jogo continua avançando mesmo se você sair do computador.
function startPowerBlocker() {
  if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
}

// ---------------------------------------------------------------------------
// Auto-atualização com feedback ao usuário.
// O app instalado verifica ao abrir e a cada 6h. Quando o usuário pede na mão
// (menu Ferramentas → Verificar atualizações), mostramos diálogos com o
// resultado — antes isso era silencioso e dava a impressão de "não fez nada".
// ---------------------------------------------------------------------------
let manualUpdateCheck = false; // true quando o usuário pediu a verificação
let updateHandlersReady = false;

// Diálogo simples e independente da janela (funciona mesmo escondido na bandeja).
function updateDialog(type, message, detail, buttons) {
  return dialog.showMessageBox({
    type,
    title: 'Poke Idle — atualização',
    message,
    detail,
    buttons: buttons || ['OK'],
    noLink: true,
    icon: ICON_PATH,
  });
}

function setupAutoUpdater() {
  if (updateHandlersReady) return;
  updateHandlersReady = true;

  autoUpdater.on('update-not-available', () => {
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    updateDialog('info', 'Você já está na versão mais recente.',
      `Versão instalada: ${app.getVersion()}.`);
  });

  autoUpdater.on('update-available', (info) => {
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    updateDialog('info', 'Atualização encontrada!',
      `Baixando a versão ${info.version} em segundo plano. ` +
      'Você será avisado quando estiver pronta para instalar.');
  });

  autoUpdater.on('error', (err) => {
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    updateDialog('error', 'Não foi possível verificar atualizações.',
      String(err && err.message ? err.message : err));
  });

  // Vale tanto para verificação manual quanto automática: avisa e oferece
  // reiniciar para aplicar (a instalação acontece ao encerrar o app).
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await updateDialog('question',
      `Atualização ${info.version} pronta para instalar.`,
      'O app precisa reiniciar para aplicar. Deseja reiniciar agora?',
      ['Reiniciar agora', 'Mais tarde']);
    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });
}

function runUpdateCheck(manual) {
  if (!app.isPackaged) {
    if (manual) {
      updateDialog('info', 'Atualização indisponível no modo de desenvolvimento.',
        'A verificação de atualizações só funciona no app instalado.');
    }
    return;
  }
  setupAutoUpdater();
  manualUpdateCheck = manual;
  autoUpdater.checkForUpdates().catch((err) => {
    if (!manual) return;
    manualUpdateCheck = false;
    updateDialog('error', 'Não foi possível verificar atualizações.',
      String(err && err.message ? err.message : err));
  });
}

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(() => {
  loadSettings(); // carrega mudo/topo/zoom antes de montar o menu (para os checkboxes)

  const menu = Menu.buildFromTemplate([
    {
      label: 'Jogo',
      submenu: [
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Tela cheia', accelerator: 'F11', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+=', click: () => changeZoom(0.1) },
        { label: 'Diminuir zoom', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.1) },
        { label: 'Zoom normal', accelerator: 'CmdOrCtrl+0', click: () => setZoom(1) },
        { type: 'separator' },
        {
          label: 'Sempre no topo',
          type: 'checkbox',
          checked: settings.alwaysOnTop,
          accelerator: 'CmdOrCtrl+Alt+T',
          click: (mi) => {
            settings.alwaysOnTop = mi.checked;
            if (mainWin) mainWin.setAlwaysOnTop(mi.checked);
            scheduleSave();
          },
        },
        {
          label: 'Silenciar áudio',
          type: 'checkbox',
          checked: settings.muted,
          accelerator: 'CmdOrCtrl+Alt+M',
          click: (mi) => {
            settings.muted = mi.checked;
            if (mainWin) mainWin.webContents.setAudioMuted(mi.checked);
            scheduleSave();
          },
        },
        {
          label: 'Modo mini (canto da tela, sempre no topo)',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: toggleMiniMode,
        },
        {
          label: 'Iniciar com o Windows (minimizado)',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (mi) =>
            app.setLoginItemSettings({
              openAtLogin: mi.checked,
              // Mantém a conta ao iniciar com o Windows (a conta 2 volta como conta 2).
              args: ACCOUNT > 1 ? ['--minimized', '--conta=' + ACCOUNT] : ['--minimized'],
            }),
        },
        {
          label: 'Esconder na bandeja',
          accelerator: 'CmdOrCtrl+H',
          click: () => mainWin && mainWin.hide(),
        },
        {
          label: 'Sair',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      // O jogo permite até 4 contas no mesmo IP. Cada uma abre numa instância
      // separada, com pasta de dados própria (login independente, do zero).
      label: 'Contas',
      submenu: [
        ...Array.from({ length: MAX_ACCOUNTS }, (_, i) => i + 1).map((n) => ({
          label:
            (n === 1 ? 'Conta principal' : 'Conta ' + n) +
            (n === ACCOUNT ? '  (esta janela)' : ''),
          enabled: n !== ACCOUNT,
          click: () => openAccount(n),
        })),
        { type: 'separator' },
        {
          label: 'Cada conta tem login e dados próprios',
          enabled: false,
        },
      ],
    },
    {
      label: 'Ferramentas',
      submenu: [
        {
          label: 'Verificar atualizações',
          click: () => runUpdateCheck(true),
        },
        { type: 'separator' },
        // Melhorias do jogo feitas pela comunidade (userscripts).
        { label: 'Scripts da comunidade', submenu: userscriptSubmenu() },
        { type: 'separator' },
        {
          label: 'Ferramentas de desenvolvedor',
          accelerator: 'F12',
          role: 'toggleDevTools',
        },
        { type: 'separator' },
        { label: 'Fazer backup agora', click: () => backupSave() },
        {
          label: 'Abrir pasta de backups',
          click: () => {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
            shell.openPath(BACKUP_DIR);
          },
        },
        { type: 'separator' },
        {
          label: 'Limpar cache e recarregar',
          click: () => clearCache('cache'),
        },
        {
          label: 'Limpar cache e sair do login (mantém o save)',
          click: () => clearCache('full'),
        },
        { type: 'separator' },
        { label: 'Sobre o Poke Idle', click: () => createAboutWindow() },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  startPowerBlocker();
  createTray();
  if (!START_MINIMIZED) createSplash(); // tela de carregamento (some quando o jogo abre)
  createWindow();

  // Atalho global: mostra/esconde o jogo de qualquer lugar.
  globalShortcut.register(TOGGLE_HOTKEY, toggleWindow);

  // Backup periódico do save enquanto o app estiver aberto.
  backupTimer = setInterval(backupSave, BACKUP_INTERVAL_MS);

  // Vigia da conexão do jogo (avisa se o websocket cair).
  connTimer = setInterval(pollConnection, CONN_POLL_MS);

  // Limpeza automática de cache: confere um pouco depois de abrir e a cada 6h.
  setTimeout(autoTrimCache, 60 * 1000);
  setInterval(autoTrimCache, CACHE_CHECK_MS);

  // Scripts da comunidade: confere versões novas 1 min depois de abrir (dá
  // tempo do jogo carregar) e depois a cada 6h. Vale também rodando pelo
  // código, e em cada conta: cada uma tem a sua pasta de dados.
  setTimeout(() => autoAtualizarUserscripts(), 60 * 1000);
  setInterval(() => autoAtualizarUserscripts(), 6 * 60 * 60 * 1000);

  // Auto-atualização (só quando instalado). Verifica ao abrir e a cada 6h;
  // baixa em segundo plano e avisa quando estiver pronta para instalar. A
  // verificação automática é silenciosa (não incomoda se não houver update ou
  // se estiver offline); só a verificação manual mostra "já está atualizado".
  // Só a conta principal cuida do update: as contas extras compartilham a mesma
  // instalação, então 4 instâncias baixando o mesmo instalador seria desperdício.
  if (app.isPackaged && ACCOUNT === 1) {
    runUpdateCheck(false);
    setInterval(() => runUpdateCheck(false), 6 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Não encerra ao fechar a janela — o app fica vivo na bandeja.
// O encerramento real só acontece pelo "Sair" (que chama app.quit()).
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(backupTimer);
  clearInterval(connTimer);
  clearTimeout(reloadTimer);
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId);
  }
});
