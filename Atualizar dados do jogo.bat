@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Baixando os dados do catalogo do Poke Idle World...
echo.
node update-gamedata.js
echo.
echo Pode fechar esta janela.
pause
