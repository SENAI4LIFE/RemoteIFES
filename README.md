# RemoteIFES

Controle remoto e agendamento de climatização — Campus Guarapari (Edital nº 16/2026).

```
RemoteIFES/
├── remoteifes-server/   # API + banco de dados (Node.js)
└── remoteifes-web/      # Interface web (HTML/CSS/JS)
```

## Rodando localmente

1. **Servidor** (obrigatório primeiro):
   ```bash
   cd remoteifes-server
   npm install
   npm start
   ```
2. **Interface web**: abra `remoteifes-web/index.html` com a extensão **Live Server**
   do VS Code (botão direito → *Open with Live Server*).

Login inicial: **usuário** `admin` · **senha** `admin` (é o administrador do
sistema — troque a senha depois de entrar). O administrador cria os demais
usuários e define o que cada um pode fazer.

Detalhes de instalação, ferramentas e contrato de API estão nos .md de
cada pasta.

## Documentação do projeto

`docs/Projeto_AC.pdf` — proposta submetida ao edital (contexto institucional,
metodologia, planos de trabalho).
