import type { LegalDocument } from "./types";

export const privacyPtBR: LegalDocument = {
  title: "Política de privacidade",
  summary: "O que coletamos, o que os agentes enviam e para onde, quem pode ver o seu workspace e os seus direitos.",
  updated: "2026-11-20",
  sections: [
    {
      id: "overview",
      heading: "1. Visão geral",
      blocks: [
        'A AGENTESCHAT, LLC, sociedade de responsabilidade limitada do estado de Delaware (EUA) que atua sob o nome agentes.chat ("agentes.chat", "nós"), opera o agentes.chat: um workspace onde pessoas e agentes de IA trabalham juntos, disponível na web, como app de Mac e como app de celular (o "Serviço"). Esta política distingue três papéis:',
        {
          list: [
            "Para os **dados de conta**, as informações que as pessoas nos dão para criar e usar uma conta, somos o controlador.",
            "Para o **Conteúdo do Workspace**, tudo o que as pessoas e os agentes de um workspace colocam ou produzem nele, somos operador e agimos conforme as instruções do workspace. O workspace é o controlador, ou seja, a pessoa ou entidade que o criou ou em nome de quem ele foi criado.",
            "Nos poucos casos da Seção 6 em que agimos por conta própria (confiança e segurança, a segurança do Serviço e o que a lei exige de nós), somos o controlador dos dados pessoais no Conteúdo do Workspace que lemos para isso.",
          ],
        },
      ],
    },
    {
      id: "data-we-collect",
      heading: "2. Dados que coletamos como controlador",
      blocks: [
        {
          list: [
            "**Dados de conta:** nome, e-mail, hash da senha, foto de perfil, idioma e fuso horário. Se você entra com Google, Apple ou GitHub, recebemos desse provedor o seu nome, e-mail e o identificador da conta, nunca a senha.",
            "**Dados do workspace:** nome do workspace, membros, cargos e convites.",
            "**Pedidos de suporte:** o que você nos envia quando pede ajuda: as suas palavras, o item que você reportou e o que ele diz, a tela em que você estava e as imagens ou o vídeo que você anexar.",
            "**Dados de cobrança:** num workspace com plano do agentes.chat, o nome, o e-mail, o endereço de cobrança e o número de identificação fiscal de quem paga, o plano e as faturas e os pagamentos dele. Os pagamentos são processados pelo Stripe, que cuida dos dados do cartão: eles nunca chegam até nós.",
            "**Dados de uso e registros:** endereços IP, navegador e aparelho, sessões de login, eventos de segurança, requisições à API e o registro de cada chamada de modelo (modelo, tokens e custo, com o workspace e o agente a que pertence), que guardamos para aplicar orçamentos e mostrar o uso. Quando algo quebra, registramos o erro, sem o conteúdo das mensagens, para corrigi-lo. Também guardamos um registro de cada vez que a nossa equipe ou um assistente de IA que trabalha para ela leu Conteúdo do Workspace com as ferramentas ou o console que a Seção 6 descreve: quem ou o que leu, qual item, quando e por quê, nunca o conteúdo em si.",
            "**Aparelhos:** no app de celular, o token de notificações de cada aparelho em que você entra. Em computadores conectados e no app de Mac, o nome do computador, o sistema operacional e a versão do app.",
            "**Lista de espera:** o e-mail e o idioma que você informa no agentes.chat, e se você confirmou o e-mail.",
            "**Análise do site:** no agentes.chat (o site público, não o workspace), as páginas vistas, o site de origem, o tipo de aparelho e uma localização aproximada derivada do IP, coletados com a Himetrica.",
          ],
        },
      ],
    },
    {
      id: "how-we-use",
      heading: "3. Como usamos os dados de conta",
      blocks: [
        "Para fornecer e proteger o Serviço (inclusive detectar e impedir abusos), cobrar pelos planos do agentes.chat, aplicar orçamentos e limites, responder a pedidos de suporte, cumprir obrigações legais e enviar mensagens do serviço, como confirmação de e-mail, convites, troca de senha, pedidos de aprovação e as notificações que você ativou. Para a lista de espera, só escrevemos para confirmar o e-mail e para convidar você.",
        "Para responder a pedidos de suporte e para analisar falhas e suspeitas de abuso, usamos assistentes de IA que trabalham para a nossa equipe. Eles pensam com modelos Claude. Quem fornece esses modelos é a Anthropic, que faz o Claude: os assistentes chegam a ela pela API dela, sob os termos comerciais dela, que não permitem que ela treine os modelos dela com o que recebe. Eles leem registros de conta e de uso: identificadores, estados e horários, o texto de erros que os nossos sistemas registraram (com credenciais e endereços mascarados) e um nome quando um caso exige. Eles podem pesquisar um erro desses na web. Uma pessoa da nossa equipe também pode analisar um caso com uma ferramenta de IA que ela mesma usa, que também pensa com modelos Claude: essa ferramenta recebe o que a pessoa lê, e isso pode incluir o endereço de e-mail de uma pessoa.",
        "Quando um workspace é criado, verificamos o cadastro contra abuso: o domínio do e-mail vai ao registro do domínio, a rede do primeiro login (nunca o endereço) à Team Cymru e o nome do workspace à TypeSafe. Nas páginas de cadastro e de login, uma verificação contra robôs feita pelo nosso provedor de rede lê sinais do seu navegador.",
        "Não vendemos dados pessoais, não usamos o Conteúdo do Workspace para treinar modelos de aprendizado de máquina e não permitimos que os nossos suboperadores façam isso.",
      ],
    },
    {
      id: "workspace-content",
      heading: "4. Conteúdo do Workspace, tratado em nome dos workspaces",
      blocks: [
        "O Conteúdo do Workspace inclui mensagens em canais, threads e mensagens diretas, arquivos do Drive e páginas da wiki. Inclui também tarefas, rotinas, eventos do calendário e aprovações, as instruções, configurações e a memória dos agentes, o que os agentes escrevem e fazem, e os dados que os agentes leem pelos conectores, bancos de dados e computadores que o workspace conecta. Nós o tratamos só para fazer funcionar o workspace e os agentes como o workspace os configurou, mostrá-lo aos membros do workspace, enviar as notificações que eles pedem, prestar suporte, manter o Serviço funcionando e seguro e para os casos da Seção 6 em que agimos por conta própria.",
        "O Conteúdo do Workspace pertence ao workspace: os membros veem o que os canais e as permissões dele permitem, e os donos e administradores dele o gerenciam. Os donos e administradores do workspace veem todos os canais, tarefas e páginas da wiki, inclusive os privados. Eles não leem mensagens diretas entre outras pessoas. As mensagens que você escreveu continuam no workspace depois que você sai dele ou exclui a sua conta, a não ser que o workspace as apague.",
      ],
    },
    {
      id: "agents",
      heading: "5. Como os agentes tratam o Conteúdo do Workspace",
      blocks: [
        "Agentes são modelos de IA que leem e agem dentro do workspace. O Conteúdo do Workspace sai dos nossos servidores nos casos abaixo. As empresas que o tratam para nós estão listadas na Seção 9.",
        {
          list: [
            "**Entre os aparelhos e os nossos servidores.** Tudo o que trafega entre os nossos servidores e os navegadores, apps e computadores que se conectam a eles, inclusive o Conteúdo do Workspace, passa pelo nosso provedor de rede, que protege o Serviço contra ataques. Para isso, o provedor de rede decifra esse tráfego no data center dele mais próximo de cada aparelho, e o trata em nosso nome.",
            "**Para responder.** Quando um agente trabalha, ele envia o contexto de que precisa (o contexto do workspace, as instruções do agente, a conversa, a memória relevante e os resultados das ferramentas) ao provedor de modelo escolhido para esse agente. Com uma chave de API que o workspace adicionou, a chamada é feita na conta do próprio workspace e sob o contrato dele com esse provedor. Alguns provedores repassam a chamada à empresa que faz ou hospeda o modelo, que também a trata sob os termos desse provedor. Com um plano de IA, como o do Claude ou o do ChatGPT, conectado a um agente, o agente trabalha na conta da pessoa que conectou o plano e sob os termos do provedor.",
            "**Para decidir quem responde.** Um modelo de roteamento lê a mensagem nova, os nomes e funções dos agentes do workspace e a conversa recente para decidir qual agente deve responder, se algum. Ele roda na TypeSafe ou, como alternativa, no provedor de modelo do workspace. O roteamento nunca dá permissão nenhuma a um agente.",
            "**Memória.** Os agentes guardam memória das conversas (resumos, fatos e lições) para melhorar com o tempo. Algumas avaliações sobre a memória (se algo vale ser guardado, ou se contradiz o que o agente já sabe) são feitas pela TypeSafe. A memória pode ser vista e apagada na página do agente, e é apagada junto com o workspace.",
            "**Busca.** Para encontrar mensagens e documentos relacionados, o texto pode ser transformado em vetores (embeddings) pela DeepInfra, Inc.",
            "**Conectores.** Quando o workspace conecta um serviço (como GitHub, Google, Linear, Sentry, uma caixa de e-mail ou qualquer servidor MCP), guardamos os tokens de acesso cifrados e lemos ou escrevemos nesse serviço só dentro dos escopos que o workspace deu a cada agente. O serviço conectado trata esses dados sob os próprios termos. Conexões com caixas do Gmail e do Outlook, e com Google Drive, Google Agenda, Google Planilhas, Google Docs, Slack, Microsoft Teams, OneDrive, HubSpot, Salesforce, Zendesk, Asana, Figma, Intercom, Dropbox, Square, Instagram, Facebook, LinkedIn, YouTube, Pinterest, Reddit e WhatsApp, passam pela Composio, que trata o que os agentes leem e escrevem nesses serviços.",
            "**Bancos de dados.** Conexões com bancos de dados são só de leitura. As credenciais ficam cifradas e cada consulta é verificada antes de rodar.",
            "**Computadores conectados.** Quando alguém conecta um computador, os agentes podem rodar comandos e usar um navegador nele, dentro das pastas e permissões definidas nesse computador. A visão ao vivo do navegador de um agente passa pelo nosso provedor de rede e pela memória dos nossos servidores, e não é gravada. Um resumo dos passos que o agente deu (como os endereços visitados e as ações) fica junto do trabalho dele, para a equipe ver o que ele fez.",
            "**O computador do workspace.** Na agentes.chat Cloud, os agentes de um workspace trabalham num computador que mantemos para esse workspace, nos nossos servidores ou nos de um provedor de hospedagem, na União Europeia ou nos Estados Unidos. Contamos o volume de dados que o navegador, as ferramentas de IA e os outros programas de cada agente enviam e recebem nele, por dia. O tráfego dos navegadores e dos programas dos agentes sai dali por endereços que alugamos de um provedor de proxy, que o transporta. O computador é apagado depois que o plano do agentes.chat do workspace termina, como os Termos de uso descrevem.",
            "**Suporte, falhas e segurança.** Quando analisamos um pedido de suporte, uma falha ou uma suspeita de abuso (Seção 6), um assistente de IA que trabalha para a nossa equipe pode ler o item em questão. Esse item é então enviado ao provedor de modelo do assistente, a empresa que faz o Claude, que o trata nos Estados Unidos e, quando encaminha um pedido para lá, em outros países, sob o nosso contrato comercial com ela: ela não pode usá-lo para treinar modelos e o apaga em até 30 dias, exceto o que as verificações de abuso dela sinalizarem, que ela pode guardar por até dois anos. Quando uma pessoa da nossa equipe lê o item com uma ferramenta de IA que ela mesma usa, ele vai ao mesmo provedor por essa ferramenta.",
            "**Armazenamento, e-mail e notificações.** Os arquivos enviados e os backups ficam nos nossos provedores de armazenamento. Os e-mails e as notificações no celular que citam uma mensagem passam pelo nosso provedor de e-mail e pela Apple e pelo Google. Um pedido de suporte que você nos envia, com o que você anexar, chega à nossa equipe por e-mail.",
            "**Verificações de abuso.** Um avaliador automático que roda na TypeSafe lê uma amostra do que os agentes fizeram. Guardamos só o veredito.",
            "**Outros serviços de IA que oferecemos.** A TypeSafe também avalia se uma ação de um agente deve esperar por uma pessoa, escolhe um modelo ou ferramentas para uma tarefa e lê o texto ou a imagem de uma tela para achar onde clicar quando um agente usa um computador.",
            "**Busca na web.** Quando um agente busca na web, as palavras da busca vão a um buscador: o DuckDuckGo a partir dos nossos servidores, ou o que o agente abrir no próprio navegador. Quando ele abre uma página, o site vê o endereço pedido, como o de qualquer visitante.",
            "**GIFs.** Quando um agente ou uma pessoa busca um GIF, as palavras da busca vão ao provedor de GIFs, a GIPHY.",
          ],
        },
        "Ações difíceis de desfazer (como fazer merge de código, publicar ou enviar em nome de alguém) viram um pedido de aprovação para uma pessoa antes de acontecer, a não ser que o workspace tenha configurado esse agente para agir sem perguntar. Texto que vem de fora do workspace (páginas da web, e-mails, arquivos) é marcado como não confiável antes de um agente ler.",
      ],
    },
    {
      id: "staff-access",
      heading: "6. Quando a equipe do agentes.chat pode ver o Conteúdo do Workspace",
      blocks: [
        "Nós não navegamos pelos workspaces. Fora do funcionamento do seu workspace, descrito nas Seções 4 e 5, a nossa equipe e os assistentes de IA que trabalham para ela só leem o Conteúdo do Workspace:",
        {
          list: [
            "**A seu pedido,** para ajudar num pedido de suporte que um membro do seu workspace nos enviou: pelo app, pelo e-mail da conta dele ou por outro meio, quando confirmamos que o pedido é dele. Lemos aquilo de que o pedido trata e nada além do que o membro que pediu consegue ver. Quando o nosso assistente de IA responde, ele responde só no endereço da conta desse membro. Para isso, uma mensagem direta só é lida quando alguém daquela conversa pediu.",
            "**Para corrigir uma falha,** quando algo no Serviço falhou ou travou, como o trabalho de um agente que terminou em erro ou parou de avançar. Lemos aquilo de que a falha trata, e nunca uma mensagem direta.",
            "**Por confiança e segurança,** para detectar e investigar suspeita de abuso, fraude, conteúdo ilegal ou ameaça à segurança do Serviço ou de outras pessoas, ou para fazer cumprir os nossos Termos de uso. Podemos fazer isso sem avisar o workspace na hora. Se restringirmos um workspace ou uma conta, dizemos por quê e como contestar, a não ser que uma ordem de uma autoridade nos proíba de dizer. Para isso, numa conversa direta lemos só o que foi dito a um agente ou por um agente, nunca mensagens entre pessoas, a não ser que alguém daquela conversa as tenha denunciado ou que a lei exija.",
            "**Quando a lei exige.**",
          ],
        },
        "A seu pedido e para corrigir uma falha, agimos conforme as instruções do workspace. Por confiança e segurança, nos apoiamos no nosso legítimo interesse em manter o Serviço e as outras pessoas seguros (art. 7º, IX, da LGPD e art. 6(1)(f) do GDPR) e, quando a lei exige, nessa obrigação legal. Você pode se opor como descrevem as Seções 11 e 12.",
        "A nossa equipe e os assistentes de IA que trabalham para ela leem com ferramentas que entregam um item de cada vez. Cada leitura feita com essas ferramentas é feita por um desses motivos e é registrada antes de acontecer: quem ou o que leu, qual item, quando e por quê. As pessoas que administram o agentes.chat recebem esses registros toda manhã. Uma leitura do que o seu workspace escreveu, feita com essas ferramentas a seu pedido ou para corrigir uma falha, também aparece no registro de auditoria do seu workspace: o item, qual desses motivos e, quando foi a pedido, de quem (no caso de uma mensagem direta, só que houve a leitura e a pedido de quem). Uma leitura feita com elas por confiança e segurança é anotada ali quando a investigação termina e, no máximo, sete dias depois da leitura, a não ser que a lei nos proíba de dizer. Quando essas ferramentas entregam um nome ou o texto de um erro dos registros de conta e de uso que a Seção 3 descreve, essa leitura fica registrada só do nosso lado. Uma pessoa da nossa equipe também pode abrir, no nosso console de operação e por um motivo registrado, o que as nossas verificações de abuso avaliaram num workspace. Essa leitura fica registrada do nosso lado.",
        "As pessoas que operam a nossa infraestrutura, e as ferramentas com que a operam, conseguem chegar aos servidores e bancos de dados que guardam o Conteúdo do Workspace. Elas usam esse acesso só para manter o Serviço funcionando, como restaurar backups, ou para cumprir uma obrigação legal. Nenhum desses caminhos é usado para criar perfis, publicidade ou dados de treino.",
      ],
    },
    {
      id: "retention",
      heading: "7. Retenção",
      blocks: [
        {
          list: [
            "**Dados de conta:** enquanto a conta existir. Quando você exclui a sua conta no app, ela sai de todos os aparelhos na hora e é apagada 7 dias depois, a não ser que você a restaure antes disso, e sai dos nossos backups em até 30 dias depois disso, exceto registros que a lei nos obriga a manter. Qualquer workspace em que você era o único membro fecha no mesmo momento, e o conteúdo dele é apagado 7 dias depois, como descrito a seguir. Os workspaces em que você esteve guardam o seu nome e o seu e-mail nos registros de auditoria deles enquanto cada um existir.",
            "**Conteúdo do Workspace:** enquanto o workspace existir, e antes disso quando o workspace apaga um conteúdo. Quando o plano do agentes.chat de um workspace termina, o conteúdo dele fica disponível por 90 dias e depois é apagado. Quando um dono exclui um workspace, ele fecha para todos na hora e o conteúdo dele é apagado 7 dias depois, a não ser que um dono o restaure antes disso, e sai dos nossos backups em até 30 dias depois disso, exceto o conteúdo que a lei nos obriga a manter ou que é registro de abuso (abaixo), e exceto os trechos que lemos para suporte ou para uma investigação, que seguem a linha própria abaixo.",
            "**Registros:** registros de requisições e de segurança por até 90 dias. Registros de uso de modelos (tokens e custo) enquanto o workspace existir, porque os orçamentos e os relatórios de uso dependem deles.",
            "**Pedidos de suporte:** o que você nos enviou ao pedir ajuda, por 90 dias. O e-mail em que o pedido chegou fica na caixa de correio da nossa equipe por 90 dias. Imagens e vídeo, por 30 dias (sem contar a cópia dentro desse e-mail).",
            "**Suporte e investigações:** o que lemos para responder a um pedido de suporte ou para analisar uma falha ou suspeita de abuso, e qualquer cópia disso na nossa conversa de trabalho, por até 90 dias depois da leitura, mesmo que o workspace apague antes, a não ser que seja registro de abuso (abaixo). A nossa conclusão sobre um caso, que não contém nada do conteúdo, fica no registro do caso. O nosso registro de cada leitura feita com as ferramentas que a Seção 6 descreve (quem, quando, qual item e por quê, nunca o conteúdo) por um ano.",
            "**Dados de cobrança:** enquanto você paga por um workspace e, depois disso, pelo tempo que as leis fiscais e contábeis exigirem.",
            "**Lista de espera:** até você ser convidado e por mais 12 meses, ou até você pedir para sair.",
            "**Contas que suspendemos ou encerramos por abuso:** podemos manter os registros da conta e do abuso além desses prazos, inclusive depois de um pedido de exclusão, pelo tempo necessário para exercer ou defender direitos, cumprir obrigações legais e impedir que as mesmas pessoas abusem do Serviço de novo, com base nos artigos 7º, VI e IX, e 16, I, da LGPD e no artigo 17(3)(b) e (e) e no artigo 6(1)(f) do GDPR.",
          ],
        },
      ],
    },
    {
      id: "security",
      heading: "8. Segurança",
      blocks: [
        "Os dados são cifrados em trânsito (TLS). Chaves de provedores de modelo, tokens de conectores e credenciais de bancos de dados são cifrados com criptografia de envelope por workspace e nunca voltam para o navegador nem para os apps. Os computadores dos workspaces nos servidores que nós mesmos operamos, e os backups dos arquivos deles, são cifrados em repouso. O acesso aos sistemas de produção é restrito e registrado. Se soubermos de um incidente com dados pessoais, avisaremos os workspaces afetados sem demora injustificada e dentro dos prazos que a LGPD e o GDPR exigem.",
      ],
    },
    {
      id: "transfers",
      heading: "9. Transferências internacionais",
      blocks: [
        "A nossa aplicação e o banco de dados rodam nos Estados Unidos, e os provedores citados nesta política tratam dados nos Estados Unidos, exceto os provedores de modelo e os serviços conectados que um workspace escolhe, e as empresas para as quais eles repassam chamadas, que podem tratar dados em outros países sob os seus próprios termos, e exceto o DuckDuckGo, a GIPHY, a DeepInfra, Inc., a Team Cymru, o registro do domínio de um e-mail, o nosso provedor de proxy, o serviço de notificações do fabricante do seu navegador e os nossos provedores de armazenamento, cuja localização não informamos. O provedor de modelo dos nossos assistentes de IA (Seção 5) trata dados nos Estados Unidos e, quando encaminha um pedido para lá, em outros países. Os computadores dos workspaces rodam nos Estados Unidos e na União Europeia. O nosso provedor de rede trata o tráfego no data center dele mais próximo de cada aparelho, nos Estados Unidos ou em outro país.",
        "**Suboperadores.** Estas empresas tratam o Conteúdo do Workspace para nós:",
        {
          list: [
            "**O nosso provedor de rede:** rede e proteção contra ataques. Local: Estados Unidos e o data center dele mais próximo de cada aparelho.",
            "**Os nossos provedores de hospedagem:** hospedagem da aplicação e do banco de dados, e dos computadores dos workspaces. Local: Estados Unidos para a aplicação e o banco de dados, Estados Unidos e União Europeia para os computadores dos workspaces.",
            "**Os nossos provedores de armazenamento de arquivos e de backups:** armazenamento dos arquivos enviados e dos backups do banco de dados, e backups cifrados dos computadores dos workspaces.",
            "**MillionSend, um serviço da CODARI GLOBAL, LLC:** envio e recebimento de e-mail, e as caixas de correio da nossa equipe, onde chegam os pedidos de suporte. Local: Estados Unidos.",
            "**TypeSafe:** serviços de IA que oferecemos: escolher qual agente responde, avaliar memórias e ações, ler uma tela, verificações de abuso. Local: Estados Unidos.",
            "**DeepInfra, Inc.:** busca (vetores de texto).",
            "**Composio:** conexões com os serviços listados na Seção 5. Local: Estados Unidos.",
            "**Apple Inc., Google LLC e o serviço de notificações do fabricante do seu navegador:** entrega de notificações. Local: Estados Unidos para a Apple e o Google.",
            "**Modelos de IA (Claude):** quem os fornece é a Anthropic, que faz o Claude, para os assistentes de IA de suporte, falhas e segurança e para as ferramentas de IA que a nossa equipe usa. Pelo nosso contrato comercial, ela não pode treinar com o que os assistentes enviam. Local: Estados Unidos, e outros países quando ela encaminha um pedido para lá.",
          ],
        },
        "Os provedores de modelo e os serviços que o seu workspace conecta com a própria chave, plano ou conta trabalham sob o seu próprio contrato com eles e não entram nesta lista. Mantemos esta lista atualizada e avisamos os clientes que têm um DPA assinado sobre mudanças de suboperadores antes de elas entrarem em vigor. A lista completa das empresas, que também traz o nome do nosso provedor de rede e dos nossos provedores de hospedagem e de armazenamento, está disponível a pedido em legal@agentes.chat, junto com o Acordo de Tratamento de Dados (Seção 13).",
        "**Transferência internacional de dados.** Os dados são transferidos de forma contínua, enquanto o workspace ou a conta existir, para prestar o Serviço. Para os dados de conta e para o que lemos por conta própria (Seção 6), o controlador é a AGENTESCHAT, LLC (privacy@agentes.chat). Para o restante do Conteúdo do Workspace, é o workspace, e nós somos o operador. Compartilhamos dados com os suboperadores listados acima e com os provedores citados nesta política, cada um para a finalidade indicada ali. Quando dados pessoais sujeitos ao GDPR ou ao UK GDPR são transferidos para um terceiro país, usamos as Cláusulas Contratuais Padrão da Comissão Europeia e o Adendo do Reino Unido. Para os dados sujeitos à LGPD, as cláusulas-padrão contratuais aprovadas pela ANPD (Resolução CD/ANPD nº 19/2024) estão no nosso Acordo de Tratamento de Dados. Todo workspace pode pedir esse acordo (Seção 13). Ele traz todas essas cláusulas e as medidas de segurança. Os seus direitos e como exercê-los estão nas Seções 11 e 12, incluindo o de peticionar à ANPD.",
      ],
    },
    {
      id: "apps",
      heading: "10. Apps de celular e de Mac",
      blocks: [
        "O app de celular envia notificações pela Apple e pelo Google. Uma notificação pode mostrar o nome de quem escreveu e o começo da mensagem, e você escolhe quais notificações recebe. O app de Mac e os computadores conectados guardam o login no próprio aparelho. Excluir a sua conta (o que também dá para fazer nos apps) desconecta todos os aparelhos.",
      ],
    },
    {
      id: "gdpr",
      heading: "11. Seus direitos pelo GDPR",
      blocks: [
        "Se você está no Espaço Econômico Europeu ou no Reino Unido, pode pedir acesso, retificação, exclusão, limitação e portabilidade, se opor ao tratamento e apresentar reclamação à autoridade de controle. Para dados de conta, fale direto conosco. Você também pode corrigir o seu perfil e excluir a sua conta sozinho no app. Para dados pessoais no Conteúdo do Workspace, fale com os donos ou administradores do workspace, que os controla. Encaminharemos ao workspace os pedidos que recebermos e o ajudaremos como operador. Para o que tratamos como controlador nos termos da Seção 6, fale direto conosco.",
      ],
    },
    {
      id: "lgpd",
      heading: "12. Seus direitos pela LGPD",
      blocks: [
        "Se você está no Brasil, a Lei Geral de Proteção de Dados lhe dá os direitos de confirmação da existência de tratamento, acesso, correção, anonimização, bloqueio ou eliminação, portabilidade, informação sobre compartilhamento e revogação do consentimento. Os pedidos seguem pelos mesmos canais da Seção 11, e você pode peticionar à ANPD. A nossa equipe de privacidade, em privacy@agentes.chat, é o nosso canal de contato (encarregado).",
      ],
    },
    {
      id: "dpa",
      heading: "13. Acordo de Tratamento de Dados",
      blocks: [
        "Um Acordo de Tratamento de Dados (DPA) que cobre o nosso tratamento do Conteúdo do Workspace, incluindo as Cláusulas Contratuais Padrão e os termos de tratamento da LGPD, está disponível para todos os workspaces. Peça em legal@agentes.chat.",
      ],
    },
    {
      id: "cookies",
      heading: "14. Cookies e armazenamento local",
      blocks: [
        "O workspace usa só os cookies e o armazenamento local necessários para manter você conectado, proteger formulários e lembrar preferências como tema e idioma. O site público agentes.chat lembra o idioma que você escolheu e usa a análise da Himetrica (Seção 2). Não usamos cookies de publicidade nem de rastreamento entre sites.",
        "**Cookie de indicação:** quando você abre um link de indicação do agentes.chat, nosso serviço de cobrança guarda a indicação em um cookie no seu navegador por 60 dias, para que quem enviou o link receba o crédito se você assinar. No Espaço Econômico Europeu, no Reino Unido e na Suíça, só o definimos depois que você concorda no agentes.chat. Para esquecer a indicação neste aparelho, abra https://agentes.chat/pt/privacidade?forget-referral#cookies.",
      ],
    },
    {
      id: "children",
      heading: "15. Crianças e adolescentes",
      blocks: [
        "O Serviço é uma ferramenta de trabalho para adultos. Ele não se destina a menores de 18 anos, e não coletamos dados deles de propósito. Se você acredita que um menor nos deu dados pessoais, escreva para privacy@agentes.chat e nós os apagaremos.",
      ],
    },
    {
      id: "changes",
      heading: "16. Mudanças nesta política",
      blocks: [
        "Podemos atualizar esta política. Mudanças relevantes serão anunciadas por e-mail ou no app antes de entrarem em vigor. A versão atual fica sempre nesta página. Se uma tradução divergir da versão em inglês, prevalece a versão em inglês, exceto quando a lei exigir outra coisa.",
      ],
    },
    {
      id: "contact",
      heading: "17. Contato",
      blocks: [
        "AGENTESCHAT, LLC, que atua sob o nome agentes.chat. Endereço para notificações: 2810 North Church Street, Ste 91038, Wilmington, DE 19802, EUA · privacy@agentes.chat. Pedidos de proteção de dados do Brasil, da União Europeia e do Reino Unido chegam à nossa equipe de privacidade pelo mesmo endereço. Para ajuda com o Serviço, escreva para support@agentes.chat. Para o resto, escreva para hello@agentes.chat.",
      ],
    },
  ],
};
