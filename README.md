# Poke Idle

Janela dedicada para o jogo **Poké Idle World** (https://poke.idleworld.online/)
que **não adormece** quando fica em segundo plano.

## Por que existe

Navegadores "congelam" abas fora de foco pra economizar recursos — o que trava
jogos idle, que dependem do tempo passando. Este app abre o jogo numa janela
própria (Electron) com o congelamento **desligado**, então ele continua rodando
minimizado ou atrás de outras janelas.

## Como abrir

Clique duas vezes em **"Abrir Poke Idle"** (na área de trabalho ou nesta pasta).

## O que ele faz

- Desliga o "adormecer" da aba (`backgroundThrottling: false` + flags do Chromium).
- Impede o Windows de entrar em suspensão enquanto o jogo está aberto.
- Guarda login e progresso do site (funciona como um navegador de verdade).
- Uma única instância: clicar de novo traz a janela existente pra frente.
- **Fechar (X) esconde na bandeja** — o jogo continua rodando. Para sair de
  verdade: clique direito no ícone da bandeja → Sair (ou menu Jogo → Sair).
- **Reconexão automática**: se a internet cair ou a página travar, recarrega
  o jogo sozinho.
- **Lembra tamanho e posição** da janela entre sessões.
- **Atalho global `Ctrl+Alt+P`**: mostra/esconde o jogo de qualquer lugar.
- **Sempre no topo** (Ctrl+Alt+T) e **Silenciar áudio** (Ctrl+Alt+M).
- **Backup automático do localStorage** a cada 10 min em `userData/backups`,
  mantendo os 30 mais recentes. Guarda preferências e a configuração de caças
  (hunts); **não guarda os tokens de login** (excluídos por segurança). Menu
  Ferramentas → "Fazer backup agora" / "Abrir pasta de backups".
- **Limpar cache** (menu Ferramentas e bandeja): resolve travamento/tela branca
  no carregamento. Faz backup antes e **não apaga** hunts/preferências nem, no
  modo padrão, o login. Um segundo modo também sai do login (limpa cookies).
- **Atualização com aviso**: o app checa updates ao abrir e a cada 6h. Menu
  Ferramentas → "Verificar atualizações" agora mostra o resultado ("já está
  atualizado", "baixando…", erro) e, quando a nova versão está pronta, pergunta
  se quer reiniciar para instalar.
- **Ferramentas de desenvolvedor** (F12) para inspecionar o jogo.
- Menu "Jogo": Recarregar (Ctrl+R), Tela cheia (F11), Zoom (Ctrl +/-/0),
  Sempre no topo (Ctrl+Alt+T), Silenciar (Ctrl+Alt+M), Esconder na bandeja
  (Ctrl+H), Sair (Ctrl+Q).

## Onde ficam os dados / backups

Pasta do app (userData): `%APPDATA%\poke-idle`
- `window-state.json` — tamanho/posição da janela.
- `backups\save-*.json` — cópias do localStorage (sem tokens).

Arquitetura de dados do jogo (mapeada em jul/2026): o **progresso vivo**
(time, níveis, HP/XP, recursos) é **server-authoritative** — vem do servidor,
não fica no PC. O `localStorage` guarda só preferências de tela, a configuração
de caças (`poke:hunts:*`) e os tokens de login. Por isso o backup local protege
preferências/hunts, mas o progresso em si está seguro na conta (servidor).

## Bandeja do sistema

O ícone da Pokébola aparece ao lado do relógio. Clique nele para mostrar/esconder
o jogo; clique direito para o menu (Mostrar/Esconder, Recarregar, Sair).

## Iniciar minimizado

Abrir com o parâmetro `--minimized` faz o app começar minimizado na barra de
tarefas, rodando em segundo plano — útil para um atalho de inicialização.

## Iniciar junto com o Windows (opcional)

Coloque um atalho na pasta de Inicialização apontando para o `electron.exe`
com os argumentos `. --minimized`. Atalho rápido: tecla Windows + R, digite
`shell:startup`, e crie ali um atalho para o app.

## Atualizar / mexer

Só o arquivo `main.js` importa. Para trocar o jogo, mude a constante `GAME_URL`
no topo dele. O ícone fica em `assets/pokeball.ico` (gerado a partir de
`assets/pokeball.png`).

Requer **Node ≥ 22.12** (exigência do `rcedit` no build). Veja `.nvmrc`.

## Publicar uma atualização (para o app instalado receber)

Só fazer `git push` do código **não** atualiza o app instalado — ele se atualiza
lendo as **Releases** do GitHub (`latest.yml` + instalador). Publique uma versão:

```
npm version patch      # sobe a versão no package.json e cria commit + tag vX.Y.Z
git push --follow-tags # a tag dispara o GitHub Actions, que builda e publica a Release
```

O workflow em `.github/workflows/release.yml` roda no GitHub e usa o
`GITHUB_TOKEN` embutido — **não precisa de token na sua máquina**. Para buildar
localmente sem publicar: `npm run dist` (gera o instalador em `dist/`).
