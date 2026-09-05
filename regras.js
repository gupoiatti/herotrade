/**
 * Os números do jogo e a conta do bônus de drop.
 *
 * Está separado da tela de propósito: isto aqui é a regra do Hero Saga, e é o
 * que alguém vai querer conferir contra o jogo sem ler uma linha de desenho.
 * Nada neste arquivo toca o DOM ou a API.
 */

/**
 * A moeda do site, e a única.
 *
 * Era uma tabela com Zeny e RMT também. O Gustavo tirou os dois em 05/09/2026:
 * o que interessa para as lojas dele é Hero Points, e o coletor deixou de
 * gravar as outras (ver `MOEDA_COLETADA` no pacote `shared`). Sem duas moedas
 * na mesma tela, some junto o risco que a §7 do CLAUDE.md descreve — ninguém
 * pode somar Hero Points com RMT sem taxa de câmbio se só existe uma coluna.
 */
const MOEDA_NOME = "Hero Points";

/**
 * A mesma moeda, como a API a indexa.
 *
 * `/v1/itens` devolve os preços num objeto por moeda, porque o banco ainda
 * guarda ofertas antigas em RMT que não se apagam (§4.2). Ler por esta chave é
 * o que mantém aquele histórico fora da conta sem mexer nele — e tê-la aqui,
 * junto do rótulo, deixa a página com **um** lugar que diz qual é a moeda.
 */
const MOEDA_CHAVE = "hero_points";
/* --- bônus de drop ------------------------------------------------------- */

/** Ascensão: +4% de chance de drop por nível, até 15 (+60%). */
const ASC_POR_NIVEL = 4;

/** Bonificação por rate (escolha permanente do personagem). */
const RATES = {
  temporada: { nome: "1x Temporada +70% (60% + Lv 275 10%)", drop: 70 },
  "1x": { nome: "1x Normal +50%", drop: 50 },
  "12x": { nome: "12x +37%", drop: 37 },
  "25x": { nome: "25x +25%", drop: 25 },
  "50x": { nome: "50x +12%", drop: 12 },
  "100x": { nome: "100x sem bônus", drop: 0 },
};

/**
 * `grupo: "goma"` = mesmo efeito, não acumulam entre si.
 * O Cálice é Chicle + Lata, então ocupa o grupo da goma e embute a lata.
 */
const CONSUMIVEIS = [
  { id: "goma", nome: "Goma de Mascar", bonus: 100, grupo: "goma",
    descricao: "Taxa de DROP +100%. Dura meia hora." },
  { id: "chicle", nome: "Chicle de Bola", bonus: 200, grupo: "goma",
    descricao: "Taxa de DROP +200%." },
  { id: "calice", nome: "Cálice do Elixir Sagrado II", bonus: 220, grupo: "goma", embuteLata: true,
    descricao: "Conjura Chicle de Bola + Lata de Comida para Gatos (220%)." },
  { id: "lata", nome: "Lata de Comida para Gatos", bonus: 20, grupo: "lata",
    descricao: "Taxa de DROP +20% e EXP +10%. Acumula com outros. Some ao morrer." },
  { id: "pote_drop", nome: "Drop em Pote", bonus: 25, grupo: "pote_drop",
    descricao: "Trocado por pontos de voto. DROPs normais e especiais +25%. Soma com todos." },
  { id: "pote_fusao", nome: "Fusão em Pote", bonus: 25, grupo: "pote_fusao",
    descricao: "Trocado por pontos de voto. DROPs +25% e EXP +25%. Soma com todos." },
  { id: "pocao_doador", nome: "Poção do Doador", bonus: 35, grupo: "doador",
    descricao: "Exclusiva para doadores. Taxa de DROP +35%. Soma com todos." },
];

/** Bônus de drop do pet, por nível de intimidade. */
const PETS = { "0": 0, "70": 20, "90": 30, "140": 35, "150": 50 };

/** A grade aumenta o drop BASE do pet — multiplica, não soma ao total. */
const GRADES = { "0": 0, D: 40, C: 80, B: 100, A: 150 };

function bonusPet(m) { return (PETS[m.pet] || 0) * (1 + (GRADES[m.grade] || 0) / 100); }

function bonusConsumiveis(ids) {
  return CONSUMIVEIS.filter(function (c) { return ids.indexOf(c.id) >= 0; })
    .reduce(function (t, c) { return t + c.bonus; }, 0);
}

/**
 * O Drop Final não soma: incide sobre todo o bônus já acumulado, no fim.
 * 200% acumulado + 5% de Drop Final = 210%.
 */
function multiplicadorDe(m) {
  const acumulado = (m.vip ? (m.valhalla ? 20 : 10) : 0) + RATES[m.rate].drop
    + m.ascensao * ASC_POR_NIVEL + bonusPet(m) + bonusConsumiveis(m.consumiveis);
  return 1 + (acumulado * (1 + m.dropFinal / 100)) / 100;
}

/** Taxa final (rAthena, mob_getdroprate): unidade inteira 1 = 0,01%, teto 90%. */
function taxaFinal(basePct, m) {
  const unidades = Math.round(basePct * 100);
  return Math.min(9000, Math.ceil(unidades * multiplicadorDe(m))) / 100;
}

export {
  MOEDA_NOME, MOEDA_CHAVE, ASC_POR_NIVEL, RATES, CONSUMIVEIS, PETS, GRADES,
  bonusPet, bonusConsumiveis, multiplicadorDe, taxaFinal,
};
