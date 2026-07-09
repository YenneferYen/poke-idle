@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Publicar nova versao do Poke Idle
echo ============================================
echo.
echo 1/3 - Salvando mudancas...
git add -A
git commit -m "Lista de Pokemon por nivel de caca e ajustes" 2>nul
echo.
echo 2/3 - Subindo o numero da versao...
call npm version patch
echo.
echo 3/3 - Enviando para o GitHub (o CI vai buildar e publicar sozinho)...
git push --follow-tags origin main
echo.
echo ============================================
echo   Pronto! Acompanhe o build em:
echo   https://github.com/YenneferYen/poke-idle/actions
echo   Em alguns minutos o app instalado se atualiza.
echo ============================================
echo.
pause
