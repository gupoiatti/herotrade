/**
 * A regra do arquivo de replay do jogo (`.rrf`) — onde você farmou e quantos
 * monstros matou.
 *
 * Está separado da tela pelo mesmo motivo que o `regras.js`: aquele guarda a
 * regra do Hero Saga, este a regra do arquivo, e nenhum dos dois toca o DOM ou
 * a API. Aqui entra um `ArrayBuffer` e sai o mapa, a duração e a contagem de
 * abates — este arquivo não sabe o que é preço, conteúdo, nem HeroTrade.
 *
 * **O replay não diz o que dropou, e não é para dizer.** Ele mede o *ritmo*:
 * quantos monstros morreram na sua mão e em quanto tempo. O que cada um larga é
 * conta do site — chance da wiki × o seu bônus de drop —, e essa conta é melhor
 * que a amostra de uma run: numa gravação de meia hora um item de 1% cai ou não
 * cai por sorte, enquanto a chance vezes o número de abates não depende do dia
 * que você teve.
 *
 * **Roda no navegador de quem abre a página.** O `.rrf` é lido do disco pelo
 * próprio JavaScript e não sobe para lugar nenhum: esta é a única parte do
 * HeroTrade que funciona com a máquina do Gustavo desligada.
 */

/**
 * A janela que o site mede: meia hora.
 *
 * Gravação **mais longa que isso é cortada aqui** — contam os 30 primeiros
 * minutos e mais nada. É o que torna duas gravações comparáveis sem depender
 * de quem parou de gravar antes: uma sessão de duas horas não vira um ritmo
 * maior, vira a mesma meia hora medida com mais calma.
 */
export const JANELA_MS = 30 * 60_000;

/**
 * O quanto do fim da gravação se ignora ao contar abates.
 *
 * Um monstro que morre nos últimos instantes pode ter a morte gravada e o golpe
 * não — o arquivo termina no meio. Sem margem, esses viram "morreu sem ninguém
 * bater" e somem da conta. Dois segundos cobrem isso sem comer farm real.
 */
const MARGEM_FIM_MS = 2_000;

/**
 * Quem matou cada coisa: o último a bater nela antes de ela sumir.
 *
 * A heurística erra em dois casos conhecidos — monstro que morre de veneno ou
 * se explodindo, sem golpe registrado, não conta para ninguém; e o golpe final
 * de outro jogador num monstro que **você** quase matou conta para ele. Nos
 * dois a contagem erra **para baixo**, que é o lado certo de errar: ritmo
 * inflado viraria lucro inflado na tela.
 */
function ultimoAtacantePorAlvo(danos) {
  const ultimo = new Map();

  for (const d of danos) {
    const antes = ultimo.get(d.target);
    // `>=` porque golpe simultâneo no mesmo instante existe, e aí vale o que
    // veio por último no fluxo de pacotes.
    if (antes === undefined || d.time >= antes.time) {
      ultimo.set(d.target, { time: d.time, source: d.source });
    }
  }

  return ultimo;
}

/**
 * Lê um replay.
 *
 * É `async` por um motivo de peso, não de gosto: a biblioteca que decodifica o
 * `.rrf` tem 30 KB e só serve a esta aba. Carregada aqui dentro, ela é baixada
 * quando alguém de fato abre uma gravação — quem entra no site para ver preço
 * não paga por ela.
 *
 * `duracaoMs` sai do próprio arquivo, e é o que transforma "matei tanto" em
 * "tanto por 30 minutos" — sem ele, a run de 8 minutos e a de 2 horas
 * pareceriam igualmente boas.
 *
 * `gravadoEm` sai do cabeçalho, não do relógio de agora. É o que separa "farmei
 * isto ontem" de "importei isto hoje" — e, como a lista de runs só acumula para
 * frente, a data que não for guardada agora não volta.
 *
 * @param {ArrayBuffer} buffer o `.rrf` cru
 * @returns {Promise<{sessao: {jogador: string, mapa: string, duracaoMs: number, gravadoEm: string},
 *            janelaMs: number, cortada: boolean, abates: number, abatesNaTela: number,
 *            monstros: Array<{nome: string, quantos: number}>}>}
 */
export async function lerReplay(buffer) {
  const { decodeReplay } = await import("./rrfparser.js");

  let replay;
  try {
    replay = decodeReplay(buffer);
  } catch (causa) {
    // Arquivo trocado é o erro mais provável de todos, e "Cannot read
    // properties of undefined" não ajuda ninguém a descobrir isso.
    throw new Error(
      `Não parece um replay do Ragnarok (.rrf). Causa: ${String(causa && causa.message ? causa.message : causa)}`,
    );
  }

  const eu = replay.sessionInfo.aid;
  const ultimo = ultimoAtacantePorAlvo(replay.damage);

  // Passou de meia hora, corta na meia hora — e aí não há margem a tirar,
  // porque a gravação continua depois do corte e nenhum golpe ficou de fora.
  // Não passou, vale a gravação inteira menos a margem do fim.
  const duracaoMs = replay.sessionInfo.durationMs;
  const cortada = duracaoMs > JANELA_MS;
  const janelaMs = cortada ? JANELA_MS : duracaoMs;
  const limite = cortada ? JANELA_MS : duracaoMs - MARGEM_FIM_MS;

  let abates = 0;
  let abatesNaTela = 0;
  const porNome = new Map();

  for (const morte of replay.kills) {
    const alvo = replay.entities.get(morte.aid);
    // Só monstro conta. Numa cidade morrem jogadores e somem NPCs o tempo
    // todo, e contar isso daria um ritmo de farm que nunca aconteceu.
    if (alvo === undefined || alvo.kind !== "mob") continue;
    // Fora da janela nada conta — nem para você, nem para o total da tela.
    // Contar o total inteiro faria a gravação cortada parecer que você perdeu
    // abates para os outros.
    if (morte.time > limite) continue;

    abatesNaTela++;

    const golpe = ultimo.get(morte.aid);
    if (golpe === undefined || golpe.source !== eu) continue;

    abates++;
    const nome = alvo.name || `monstro ${alvo.view}`;
    porNome.set(nome, (porNome.get(nome) ?? 0) + 1);
  }

  return {
    sessao: {
      jogador: replay.sessionInfo.player,
      mapa: replay.sessionInfo.map,
      duracaoMs: duracaoMs,
      gravadoEm: new Date(replay.sessionInfo.recordedAt).toISOString(),
    },
    /**
     * O tempo que de fato entrou na conta: a gravação, ou meia hora quando ela
     * passa disso. É por este número que se divide, e não pela duração — senão
     * uma gravação de duas horas mostraria o ritmo de meia hora diluído em
     * quatro.
     */
    janelaMs: janelaMs,
    /** `true` quando a gravação foi maior que a janela e sobrou de fora. */
    cortada: cortada,
    abates: abates,
    /**
     * Todo monstro que morreu por perto, seu ou não.
     *
     * Existe para a tela poder dizer "51 morreram, 37 foram seus" quando você
     * farma em grupo — sem isso, a diferença entre a contagem e o que se viu na
     * tela pareceria erro do programa.
     */
    abatesNaTela: abatesNaTela,
    monstros: [...porNome.entries()]
      .map(function (e) { return { nome: e[0], quantos: e[1] }; })
      .sort(function (a, b) { return b.quantos - a.quantos || a.nome.localeCompare(b.nome); }),
  };
}

/**
 * O ritmo na unidade do site: por 30 minutos.
 *
 * Fica aqui, e não na tela, porque é a regra que transforma uma gravação de
 * duração qualquer no mesmo número que as abas de conteúdo já usam. Numa
 * gravação de meia hora ou mais o resultado é a própria contagem, sem conta
 * nenhuma no meio.
 */
export function porJanela(valor, duracaoMs) {
  if (!(duracaoMs > 0)) return null;
  return (valor * JANELA_MS) / duracaoMs;
}

/**
 * Abaixo disto, o ritmo é extrapolação, não medida.
 *
 * Meio minuto multiplicado por sessenta não mede farm: um instante de sorte
 * vira taxa. O número continua aparecendo — esconder também engana, e quem
 * gravou sabe o que gravou —, mas a tela é obrigada a dizer de onde ele veio.
 */
const AMOSTRA_CONFIAVEL_MS = 10 * 60_000;

export function amostraCurta(duracaoMs) {
  return duracaoMs < AMOSTRA_CONFIAVEL_MS;
}
