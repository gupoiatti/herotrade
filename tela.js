/**
 * A tela: o que ela sabe, o que ela pede à API e como ela desenha.
 *
 * A conta do bônus de drop mora em `regras.js` — aqui só se usa o resultado.
 * O desenho é innerHTML montado à mão, sem framework: são quatro caixas
 * (`alerta`, `controles`, `abas`, `painel`) e nenhuma delas justifica uma
 * dependência a mais. Todo texto que vem de dado passa por `esc`.
 */

import {
  MOEDA_NOME, MOEDA_CHAVE, ASC_POR_NIVEL, RATES, CONSUMIVEIS, PETS, GRADES,
  bonusPet, bonusConsumiveis, multiplicadorDe, taxaFinal,
} from "./regras.js";
import { amostraCurta, lerReplay, porJanela } from "./replay.js";

/**
 * Conteúdos e chances vêm da API (`/v1/wiki`, que serve o conteudos-wiki.json).
 *
 * Antes esta lista era uma cópia dentro da página. Duas cópias da mesma coisa
 * saem de sincronia sem avisar: a tela mostraria um drop que a coleta não
 * busca, ou o contrário — e o total pareceria certo do mesmo jeito.
 */
let CONTEUDOS = [];

/* --- formatação ---------------------------------------------------------- */

const num = function (n) { return Math.round(n).toLocaleString("pt-BR"); };

/** Quantidades pequenas precisam de casas; grandes, não. */
function qtdTexto(q) {
  if (q === 0) return "0";
  if (q >= 100) return Math.round(q).toLocaleString("pt-BR");
  if (q >= 10) return q.toFixed(1);
  if (q >= 1) return q.toFixed(2);
  if (q >= 0.01) return q.toFixed(3);
  return q.toFixed(4);
}

function horaDe(iso) {
  if (!iso) return "nunca";
  const d = new Date(iso);
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const mesmoDia = d.toDateString() === new Date().toDateString();
  return mesmoDia ? hora
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + hora;
}

/** Texto que veio de dado, nunca direto no innerHTML. */
function esc(t) {
  return String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* --- estado -------------------------------------------------------------- */

const estado = {
  view: "ranking",
  rate: "temporada",
  vip: false,
  valhalla: false,
  ascensao: 0,
  pet: "0",
  grade: "0",
  dropFinal: 0,
  consumiveis: [],
  listaAberta: false,
  variante: {},
  ritmo: {},
  precos: {},
  health: null,

  /** O último `.rrf` lido, ou `null`. Vive só na memória do navegador. */
  replay: null,
  replayErro: "",
  /** Conteúdo escolhido à mão quando o mapa ainda não é conhecido. */
  replayConteudo: "",
  /** As gravações deste navegador. São as únicas que medem ritmo. */
  runsLocais: [],
};

/**
 * Lê e escreve no navegador de quem está vendo a página.
 *
 * `localStorage` pode simplesmente não existir — janela anônima, site com
 * dados bloqueados —, e nesse caso tudo aqui devolve vazio em vez de estourar:
 * a aba continua lendo replay, só não lembra dele na próxima visita.
 */
function noNavegador(chave, novo) {
  try {
    if (novo !== undefined) localStorage.setItem(chave, novo);
    return localStorage.getItem(chave);
  } catch (e) {
    return null;
  }
}

/**
 * Teto de gravações guardadas no navegador.
 *
 * Cada uma ocupa uns 200 bytes, então o teto não é sobre espaço — é sobre a
 * média não ficar presa a farm de um ano atrás, quando o personagem era outro.
 * Ao passar disto, a mais antiga sai.
 */
const MAXIMO_RUNS_LOCAIS = 300;

/**
 * As gravações **deste navegador**.
 *
 * Cada pessoa que abre o site mede o próprio ritmo, e ele não sai da máquina
 * dela: nada disto passa pela API, e por isso a aba de replay funciona inteira
 * com o coletor do Gustavo desligado.
 *
 * O preço de guardar aqui: limpar os dados do navegador apaga, e o que foi
 * medido num computador não aparece no outro.
 */
function runsLocais(novas) {
  if (novas !== undefined) {
    noNavegador("herotrade-runs", JSON.stringify(novas.slice(-MAXIMO_RUNS_LOCAIS)));
  }
  try {
    const cru = JSON.parse(noNavegador("herotrade-runs") || "[]");
    return Array.isArray(cru) ? cru : [];
  } catch (e) {
    return [];
  }
}

/**
 * Onde a API mora.
 *
 * Vazio = mesma origem que serviu a página, que é o caso quando se roda
 * `npm run dev` e o próprio coletor entrega a tela. Hospedada no GitHub Pages
 * a página está noutro domínio, e aí `config.js` põe aqui o endereço do túnel
 * que aponta para a máquina do Gustavo.
 *
 * Fica sem barra no fim para as rotas continuarem sendo escritas `/v1/...`.
 */
const API = String(window.HEROTRADE_API || "").replace(/\/+$/, "");

async function pegar(rota) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, 2500);
  try {
    const r = await fetch(API + rota, { signal: ctrl.signal });
    const c = await r.json();
    if (!r.ok) throw new Error(c.erro || "erro " + r.status);
    return c;
  } finally { clearTimeout(t); }
}

/**
 * A lista de conteúdos, da API ou do arquivo publicado ao lado da página.
 *
 * A API vem primeiro porque lá o `conteudos-wiki.json` pode estar mais novo
 * que a última vez que o site foi publicado. Quando ela não responde — máquina
 * desligada, túnel caído —, o arquivo copiado pelo `npm run site` serve: mapas,
 * monstros e chances são fixos no jogo, e não há por que depender de uma
 * máquina ligada para conhecê-los.
 *
 * Sem os dois, a página não tem o que desenhar e diz isso.
 */
async function carregarConteudos() {
  try {
    const wiki = await pegar("/v1/wiki");
    const daApi = (wiki.data && wiki.data.conteudos) || [];
    if (daApi.length > 0) return daApi;
  } catch (e) {
    // Segue para o arquivo.
  }

  try {
    const r = await fetch("conteudos-wiki.json");
    if (!r.ok) return [];
    const doArquivo = await r.json();
    return doArquivo.conteudos || [];
  } catch (e) {
    return [];
  }
}

/**
 * Preços por **itemId**. Sem API, fica vazio.
 *
 * Era por nome, e o nome é justamente o que não bate: a wiki escreve em
 * português e o jogo em inglês ("Elunium Enriquecido" lá é "Enriched
 * Elunium"), fora acento e pontuação. O id não tem nenhum desses problemas —
 * e é o que a §3.4 do CLAUDE.md manda usar desde o começo.
 */
async function carregar() {
  try {
    if (CONTEUDOS.length === 0) CONTEUDOS = await carregarConteudos();
    // Independentes entre si: em série seriam três esperas onde cabe uma.
    const [health, itens] = await Promise.all([pegar("/v1/health"), pegar("/v1/itens")]);
    const precos = {};
    (itens.data || []).forEach(function (i) {
      precos[i.id] = i.precos || {};
    });
    estado.precos = precos;
    estado.health = health;


  } catch (e) {
    estado.precos = {};
    estado.health = null;
  }
  desenhar();
}

function precoDe(drop) {
  // Sem itemId no conteudos-wiki.json não há como ter preço: é o id que liga
  // o drop ao item do jogo.
  if (typeof drop.itemId !== "number") return null;
  return precoDoItem(drop.itemId);
}

/**
 * O menor preço do item, em Hero Points.
 *
 * A API devolve os preços indexados por moeda porque o banco ainda guarda
 * ofertas antigas em RMT, que não se apagam (§4.2). Ler só esta chave é o que
 * mantém aquele histórico fora da conta sem precisar mexer nele.
 */
function precoDoItem(itemId) {
  const p = estado.precos[itemId];
  const v = p && p[MOEDA_CHAVE];
  return typeof v === "number" ? v : null;
}

function mods() {
  return {
    rate: RATES[estado.rate] ? estado.rate : "temporada",
    vip: estado.vip,
    valhalla: estado.valhalla,
    ascensao: Math.max(0, Math.min(15, Number(estado.ascensao) || 0)),
    pet: PETS[estado.pet] !== undefined ? estado.pet : "0",
    grade: GRADES[estado.grade] !== undefined ? estado.grade : "0",
    consumiveis: estado.consumiveis,
    dropFinal: Math.max(0, Number(estado.dropFinal) || 0),
  };
}

function varianteDe(c) {
  const id = estado.variante[c.id];
  return c.variantes.filter(function (v) { return v.id === id; })[0] || c.variantes[0];
}

/**
 * Soma um conjunto de gravações num ritmo por 30 minutos.
 *
 * Divide o total de abates pelo tempo somado, e **não** tira a média das taxas
 * de cada gravação: por aquela conta, uma run de dois minutos pesaria igual a
 * uma de duas horas, e é a curta que carrega o ruído.
 */
function somarRitmo(runs) {
  if (runs.length === 0) return null;

  const abates = runs.reduce(function (t, r) { return t + r.abates; }, 0);
  const duracaoMs = runs.reduce(function (t, r) { return t + r.duracaoMs; }, 0);
  const taxa = porJanela(abates, duracaoMs);
  if (taxa === null) return null;

  return { runs: runs.length, abates: abates, duracaoMs: duracaoMs, porJanela: Math.round(taxa) };
}

/**
 * O ritmo medido de um conteúdo **por quem está vendo a página**, ou `null`.
 *
 * Só as gravações desta pessoa entram. O ritmo é do personagem, do equipamento
 * e da mão de quem jogou: herdar o de outro seria mostrar um lucro que não é o
 * seu, com cara de medição. Quem nunca subiu replay fica com a estimativa do
 * arquivo, e a tela diz que é estimativa.
 *
 * O que o Gustavo mede serve a outra coisa — reconhecer o mapa e os monstros
 * de cada conteúdo (§3.5) —, e não ao ritmo de ninguém.
 *
 * `conteudoId` nulo agrupa o que foi guardado sem conteúdo definido.
 */
function ritmoMedido(conteudoId) {
  return somarRitmo(estado.runsLocais.filter(function (r) {
    return (r.conteudoId || null) === conteudoId;
  }));
}

/**
 * Quantos abates o conteúdo rende em 30 minutos, na ordem de quem manda mais.
 *
 * 1. O que o Gustavo digitou na tela — ajuste à mão sempre ganha.
 * 2. O que as gravações mediram (§3.5).
 * 3. O `ritmoPadrao` do arquivo, que é estimativa e o §7 pede para substituir.
 */
function ritmoDe(c) {
  const bruto = estado.ritmo[c.id];
  if (bruto !== undefined) return Math.max(0, Number(bruto) || 0);

  const medido = ritmoMedido(c.id);
  if (medido !== null) return medido.porJanela;

  return c.ritmoPadrao;
}

/**
 * Fecha a conta de uma lista de linhas já precificadas, e a ordena.
 *
 * A regra do §7 do CLAUDE.md mora aqui, e só aqui: **drop sem preço não entra
 * no total, e o total diz que está incompleto**. As duas telas que somam preço
 * passam por esta função, para não existir a chance de uma passar a somar o que
 * falta e a outra não.
 */
function fecharConta(linhas) {
  let valor = 0, semPreco = 0, comPreco = 0;

  linhas.forEach(function (l) {
    if (l.preco === null) semPreco++;
    else { comPreco++; valor += l.subtotal; }
  });

  linhas.sort(function (a, b) { return b.subtotal - a.subtotal || b.qtd - a.qtd; });
  return { linhas: linhas, valor: valor, semPreco: semPreco, comPreco: comPreco };
}

/**
 * Farm de 30 minutos: cada unidade (abate ou run) é uma tentativa de drop, e a
 * quantidade esperada é a taxa final × tentativas.
 */
function sessao(c) {
  const m = mods();
  const variante = varianteDe(c);
  const tentativas = ritmoDe(c);
  let itens = 0, semId = 0;

  const linhas = variante.drops.map(function (drop) {
    const taxa = taxaFinal(drop.chance, m);
    const qtd = (taxa / 100) * tentativas * (drop.qtd || 1);
    itens += qtd;
    if (typeof drop.itemId !== "number") semId++;

    const preco = precoDe(drop);
    return {
      drop: drop, taxa: taxa, qtd: qtd, preco: preco,
      subtotal: preco === null ? 0 : preco * qtd,
    };
  });

  const conta = fecharConta(linhas);
  return {
    variante: variante, tentativas: tentativas, itens: itens, semId: semId,
    linhas: conta.linhas, valor: conta.valor,
    semPreco: conta.semPreco, comPreco: conta.comPreco,
  };
}

/* --- desenho ------------------------------------------------------------- */

const $ = function (id) { return document.getElementById(id); };

function desenhar() {
  const m = mods();
  const mult = multiplicadorDe(m);
  const sessoes = CONTEUDOS.map(function (c) { return { c: c, s: sessao(c) }; });
  const temPreco = sessoes.some(function (x) { return x.s.comPreco > 0; });

  $("sync").textContent = estado.health
    ? horaDe((estado.health.ultimaRodada && (estado.health.ultimaRodada.fim || estado.health.ultimaRodada.inicio)) || null)
    : "nunca";

  // Na aba de replay este alerta mente por omissão: ele fala das quantidades
  // por 30 min das outras abas, e lá a medição é de abates, não de preço.
  $("alerta").innerHTML = temPreco || estado.view === "replay" ? "" :
    '<div class="alerta"><strong>SEM PREÇOS.</strong> A API local não respondeu, ou nenhum ' +
    'drop foi coletado ainda — então nada aqui está convertido em ' + MOEDA_NOME +
    '. As quantidades por 30 min são reais (chances da wiki × seu bônus), o valor não.</div>';

  desenharControles(m, mult);
  desenharAbas(sessoes);

  if (estado.view === "ranking") desenharRanking(sessoes, temPreco);
  else if (estado.view === "replay") desenharReplay();
  else {
    const alvo = sessoes.filter(function (x) { return x.c.id === estado.view; })[0];
    if (alvo) desenharConteudo(alvo, mult); else desenharRanking(sessoes, temPreco);
  }
}

function desenharControles(m, mult) {
  const ativos = CONSUMIVEIS.filter(function (c) { return m.consumiveis.indexOf(c.id) >= 0; });
  const rotuloCons = ativos.length === 0 ? "nenhum"
    : ativos.length === 1 ? ativos[0].nome
    : ativos.length + " ativos · +" + bonusConsumiveis(m.consumiveis) + "%";

  const opcoesRate = Object.keys(RATES).map(function (k) {
    return '<option value="' + k + '"' + (m.rate === k ? " selected" : "") + '>' +
      esc(RATES[k].nome) + "</option>";
  }).join("");

  const opcoesPet = [["0", "nenhum"], ["150", "Pet 150 +50%"], ["140", "Pet 140 +35%"],
                     ["90", "Pet 90 +30%"], ["70", "Pet 70 +20%"]].map(function (o) {
    return '<option value="' + o[0] + '"' + (m.pet === o[0] ? " selected" : "") + '>' + o[1] + "</option>";
  }).join("");

  const opcoesGrade = [["0", "sem grade"], ["D", "Grade D +40%"], ["C", "Grade C +80%"],
                       ["B", "Grade B +100%"], ["A", "Grade A +150%"]].map(function (o) {
    return '<option value="' + o[0] + '"' + (m.grade === o[0] ? " selected" : "") + '>' + o[1] + "</option>";
  }).join("");

  const lista = !estado.listaAberta ? "" :
    '<div class="lista-cons">' + CONSUMIVEIS.map(function (c) {
      const ligado = m.consumiveis.indexOf(c.id) >= 0;
      const bloqueado = !ligado && m.consumiveis.some(function (id) {
        const outro = CONSUMIVEIS.filter(function (x) { return x.id === id; })[0];
        return outro.grupo === c.grupo || (outro.embuteLata && c.grupo === "lata");
      });
      return '<button data-cons="' + c.id + '"' + (bloqueado ? " disabled" : "") +
        ' title="' + esc(c.descricao + (bloqueado ? " — não acumula com o que já está ativo." : "")) + '"' +
        ' style="background:' + (ligado ? "#f0b4291a" : "transparent") +
        ';color:' + (bloqueado ? "#454f60" : ligado ? "#eef1f6" : "#b9c2d0") + '">' +
        '<span class="marca" style="border-color:' + (bloqueado ? "#2b3444" : ligado ? "#f0b429" : "#3a4557") +
        ';background:' + (ligado ? "#f0b429" : "transparent") + '"></span>' +
        '<span class="nome">' + esc(c.nome) + "</span>" +
        '<span class="val" style="color:' + (bloqueado ? "#454f60" : ligado ? "#f0b429" : "#8b95a7") + '">+' +
        c.bonus + "%</span></button>";
    }).join("") +
    '<div class="rodape-cons">Gomas não acumulam entre si. A Lata de Comida para Gatos acumula — e já vem embutida no Cálice do Elixir Sagrado II.</div></div>';

  $("controles").innerHTML =
    '<div class="controles"><div class="painel-taxa">' +
      '<div class="rotulo" style="line-height:1.5">Taxa de<br>drop final</div>' +
      '<div class="divisor"></div>' +
      '<label class="campo">Rate <select id="rate">' + opcoesRate + "</select></label>" +
      '<button class="pilula' + (m.vip ? " on" : "") + '" id="vip"><span class="ponto"></span>' +
        (m.vip && m.valhalla ? "VIP +20%" : "VIP +10%") + "</button>" +
      '<button class="pilula' + (m.valhalla && m.vip ? " on" : "") + '" id="valhalla" title="' +
        (m.valhalla && !m.vip ? "Valhalla dobra o bônus do VIP comum — sem VIP ligado, não muda nada."
                              : "Dobra a bonificação de drop do VIP comum") +
        '"><span class="ponto"></span>Valhalla ×2</button>' +
      '<label class="campo">Pet <select id="pet">' + opcoesPet + "</select>" +
        '<select id="grade"' + (m.pet === "0" ? " disabled" : "") + ' title="Multiplica o drop base do pet">' +
        opcoesGrade + "</select>" +
        '<span class="off" style="font-family:var(--mono)">' +
        (m.pet === "0" ? "" : "+" + Math.round(bonusPet(m)) + "%") + "</span></label>" +
      '<div class="par">' +
        '<label class="campo">Ascensão <input type="number" id="ascensao" min="0" max="15" step="1" value="' +
          m.ascensao + '" style="width:52px"><span class="off">+' + m.ascensao * ASC_POR_NIVEL + "%</span></label>" +
        '<div class="menu-cons" id="menu-cons">Consumíveis ' +
          '<button class="pilula' + (ativos.length ? " on" : "") + '" id="abrir-cons">' +
          esc(rotuloCons) + ' <span class="off" style="font-size:10px">▼</span></button>' + lista + "</div>" +
      "</div>" +
      '<label class="campo" style="margin-left:auto;padding-left:16px;border-left:1px solid var(--borda)"' +
        ' title="Incide sobre todo o bônus de drop já acumulado, no fim da conta">Drop Final ' +
        '<input type="number" id="drop-final" min="0" step="1" value="' + m.dropFinal +
        '" style="width:58px"><span>%</span></label>' +
    "</div>" +
    '<div class="bonus"><div class="rotulo" style="line-height:1.5">Bônus<br>de drop</div>' +
      "<b>+" + Math.round((mult - 1) * 100) + "%</b></div></div>";

  $("rate").onchange = function (e) { estado.rate = e.target.value; desenhar(); };
  $("vip").onclick = function () { estado.vip = !estado.vip; desenhar(); };
  $("valhalla").onclick = function () { estado.valhalla = !estado.valhalla; desenhar(); };
  $("pet").onchange = function (e) { estado.pet = e.target.value; desenhar(); };
  $("grade").onchange = function (e) { estado.grade = e.target.value; desenhar(); };
  $("ascensao").onchange = function (e) {
    estado.ascensao = Math.max(0, Math.min(15, Number(e.target.value) || 0));
    desenhar();
  };
  $("drop-final").onchange = function (e) {
    estado.dropFinal = Math.max(0, Number(e.target.value) || 0);
    desenhar();
  };
  $("abrir-cons").onclick = function (e) {
    e.stopPropagation();
    estado.listaAberta = !estado.listaAberta;
    desenhar();
  };
  Array.prototype.forEach.call(document.querySelectorAll("[data-cons]"), function (b) {
    b.onclick = function () {
      const id = b.getAttribute("data-cons");
      const atuais = estado.consumiveis;
      estado.consumiveis = atuais.indexOf(id) >= 0
        ? atuais.filter(function (x) { return x !== id; })
        : atuais.concat(id);
      desenhar();
    };
  });
}

function desenharAbas(sessoes) {
  const abas = [{ id: "ranking", nome: "Ranking", selo: String(CONTEUDOS.length) }]
    .concat(CONTEUDOS.map(function (c) {
      return { id: c.id, nome: c.nome, selo: String(varianteDe(c).drops.length) };
    }))
    // O selo conta as gravações guardadas: é o que diz se já há ritmo medido
    // ou só as estimativas das outras abas.
    .concat([{ id: "replay", nome: "Replay", selo: String(estado.runsLocais.length) }]);

  $("abas").innerHTML = abas.map(function (a) {
    return '<button data-aba="' + a.id + '" class="' + (estado.view === a.id ? "ativa" : "") + '">' +
      esc(a.nome) + '<span class="selo">' + a.selo + "</span></button>";
  }).join("");

  Array.prototype.forEach.call(document.querySelectorAll("[data-aba]"), function (b) {
    b.onclick = function () { estado.view = b.getAttribute("data-aba"); desenhar(); };
  });
}

function desenharRanking(sessoes, temPreco) {
  const chave = function (x) { return temPreco ? x.s.valor : x.s.itens; };
  const ordenados = sessoes.slice().sort(function (a, b) { return chave(b) - chave(a); });
  const maior = Math.max(1e-9, Math.max.apply(null, ordenados.map(chave)));

  const linhas = ordenados.map(function (x, i) {
    return '<button class="linha-rank grade-rank" data-ir="' + esc(x.c.id) + '">' +
      '<div class="pos' + (i === 0 ? " primeiro" : "") + '">' + String(i + 1).padStart(2, "0") + "</div>" +
      "<div><div class=\"nome-conteudo\">" + esc(x.c.nome + (x.c.variantes.length > 1 ? " · " + x.s.variante.nome : "")) + "</div>" +
      '<div class="legenda">' + x.s.tentativas + (x.c.tipo === "mvp" ? " runs" : " abates") +
        " / 30 min · " + qtdTexto(x.s.itens) + " itens</div></div>" +
      '<div><div class="trilho"><div class="barra" style="width:' +
        Math.max(2, Math.round((chave(x) / maior) * 100)) + '%"></div></div></div>' +
      '<div class="primaria">' + (temPreco ? num(x.s.valor) : qtdTexto(x.s.itens)) + "</div></button>";
  }).join("");

  $("painel").innerHTML =
    '<div class="cabeca-secao"><h2 class="secao">Melhor lucro em 30 minutos</h2></div>' +
    '<div class="grade-rank cabeca-rank"><div>#</div><div>Conteúdo</div><div></div>' +
    '<div style="text-align:right">' + esc(temPreco ? MOEDA_NOME + " / 30 min" : "Itens / 30 min") + "</div></div>" + linhas;

  Array.prototype.forEach.call(document.querySelectorAll("[data-ir]"), function (b) {
    b.onclick = function () { estado.view = b.getAttribute("data-ir"); desenhar(); };
  });
}

function desenharConteudo(alvo, mult) {
  const c = alvo.c, s = alvo.s;
  const medido = ritmoMedido(c.id);
  const daMao = estado.ritmo[c.id] !== undefined;

  const variantes = c.variantes.length < 2 ? "" :
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
    '<span class="rotulo">' + esc(c.rotuloVariante || "Modo") + "</span>" +
    '<div class="grupo-botoes" style="background:var(--campo)">' +
    c.variantes.map(function (v) {
      return '<button data-var="' + esc(v.id) + '" class="' + (v.id === s.variante.id ? "on" : "") + '">' +
        esc(v.nome) + "</button>";
    }).join("") + "</div></div>";

  const notas = s.variante.notas.length === 0 ? "" :
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto">' +
    s.variante.notas.map(function (n) { return '<span class="nota">' + esc(n) + "</span>"; }).join("") + "</div>";

  const corpo = s.linhas.map(function (l) {
    return "<tr><td class=\"esq nome\">" + esc(l.drop.nome) +
      '<span class="sub">' + esc(l.drop.grupo || "") + "</span></td>" +
      "<td>" + l.taxa.toFixed(2) + '%<span class="sub">base ' + l.drop.chance + "%</span></td>" +
      '<td class="' + (l.qtd >= 1 ? "" : "off") + '">' + qtdTexto(l.qtd) + "</td>" +
      '<td class="' + (l.preco === null ? "rosa" : "") + '">' +
      (l.preco !== null ? num(l.preco)
        : typeof l.drop.itemId !== "number" ? "sem id" : "sem preço") + "</td>" +
      '<td style="font-size:14px;font-weight:600" class="' + (l.preco === null ? "off" : "") + '">' +
      (l.preco === null ? "—" : num(l.subtotal)) + "</td></tr>";
  }).join("");

  $("painel").innerHTML =
    '<div class="cabeca-secao" style="margin-bottom:16px"><div>' +
      '<h2 class="secao">' + esc(c.nome) + "</h2>" +
      '<p class="legenda" style="margin:6px 0 0;font-size:13px">' +
      esc((c.tipo === "mvp" ? "Chance por run do MVP" : "Chance por abate") + " · " +
          s.variante.drops.length + " drops · bônus +" + Math.round((mult - 1) * 100) + "%") +
      "</p></div></div>" +

    '<div class="barra-conteudo">' + variantes +
      '<label class="campo">' + (c.tipo === "mvp" ? "Runs em 30 min" : "Abates em 30 min") +
      ' <input type="number" id="ritmo" min="0" step="1" value="' + s.tentativas +
      '" style="width:76px;border-color:#f0b42955;color:var(--ouro)"></label>' +
      // De onde veio este número: medido, digitado, ou o palpite do arquivo.
      '<span class="nota">' + esc(
        daMao ? "ajustado à mão"
          : medido !== null
            ? "medido em " + medido.runs + (medido.runs === 1 ? " gravação" : " gravações")
            : "estimativa"
      ) + "</span>" + notas + "</div>" +

    '<div class="resumo">' +
      '<div><div class="rotulo">' + MOEDA_NOME + ' em 30 min</div>' +
        '<div class="n ' + (s.comPreco > 0 ? "ouro" : "off") + '">' +
        (s.comPreco > 0 ? num(s.valor) : "—") + "</div></div>" +
      '<div class="divisor"></div>' +
      '<div class="sub">' + qtdTexto(s.itens) + " itens / 30 min<br>" +
        (s.comPreco > 0
          ? (s.semPreco > 0
              ? s.semPreco + " drop(s) sem preço" + (s.semId > 0 ? ", " + s.semId + " sem itemId" : "")
              : "todos os drops com preço")
          : s.semId === s.linhas.length
            ? "nenhum drop tem itemId no conteudos-wiki.json"
            : "nenhum drop tem preço coletado") + "</div></div>" +

    '<div class="rolagem"><table><thead><tr>' +
      '<th class="esq">Drop</th><th>Chance final</th><th>Cai em 30 min</th>' +
      "<th>Menor preço</th><th>Subtotal 30 min</th>" +
      "</tr></thead><tbody>" + corpo + "</tbody><tfoot><tr>" +
      '<td class="esq" colspan="4" style="font-family:inherit;font-size:13px;font-weight:600">' +
      MOEDA_NOME + " em 30 min de farm</td>" +
      '<td class="ouro" style="font-size:18px;font-weight:600">' +
      (s.comPreco > 0 ? num(s.valor) : "—") + "</td></tr></tfoot></table></div>" +

    '<button class="voltar" id="voltar">Voltar ao ranking</button>';

  $("ritmo").onchange = function (e) {
    estado.ritmo[c.id] = Math.max(0, Number(e.target.value) || 0);
    desenhar();
  };
  $("voltar").onclick = function () { estado.view = "ranking"; desenhar(); };
  Array.prototype.forEach.call(document.querySelectorAll("[data-var]"), function (b) {
    b.onclick = function () {
      estado.variante[c.id] = b.getAttribute("data-var");
      desenhar();
    };
  });
}

/* --- aba de replay -------------------------------------------------------- */

/** O conteúdo a que este mapa pertence, se alguma gravação já ensinou. */
function conteudoDoMapa(mapa) {
  return CONTEUDOS.filter(function (c) {
    return (c.mapas || []).indexOf(mapa) >= 0;
  })[0] || null;
}

/**
 * Data e hora por extenso: `05/09/2026 16:42`.
 *
 * Sem abreviar por proximidade: numa lista em que se decide o que apagar, "16:42"
 * sozinho não diz de que dia é, e duas gravações do mesmo horário em dias
 * diferentes ficariam idênticas.
 *
 * Gravação sem este campo é de antes de ele existir, e aí não há o que inventar
 * — a linha diz que não sabe.
 */
function quandoTexto(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return (
    d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) +
    " " +
    d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
  );
}

/**
 * Duração em texto curto: "33s", "8min", "1h12".
 */
function duracaoTexto(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const min = Math.round(s / 60);
  if (min < 60) return min + "min";
  return Math.floor(min / 60) + "h" + String(min % 60).padStart(2, "0");
}

/**
 * A impressão digital do arquivo, que impede importar a mesma gravação duas
 * vezes — o que dobraria a amostra sem dobrar o farm.
 *
 * `crypto.subtle` só existe em página segura, e tanto o `localhost` quanto o
 * site em https são. Se faltar, nome e tamanho servem: chave pior, mas melhor
 * que desistir de guardar a run.
 */
async function digitalDo(buffer, nomeArquivo) {
  try {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return Array.prototype.slice.call(new Uint8Array(hash), 0, 16)
      .map(function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
  } catch (e) {
    return nomeArquivo + ":" + buffer.byteLength;
  }
}

async function abrirReplay(arquivo) {
  estado.replayErro = "";

  try {
    const buffer = await arquivo.arrayBuffer();
    const lido = await lerReplay(buffer);
    // O nome e a impressão digital vivem no próprio replay, não no estado: são
    // dele, e assim não há como sobrar o nome de um arquivo com os números de
    // outro depois de uma troca.
    lido.arquivo = arquivo.name;
    lido.id = await digitalDo(buffer, arquivo.name);
    lido.aviso = estado.runsLocais.some(function (r) { return r.id === lido.id; })
      ? "esta gravação já está guardada" : "";
    estado.replay = lido;
    estado.replayConteudo = "";
  } catch (e) {
    estado.replay = null;
    estado.replayErro = e && e.message ? e.message : String(e);
  }
  desenhar();
}

/**
 * Guarda a gravação **no navegador de quem está vendo**, e em nenhum outro
 * lugar.
 *
 * Nada disto passa pela API: o ritmo é de quem jogou, e por isso esta aba
 * funciona inteira com o coletor do Gustavo desligado — no site hospedado
 * inclusive. Quais mapas e monstros pertencem a cada conteúdo é outra coisa, e
 * vem pronta no `conteudos-wiki.json` (§3.5).
 *
 * O preço de guardar aqui: limpar os dados do navegador apaga, e o que foi
 * medido num computador não aparece no outro.
 */
function salvarRun() {
  const r = estado.replay;
  if (!r) return;

  const conteudo = conteudoDoMapa(r.sessao.mapa);
  const conteudoId = conteudo ? conteudo.id : estado.replayConteudo;

  const jaTinha = estado.runsLocais.some(function (x) { return x.id === r.id; });
  if (!jaTinha) {
    estado.runsLocais = runsLocais(estado.runsLocais.concat([{
      id: r.id,
      mapa: r.sessao.mapa,
      duracaoMs: r.janelaMs,
      gravadoEm: r.sessao.gravadoEm,
      // Quando você mandou, que é diferente de quando gravou: dá para subir
      // hoje um replay de mês passado, e na hora de decidir o que apagar o que
      // se lembra é do envio.
      enviadoEm: new Date().toISOString(),
      abates: r.abates,
      conteudoId: conteudoId || null,
    }]));
  }
  r.aviso = jaTinha ? "esta gravação já estava guardada" : "guardada";
  desenhar();
}

function desenharReplay() {
  const r = estado.replay;

  const cabeca =
    '<div class="cabeca-secao" style="margin-bottom:16px"><div>' +
    '<h2 class="secao">Replay</h2>' +
    "</div></div>";

  if (r === null) {
    $("painel").innerHTML = cabeca +
      (estado.replayErro
        ? '<div class="alerta"><strong>NÃO DEU PARA LER.</strong> ' + esc(estado.replayErro) + "</div>"
        : "") +
      '<div class="solta" id="solta">' +
        "<b>Arraste um replay do jogo aqui</b>" +
        '<span>ou <button class="pilula" id="escolher">escolher arquivo</button></span>' +
        '<span class="legenda">Os <code>.rrf</code> ficam na pasta <code>replay</code> do ' +
        "cliente do Hero Saga.</span>" +
        '<input type="file" id="arquivo" accept=".rrf" hidden>' +
      "</div>" +
      desenharRunsGuardadas();

    ligarEscolhaDeArquivo();
    ligarApagar();
    return;
  }

  const conteudo = conteudoDoMapa(r.sessao.mapa);
  const curta = amostraCurta(r.janelaMs);
  const ritmo = porJanela(r.abates, r.janelaMs);
  const deOutros = r.abatesNaTela - r.abates;

  // Reconhecido, o nome do conteúdo já está no título e repetir aqui é ruído.
  // Não reconhecido, esta é a única forma de dizer de onde a gravação é.
  const escolhaDeConteudo = conteudo
    ? ""
    : '<label class="campo">De que conteúdo é? <select id="qual-conteudo">' +
        '<option value="">— escolha —</option>' +
        CONTEUDOS.map(function (c) {
          return '<option value="' + esc(c.id) + '"' +
            (estado.replayConteudo === c.id ? " selected" : "") + ">" + esc(c.nome) + "</option>";
        }).join("") +
      "</select></label>";

  $("painel").innerHTML =
    // O nome do conteúdo manda: `hero_out1` é como o jogo chama o mapa por
    // dentro, e não diz nada a quem está lendo. O mapa técnico continua à
    // vista, na linha de baixo, porque é ele que liga a gravação ao conteúdo —
    // e sem ele não dá para conferir um reconhecimento errado.
    '<div class="cabeca-secao" style="margin-bottom:16px"><div>' +
      '<h2 class="secao">' + esc(conteudo ? conteudo.nome : r.sessao.mapa) + "</h2>" +
      '<p class="legenda" style="margin:6px 0 0;font-size:13px">' +
      esc(r.sessao.jogador + " · " + duracaoTexto(r.sessao.duracaoMs) + " de gravação · " +
          new Date(r.sessao.gravadoEm).toLocaleDateString("pt-BR") +
          (conteudo ? " · " + r.sessao.mapa : "")) + "</p></div></div>" +

    '<div class="barra-conteudo">' + escolhaDeConteudo +
      '<span class="legenda" style="font-family:var(--mono);font-size:11px">' +
      esc(r.arquivo) + "</span>" +
      '<div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      (r.aviso ? '<span class="nota">' + esc(r.aviso) + "</span>" : "") +
      '<button class="pilula" id="outro">trocar arquivo</button>' +
      '<button class="pilula on" id="guardar">guardar este ritmo</button>' +
      "</div></div>" +

    (r.cortada
      ? '<div class="aviso-rodape">A gravação tem ' + esc(duracaoTexto(r.sessao.duracaoMs)) +
        ", e a conta usa só os 30 primeiros minutos — é a janela que o site mede.</div>"
      : curta
        ? '<div class="alerta"><strong>GRAVAÇÃO CURTA.</strong> São ' +
          esc(duracaoTexto(r.janelaMs)) + ", e o ritmo por 30 minutos multiplica isso por " +
          num(porJanela(1, r.janelaMs) || 0) + ". Os abates são medição; o ritmo é " +
          "extrapolação. Para medir farm de verdade, grave os 30 minutos inteiros.</div>"
        : "") +

    '<div class="resumo">' +
      '<div><div class="rotulo">Abates seus</div>' +
        '<div class="n ouro">' + num(r.abates) + "</div></div>" +
      '<div class="divisor"></div>' +
      '<div><div class="rotulo">Abates em 30 min</div>' +
        '<div class="n ' + (curta ? "off" : "ouro") + '">' +
        (ritmo === null ? "—" : num(ritmo)) + "</div></div>" +
      '<div class="divisor"></div>' +
      '<div class="sub">' +
        (deOutros > 0
          ? num(r.abatesNaTela) + " morreram por perto, " + num(deOutros) +
            " no golpe de outra pessoa<br>o ritmo conta só o que foi seu"
          : "todos os monstros que morreram por perto foram seus") +
      "</div></div>" +

    (conteudo
      ? '<div class="aviso-rodape">Guardar faz a aba <strong>' +
        esc(conteudo.nome) + "</strong> passar a calcular os drops sobre " +
        (ritmo === null ? "este ritmo" : num(ritmo) + " abates") +
        " por 30 minutos, no lugar da estimativa. Fica guardado neste navegador.</div>"
      : "") +

    desenharRunsGuardadas();

  $("outro").onclick = function () {
    estado.replay = null;
    estado.replayErro = "";
    desenhar();
  };

  $("guardar").onclick = salvarRun;

  const seletor = $("qual-conteudo");
  if (seletor) {
    seletor.onchange = function (e) { estado.replayConteudo = e.target.value; desenhar(); };
  }
  ligarApagar();
}

function ligarApagar() {
  Array.prototype.forEach.call(document.querySelectorAll("[data-apagar]"), function (b) {
    b.onclick = function () {
      const id = b.getAttribute("data-apagar");
      estado.runsLocais = runsLocais(estado.runsLocais.filter(function (r) {
        return r.id !== id;
      }));
      desenhar();
    };
  });
}

/**
 * As gravações deste navegador, somadas por conteúdo.
 *
 * São as de quem está vendo a página, e de mais ninguém — o ritmo é do
 * personagem e da mão de quem jogou.
 */
function desenharRunsGuardadas() {
  if (estado.runsLocais.length === 0) return "";

  const linhas = CONTEUDOS.concat([{ id: null, nome: "sem conteúdo definido" }])
    .map(function (c) {
      const medido = ritmoMedido(c.id);
      if (medido === null) return "";
      return '<tr><td class="esq nome">' + esc(c.nome) +
        '<span class="sub">' + medido.runs + (medido.runs === 1 ? " gravação" : " gravações") +
        "</span></td>" +
        "<td>" + esc(duracaoTexto(medido.duracaoMs)) + "</td>" +
        "<td>" + num(medido.abates) + "</td>" +
        '<td class="ouro">' + num(medido.porJanela) + "</td></tr>";
    }).join("");

  if (linhas === "") return "";

  return '<div class="cabeca-secao" style="margin:26px 0 10px">' +
    '<h2 class="secao">Ritmo medido</h2></div>' +
    '<div class="rolagem"><table><thead><tr><th class="esq">Conteúdo</th>' +
    "<th>Tempo somado</th><th>Abates</th><th>Abates em 30 min</th>" +
    "</tr></thead><tbody>" + linhas + "</tbody></table></div>" +
    '<div class="aviso-rodape">Cada conteúdo com ritmo medido usa este número no lugar da ' +
    "estimativa. Editar o campo na aba do conteúdo continua valendo mais que os dois. " +
    "Estas gravações ficam guardadas <strong>neste navegador</strong> — limpar os dados do " +
    "site apaga, e o que você mediu aqui não aparece noutro computador.</div>" +
    desenharGravacoes();
}

/**
 * As gravações uma a uma, com o que cada uma mediu e um jeito de tirá-la.
 *
 * Apagar existe porque a média não distingue farm de acidente: a run em que
 * você morreu, ficou parado ou foi socorrer alguém puxa o ritmo para baixo e
 * fica lá para sempre. Sem esta lista, o único jeito de consertar seria limpar
 * os dados do site e perder todas as outras junto.
 */
function desenharGravacoes() {
  const nomeDoConteudo = {};
  CONTEUDOS.forEach(function (c) { nomeDoConteudo[c.id] = c.nome; });

  // Da mais recente para a mais antiga: é a que acabou de entrar que se quer
  // conferir, e eventualmente desfazer.
  const linhas = estado.runsLocais.slice().reverse().map(function (r) {
    const taxa = porJanela(r.abates, r.duracaoMs);
    return '<tr><td class="esq nome">' +
      esc(nomeDoConteudo[r.conteudoId] || "sem conteúdo definido") +
      '<span class="sub">' + esc(r.mapa) + "</span></td>" +
      "<td>" + esc(duracaoTexto(r.duracaoMs)) + "</td>" +
      '<td class="off" style="font-size:12px">' + esc(quandoTexto(r.enviadoEm)) + "</td>" +
      "<td>" + num(r.abates) + "</td>" +
      '<td class="off">' + (taxa === null ? "—" : num(taxa)) + "</td>" +
      '<td style="text-align:right"><button class="pilula" data-apagar="' + esc(r.id) +
      '" title="Tira esta gravação da média">apagar</button></td></tr>';
  }).join("");

  return '<div class="cabeca-secao" style="margin:26px 0 10px">' +
    '<h2 class="secao">Suas gravações</h2></div>' +
    '<div class="rolagem"><table><thead><tr><th class="esq">Conteúdo</th>' +
    "<th>Duração</th><th>Enviada</th><th>Abates</th><th>Em 30 min</th><th></th>" +
    "</tr></thead><tbody>" + linhas + "</tbody></table></div>" +
    '<div class="aviso-rodape">Uma run em que você morreu, ficou parado ou foi socorrer ' +
    "alguém puxa a média para baixo. Apagar tira ela da conta — as outras ficam.</div>";
}

function ligarEscolhaDeArquivo() {
  const campo = $("arquivo");
  const area = $("solta");
  if (!campo || !area) return;

  $("escolher").onclick = function () { campo.click(); };
  campo.onchange = function (e) {
    const arquivo = e.target.files && e.target.files[0];
    if (arquivo) abrirReplay(arquivo);
  };
  area.ondragover = function (e) { e.preventDefault(); area.classList.add("sobre"); };
  area.ondragleave = function () { area.classList.remove("sobre"); };
  area.ondrop = function (e) {
    e.preventDefault();
    area.classList.remove("sobre");
    const arquivo = e.dataTransfer.files && e.dataTransfer.files[0];
    if (arquivo) abrirReplay(arquivo);
  };
}

/** Clicar fora fecha a lista de consumíveis. */
document.addEventListener("pointerdown", function (e) {
  if (!estado.listaAberta) return;
  const caixa = $("menu-cons");
  if (caixa && caixa.contains(e.target)) return;
  estado.listaAberta = false;
  desenhar();
}, true);

/** Sem os conteúdos não há o que desenhar; a API é quem os traz. */
function comecar() {
  estado.runsLocais = runsLocais();
  carregar().then(function () {
    if (CONTEUDOS.length === 0) {
      document.getElementById("painel").innerHTML =
        '<div class="alerta" style="margin-top:26px"><strong>SEM CONTEÚDOS.</strong> ' +
        'A API não devolveu a lista de conteúdos (<code>/v1/wiki</code>). ' +
        'Confira se o <code>conteudos-wiki.json</code> está na pasta do projeto.</div>';
    }
  });
}

comecar();
setInterval(carregar, 30 * 60 * 1000);
