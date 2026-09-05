/**
 * A tela: o que ela sabe, o que ela pede à API e como ela desenha.
 *
 * A conta do bônus de drop mora em `regras.js` — aqui só se usa o resultado.
 * O desenho é innerHTML montado à mão, sem framework: são quatro caixas
 * (`alerta`, `controles`, `abas`, `painel`) e nenhuma delas justifica uma
 * dependência a mais. Todo texto que vem de dado passa por `esc`.
 */

import {
  MOEDA, ASC_POR_NIVEL, RATES, CONSUMIVEIS, PETS, GRADES,
  bonusPet, bonusConsumiveis, multiplicadorDe, taxaFinal,
} from "./regras.js";

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
  moeda: "hero_points",
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
};

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
 * Preços por **itemId**, na moeda pedida. Sem API, fica vazio.
 *
 * Era por nome, e o nome é justamente o que não bate: a wiki escreve em
 * português e o jogo em inglês ("Elunium Enriquecido" lá é "Enriched
 * Elunium"), fora acento e pontuação. O id não tem nenhum desses problemas —
 * e é o que a §3.4 do CLAUDE.md manda usar desde o começo.
 */
async function carregar() {
  try {
    if (CONTEUDOS.length === 0) {
      const wiki = await pegar("/v1/wiki");
      CONTEUDOS = (wiki.data && wiki.data.conteudos) || [];
    }
    const health = await pegar("/v1/health");
    const itens = await pegar("/v1/itens");
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

function precoDe(drop, moeda) {
  // Sem itemId no conteudos-wiki.json não há como ter preço: é o id que liga
  // o drop ao item do jogo.
  if (typeof drop.itemId !== "number") return null;
  const p = estado.precos[drop.itemId];
  const v = p && p[moeda];
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

function ritmoDe(c) {
  const bruto = estado.ritmo[c.id];
  if (bruto === undefined) return c.ritmoPadrao;
  return Math.max(0, Number(bruto) || 0);
}

/**
 * Farm de 30 minutos: cada unidade (abate ou run) é uma tentativa de drop.
 * qtd esperada = taxa final × tentativas; chance de 1+ = 1 − (1−p)^tentativas.
 */
function sessao(c, moeda) {
  const m = mods();
  const variante = varianteDe(c);
  const tentativas = ritmoDe(c);
  let itens = 0, valor = 0, semPreco = 0, comPreco = 0, semId = 0;
  const linhas = [];

  variante.drops.forEach(function (drop) {
    const taxa = taxaFinal(drop.chance, m);
    const p = taxa / 100;
    const qtd = p * tentativas * (drop.qtd || 1);
    const prob = tentativas > 0 ? 1 - Math.pow(1 - p, tentativas) : 0;
    itens += qtd;

    const preco = precoDe(drop, moeda);
    const subtotal = preco === null ? 0 : preco * qtd;
    if (typeof drop.itemId !== "number") semId++;
    if (preco === null) semPreco++; else { comPreco++; valor += subtotal; }

    linhas.push({ drop: drop, taxa: taxa, qtd: qtd, prob: prob, preco: preco, subtotal: subtotal });
  });

  linhas.sort(function (a, b) { return b.subtotal - a.subtotal || b.qtd - a.qtd; });
  return { variante: variante, tentativas: tentativas, linhas: linhas, itens: itens,
           valor: valor, semPreco: semPreco, comPreco: comPreco, semId: semId };
}

/* --- desenho ------------------------------------------------------------- */

const $ = function (id) { return document.getElementById(id); };

function desenhar() {
  const m = mods();
  const mult = multiplicadorDe(m);
  const moeda = estado.moeda;
  const sessoes = CONTEUDOS.map(function (c) { return { c: c, s: sessao(c, moeda) }; });
  const temPreco = sessoes.some(function (x) { return x.s.comPreco > 0; });

  $("sync").textContent = estado.health
    ? horaDe((estado.health.ultimaRodada && (estado.health.ultimaRodada.fim || estado.health.ultimaRodada.inicio)) || null)
    : "nunca";

  $("alerta").innerHTML = temPreco ? "" :
    '<div class="alerta"><strong>SEM PREÇOS.</strong> A API local não respondeu, ou nenhum ' +
    'drop foi coletado ainda — então nada aqui está convertido em ' + esc(MOEDA[moeda]) +
    '. As quantidades por 30 min são reais (chances da wiki × seu bônus), o valor não.</div>';

  desenharControles(m, mult);
  desenharAbas(sessoes);

  if (estado.view === "ranking") desenharRanking(sessoes, temPreco);
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
    }));

  $("abas").innerHTML = abas.map(function (a) {
    return '<button data-aba="' + a.id + '" class="' + (estado.view === a.id ? "ativa" : "") + '">' +
      esc(a.nome) + '<span class="selo">' + a.selo + "</span></button>";
  }).join("");

  Array.prototype.forEach.call(document.querySelectorAll("[data-aba]"), function (b) {
    b.onclick = function () { estado.view = b.getAttribute("data-aba"); desenhar(); };
  });
}

function desenharRanking(sessoes, temPreco) {
  const moedaLabel = MOEDA[estado.moeda];
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
    '<div class="cabeca-secao"><h2 class="secao">Quem rende mais em 30 minutos</h2></div>' +
    '<div class="grade-rank cabeca-rank"><div>#</div><div>Conteúdo</div><div></div>' +
    '<div style="text-align:right">' + esc(temPreco ? moedaLabel + " / 30 min" : "Itens / 30 min") + "</div></div>" + linhas +
    '<div class="aviso-rodape">Abates e runs por 30 min são estimativas editáveis — abra a aba do conteúdo e ajuste para o seu ritmo de farm.</div>';

  Array.prototype.forEach.call(document.querySelectorAll("[data-ir]"), function (b) {
    b.onclick = function () { estado.view = b.getAttribute("data-ir"); desenhar(); };
  });
}

function desenharConteudo(alvo, mult) {
  const c = alvo.c, s = alvo.s;
  const moedaLabel = MOEDA[estado.moeda];

  const moedas = ["hero_points", "zeny", "rmt"].map(function (m) {
    return '<button data-moeda="' + m + '" class="' + (estado.moeda === m ? "on" : "") + '">' +
      MOEDA[m] + "</button>";
  }).join("");

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
      '<td class="esq" style="font-family:inherit;font-size:12.5px;color:var(--fraco)">' +
      (s.tentativas === 0 ? "—"
        : l.prob >= 0.999 ? "praticamente certo"
        : l.prob >= 0.01 ? Math.round(l.prob * 100) + "%"
        : "1 a cada " + num(1 / l.prob) + " sessões") + "</td>" +
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
          s.variante.drops.length + " drops · bônus +" + Math.round((mult - 1) * 100) + "%") + "</p></div>" +
      '<div class="grupo-botoes">' + moedas + "</div></div>" +

    '<div class="barra-conteudo">' + variantes +
      '<label class="campo">' + (c.tipo === "mvp" ? "Runs em 30 min" : "Abates em 30 min") +
      ' <input type="number" id="ritmo" min="0" step="1" value="' + s.tentativas +
      '" style="width:76px;border-color:#f0b42955;color:var(--ouro)"></label>' + notas + "</div>" +

    '<div class="resumo">' +
      '<div><div class="rotulo">' + esc(moedaLabel) + ' em 30 min</div>' +
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
      '<th class="esq">Chance de 1+</th><th>Menor preço</th><th>Subtotal 30 min</th>' +
      "</tr></thead><tbody>" + corpo + "</tbody><tfoot><tr>" +
      '<td class="esq" colspan="5" style="font-family:inherit;font-size:13px;font-weight:600">' +
      esc(moedaLabel) + " em 30 min de farm</td>" +
      '<td class="ouro" style="font-size:18px;font-weight:600">' +
      (s.comPreco > 0 ? num(s.valor) : "—") + "</td></tr></tfoot></table></div>" +

    '<button class="voltar" id="voltar">Voltar ao ranking</button>';

  $("ritmo").onchange = function (e) {
    estado.ritmo[c.id] = Math.max(0, Number(e.target.value) || 0);
    desenhar();
  };
  $("voltar").onclick = function () { estado.view = "ranking"; desenhar(); };
  Array.prototype.forEach.call(document.querySelectorAll("[data-moeda]"), function (b) {
    b.onclick = function () { estado.moeda = b.getAttribute("data-moeda"); desenhar(); };
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-var]"), function (b) {
    b.onclick = function () {
      estado.variante[c.id] = b.getAttribute("data-var");
      desenhar();
    };
  });
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
