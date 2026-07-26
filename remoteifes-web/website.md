# RemoteIFES — Interface Web

HTML + CSS + JavaScript puro. Não precisa de `npm install`.

## Ferramentas necessárias

- **VS Code** com a extensão **Live Server** (Ritwick Dey) — já sugerida em
  `.vscode/extensions.json`.
- O `remoteifes-server` rodando em `http://localhost:8080` (veja o README dele).

## Como rodar

1. Suba o servidor primeiro.
2. Abra esta pasta no VS Code.
3. Instale a extensão Live Server se ainda não tiver (o VS Code sugere
   automaticamente ao abrir a pasta).
4. Botão direito em `index.html` → **Open with Live Server**.
5. Entre com um usuário normal, ou marque **Administrador** e use `admin` / `admin`.

## Navegação

- **Salas** — bloco → andar → lista de salas → painel (ligar/desligar,
  ajustar temperatura). Salas com agendamento ativo agora mostram o selo
  **agendada**; enquanto o agendamento estiver ativo, só quem criou (ou um
  administrador) pode controlar a sala.
- **Agendamentos** — criar/gerenciar horários de ligar/desligar por sala.
- **Admin** (só aparece para administradores) — criar usuários, conceder ou
  revogar permissões, ativar/desativar contas, ver sessões ativas e o log de
  comandos.

## Apontar para outro servidor

Em `js/api.js`:

```js
const SERVER_URL = "http://localhost:8080";
```

Trocar pelo IP da Raspberry Pi quando o servidor for para produção.

## Próximos passos

- Atualizar status automaticamente (`setInterval` ou WebSocket).
- Empacotar com Cordova quando estiver estável.
