/**
 * Onde a API do HeroTrade responde — o tunel que aponta para a maquina do
 * Gustavo (Cloudflare Tunnel, ngrok, o que for).
 *
 * Vazio = a pagina tenta a mesma origem que a serviu. Isso funciona quando o
 * proprio coletor entrega a tela em localhost:4000, e NAO funciona no GitHub
 * Pages: la a mesma origem e o github.io, que nao tem API nenhuma. Sem
 * preencher, a tela abre e mostra "nunca" sincronizado.
 *
 * ATENCAO: este endereco e de "quick tunnel" e MUDA a cada vez que o
 * cloudflared reinicia. Quando mudar, atualize aqui e faca push de novo.
 *
 * Sem barra no fim.
 */
window.HEROTRADE_API = "https://referred-athletic-travelling-irc.trycloudflare.com";
