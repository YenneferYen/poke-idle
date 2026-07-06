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
} = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const GAME_URL = 'https://poke.idleworld.online/';
const ICON_PATH = path.join(__dirname, 'assets', 'pokeball.ico');
const PNG_ICON_PATH = path.join(__dirname, 'assets', 'pokeball.png');
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

// Agrupa a janela na barra de tarefas com ícone/nome próprios.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.poke.idle');
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
let trayIconOk = null; // ícone da bandeja: conectado (pontinho verde)
let trayIconBad = null; // ícone da bandeja: problema (pontinho vermelho)

const CONN_POLL_MS = 20 * 1000; // frequência do vigia de conexão

// Preferências lembradas entre sessões (mudo, sempre-no-topo, zoom).
const settings = { muted: false, alwaysOnTop: false, zoom: 1 };

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
async function backupSave() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    const drop = JSON.stringify(SENSITIVE_KEYS);
    const json = await mainWin.webContents.executeJavaScript(
      'JSON.stringify(Object.fromEntries(Object.entries(localStorage)' +
        '.filter(([k]) => !' +
        drop +
        '.includes(k))))',
      true
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
// CSS injetado no modo mini: esconde a "bagunça" da HUD (barra de ícones do
// topo, chat, painel do Auto-Helper e o botão do mercado), deixando o essencial
// para acompanhar o idle: o time (div.phud) e os painéis de captura/batalha, que
// aparecem por cima do mapa durante os encontros. É totalmente reversível
// (removido ao sair do modo mini). Seletores mapeados da HUD logada em jul/2026.
// ---------------------------------------------------------------------------
const MINI_HIDE_CSS = [
  'nav.game-dock',
  'div.chat-box',
  'div.ah-panel',
  'button.market-cta',
].join(',') + '{display:none !important;}';

async function applyMiniHudCss() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    miniCssKey = await mainWin.webContents.insertCSS(MINI_HIDE_CSS);
  } catch (_) {
    /* ignora */
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

async function pollConnection() {
  if (!mainWin || mainWin.isDestroyed()) return;
  let state = null;
  try {
    state = await mainWin.webContents.executeJavaScript(
      "(()=>{const d=document.querySelector('.chat-dot');" +
        "return d?{on:d.classList.contains('on')}:null;})()",
      true
    );
  } catch {
    return; // página não pronta: tenta no próximo ciclo
  }
  // Fora do jogo (login/landing não têm o pontinho): não é queda, apenas ignora.
  if (!state) {
    connMisses = 0;
    return;
  }

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

function createWindow() {
  const state = loadWindowState();
  const opts = {
    width: state.width || 1280,
    height: state.height || 860,
    title: 'Poke Idle',
    icon: ICON_PATH,
    backgroundColor: '#1b1b2f',
    autoHideMenuBar: true,
    show: false, // só exibe no ready-to-show (evita tela branca)
    webPreferences: {
      // A chave de tudo: não deixa o Chromium desacelerar os timers da página
      // quando a janela está minimizada / atrás de outras janelas.
      backgroundThrottling: false,
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
    loggedOut
      ? 'Poke Idle — DESCONECTADO (faça login)'
      : connDown
        ? 'Poke Idle — conexão caiu (reconectando…)'
        : 'Poke Idle — o jogo continua rodando em segundo plano'
  );
}

// Ícone na bandeja (ao lado do relógio), com menu de contexto.
function createTray() {
  trayIconOk = makeTrayIcon([40, 180, 40]); // verde (BGR)
  trayIconBad = makeTrayIcon([40, 40, 220]); // vermelho (BGR)
  tray = new Tray(trayIconOk);
  tray.setToolTip('Poke Idle — o jogo continua rodando em segundo plano');
  const trayMenu = Menu.buildFromTemplate([
    { label: 'Mostrar / Esconder', click: toggleWindow },
    { label: 'Modo mini (canto da tela)', click: toggleMiniMode },
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
            app.setLoginItemSettings({ openAtLogin: mi.checked, args: ['--minimized'] }),
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
      label: 'Ferramentas',
      submenu: [
        {
          label: 'Verificar atualizações',
          click: () => runUpdateCheck(true),
        },
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
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  startPowerBlocker();
  createTray();
  createWindow();

  // Atalho global: mostra/esconde o jogo de qualquer lugar.
  globalShortcut.register(TOGGLE_HOTKEY, toggleWindow);

  // Backup periódico do save enquanto o app estiver aberto.
  backupTimer = setInterval(backupSave, BACKUP_INTERVAL_MS);

  // Vigia da conexão do jogo (avisa se o websocket cair).
  connTimer = setInterval(pollConnection, CONN_POLL_MS);

  // Auto-atualização (só quando instalado). Verifica ao abrir e a cada 6h;
  // baixa em segundo plano e avisa quando estiver pronta para instalar. A
  // verificação automática é silenciosa (não incomoda se não houver update ou
  // se estiver offline); só a verificação manual mostra "já está atualizado".
  if (app.isPackaged) {
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
