// ---------------------------------------------------------------------------
// Injeção dos userscripts da comunidade (PIW-QOL e JustPokédex) dentro da
// janela do jogo.
//
// Os dois são feitos para o Tampermonkey, mas declaram `@grant none`: ou seja,
// não usam nenhuma API do gerenciador de userscripts, são só JavaScript comum.
// Então basta rodá-los no "mundo" da página, no mesmo momento em que o
// Tampermonkey rodaria (`@run-at document-start`) — antes de qualquer script
// do jogo. É exatamente isso que este preload faz.
//
// Por que um <script> na página, e não rodar o código aqui direto?
// Este preload vive num contexto isolado (contextIsolation, o padrão seguro):
// o `window` daqui NÃO é o `window` do jogo. Os scripts precisam substituir o
// `window.WebSocket` do jogo para ler as mensagens da partida, e isso só
// funciona no mundo da própria página. Injetar via <script> coloca o código
// lá dentro sem precisar afrouxar a segurança do app.
//
// Os códigos vêm do processo principal (que decide quais estão ligados, de
// onde ler o arquivo e em que ordem). Nada é baixado aqui: só executa os
// arquivos locais. Um <script> por userscript: se um quebrar ao iniciar, o
// outro roda mesmo assim.
// ---------------------------------------------------------------------------
const { ipcRenderer } = require('electron');

// Só o quadro principal do jogo. Iframes (anúncio, widget) não recebem nada.
if (window.top === window && location.hostname === 'poke.idleworld.online') {
  let scripts = [];
  try {
    // Síncrono de propósito: precisa estar em mãos ANTES do jogo começar a
    // rodar. Menos de 1 MB lido de disco uma única vez, em milissegundos.
    scripts = ipcRenderer.sendSync('userscripts:get-codes') || [];
  } catch (e) {
    console.warn('[Poke Idle] Não consegui obter os userscripts:', e && e.message);
  }

  // O JustPokédex tem um aviso próprio de versão nova que manda "atualizar no
  // Tampermonkey" — aqui quem atualiza é o app (Ferramentas → Scripts da
  // comunidade), então esse aviso só confundiria. Desliga UMA vez, como padrão;
  // se alguém religar pelo botão ☁️ do próprio script, a escolha é respeitada.
  try {
    if (localStorage.getItem('justpokedex-auto-update-enabled') === null) {
      localStorage.setItem('justpokedex-auto-update-enabled', 'false');
    }
  } catch {
    /* armazenamento indisponível: o aviso só aparece, sem dano */
  }

  if (scripts.length) {
    const injetar = () => {
      for (const { nome, code } of scripts) {
        try {
          const el = document.createElement('script');
          el.textContent = code;
          // `documentElement` é o <html>; nesta altura ainda não existe <head>.
          (document.head || document.documentElement).appendChild(el);
          // O código já rodou ao ser inserido: tira a tag para não poluir o DOM.
          el.remove();
          console.log('[Poke Idle] ' + nome + ' injetado.');
        } catch (e) {
          console.warn('[Poke Idle] Falha ao injetar o ' + nome + ':', e && e.message);
        }
      }
    };

    if (document.documentElement) {
      injetar();
    } else {
      // O preload roda tão cedo que o <html> pode ainda não existir. Observa o
      // documento e injeta no instante em que ele aparecer — ainda antes dos
      // scripts do jogo.
      const obs = new MutationObserver(() => {
        if (document.documentElement) {
          obs.disconnect();
          injetar();
        }
      });
      obs.observe(document, { childList: true });
    }
  }
}
