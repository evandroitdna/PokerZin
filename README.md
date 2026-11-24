# Planning Poker do time

Planning Poker em tempo real (Node.js + Socket.IO), com **voto em valor customizado**:
além das cartas do baralho, cada dev pode votar "Outro valor" (ex.: `3` quando só existem 2h e 4h, ou `2,5`).

## Rodar

```
npm install
npm start
```

Abra `http://localhost:3000`, crie a sala e envie o link (`/sala/xxxx`) para o time.
Porta configurável com a variável `PORT`.

Para o time acessar, rode numa máquina/servidor acessível a todos (rede interna, VM, Render, Railway, Azure App Service etc.).
Precisa de suporte a WebSocket e **uma única instância** (as salas ficam em memória).

## Deploy no Render (grátis)

1. Suba este projeto para um repositório no GitHub.
2. No Render: **New → Blueprint**, escolha o repositório. O `render.yaml` já define tudo
   (Node, `npm install`, `npm start`, health check em `/healthz`, plano free).
3. Ao terminar, o Render dá uma URL `https://planning-poker-xxxx.onrender.com` — é só mandar para o time.

Cada `git push` na branch principal faz um novo deploy automaticamente.

**Sobre o plano free:** o serviço "dorme" após ~15 min sem acesso. O primeiro acesso depois disso
demora ~1 min para acordar, e salas antigas somem (estão em memória). Na prática: abra o link
uns minutos antes da planning. Para ficar sempre ligado, troque `plan: free` por `plan: starter` (pago).

## Funcionalidades

- Baralhos prontos: Horas (0,5 a 40h), Fibonacci, Fibonacci modificado, Camiseta, ou cartas personalizadas
- Carta "Outro valor" para votar qualquer número (pode ser desligada nas configurações da sala)
- Votos ocultos até alguém clicar em **Revelar cartas**; contador de quem já votou
- Resultado com média, mínimo/máximo, distribuição dos votos e indicação de consenso
- Estimativa final editável → salva no histórico com os votos de cada um; total de horas da sessão
- Exportar histórico em CSV (abre no Excel)
- Modo espectador (PO / Scrum Master que não vota)
- Facilitador 👑 (primeiro a entrar): edita cartas/unidade, transfere o papel e remove participantes
- Reconexão: se a página cair/recarregar, o participante mantém o lugar e o voto por 1 minuto

## Limitações

- Salas e histórico ficam em memória: reiniciar o servidor apaga tudo (exporte o CSV ao fim da sessão).
- Salas vazias são removidas após 12h.
