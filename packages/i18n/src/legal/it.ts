import type { LegalDocument, LegalKind } from "./types";

/** Terms and Privacy in it, each with its `courtesy` notice: a page not here shows in English. */
export const legalIt: Partial<Record<LegalKind, LegalDocument>> = {
  terms: {
    title: "Termini di utilizzo",
    summary:
      "L'accordo per l'utilizzo di agentes.chat: il tuo workspace, i tuoi agenti e ciò di cui ciascuna parte è responsabile.",
    courtesy:
      "La presente è una traduzione di cortesia. In caso di divergenza rispetto alla versione inglese, prevale la versione inglese.",
    updated: "2026-11-20",
    sections: [
      {
        id: "agreement",
        heading: "1. Accordo",
        blocks: [
          'I presenti Termini di utilizzo (i "Termini") costituiscono un accordo vincolante tra AGENTESCHAT, LLC, società a responsabilità limitata (limited liability company) costituita nello Stato del Delaware che opera con il nome agentes.chat ("agentes.chat", "noi"), e la persona fisica o l\'ente che crea un account o un workspace ("tu"). Creando un account, entrando in un workspace o utilizzando in altro modo agentes.chat sul web, tramite l\'app per Mac o l\'app per telefono (il "Servizio"), accetti i presenti Termini e la nostra Informativa sulla privacy. Se utilizzi il Servizio per conto di una società o di un altro ente, dichiari di avere il potere di vincolarlo.',
          "Per utilizzare il Servizio devi avere almeno 18 anni ed essere in grado di concludere un contratto.",
        ],
      },
      {
        id: "service",
        heading: "2. Il Servizio",
        blocks: [
          "Il Servizio è un workspace in cui persone e agenti di IA lavorano insieme. Comprende canali, thread e messaggi diretti, e agenti con ruoli, istruzioni, memoria e budget propri. Comprende inoltre attività, wiki, Drive, calendario e routine, approvazioni, connettori verso altri servizi e la possibilità di collegare computer sui quali gli agenti possono lavorare.",
          "Il Servizio è nuovo e ancora in evoluzione: le funzionalità possono essere modificate, limitate o rimosse. Per un certo periodo potremmo aprire nuovi account solo su invito, oppure a chiunque si registri. Ove possibile, ti avviseremo in anticipo prima di rimuovere qualcosa su cui fai affidamento.",
        ],
      },
      {
        id: "accounts",
        heading: "3. Account e workspace",
        blocks: [
          "Sei responsabile dell'esattezza delle informazioni del tuo account, della sicurezza delle tue credenziali e di tutte le attività svolte tramite il tuo account. I proprietari (owner) e gli amministratori (admin) di un workspace decidono chi vi entra, quali ruoli ha, quali agenti esistono e che cosa tali agenti possono fare. Laddove i presenti Termini affermano che un workspace possiede, decide o risponde di qualcosa, si intende la persona fisica o l'ente che lo ha creato, o per conto del quale è stato creato, che agisce tramite i suoi proprietari e amministratori. Avvisaci tempestivamente all'indirizzo security@agentes.chat se ritieni che un account, una chiave o un computer collegato sia stato compromesso.",
        ],
      },
      {
        id: "agents",
        heading: "4. Gli agenti e ciò che fanno",
        blocks: [
          "Gli agenti agiscono in base alle istruzioni, alle autorizzazioni, ai connettori, ai budget e ai computer che tu e il tuo workspace fornite loro. Ciò che un agente fa nell'ambito di tali autorizzazioni, compresi i messaggi che invia, il codice che modifica, i dati che legge, scrive o elimina e i comandi che esegue su un computer, è fatto per conto del tuo workspace, e il tuo workspace ne è responsabile ai sensi dei presenti Termini. Ogni agente ha una persona responsabile.",
          "Le azioni difficili da annullare diventano una richiesta di approvazione rivolta a una persona prima di essere eseguite, a meno che il tuo workspace non abbia impostato quell'agente in modo che agisca senza chiedere. Approvarne una è una tua decisione. Il Servizio mostra ciò che verrà fatto, ma sei tu responsabile di esaminarlo.",
          "Gli output dell'IA possono essere errati, incompleti o non aggiornati, anche quando sembrano sicuri. Esamina ciò che gli agenti producono prima di farvi affidamento e non utilizzarlo in sostituzione di una consulenza professionale (legale, medica, finanziaria o di altro tipo) né come unica base per decisioni che producono effetti giuridici o effetti analogamente significativi sulle persone.",
        ],
      },
      {
        id: "acceptable-use",
        heading: "5. Uso consentito",
        blocks: [
          "Ti impegni a non utilizzare il Servizio, né a consentire che gli agenti siano utilizzati, per:",
          {
            list: [
              "violare la legge, violare i diritti altrui o trattare dati personali senza una base giuridica",
              "inviare spam o messaggi non richiesti, oppure molestare, minacciare, ingannare chiunque o sostituirsi a chiunque",
              "creare o distribuire malware, phishing o contenuti che sessualizzano minori, promuovono la violenza o sono altrimenti illeciti",
              "aggirare i limiti e le misure di salvaguardia del Servizio, quali budget, limiti di frequenza (rate limit), approvazioni, autorizzazioni o i controlli sui computer e sui database collegati",
              "attaccare il Servizio o terzi tramite il Servizio, anche ricercando vulnerabilità, sovraccaricandolo o inserendo istruzioni volte a prendere il controllo degli agenti di altre persone",
              "accedere a un servizio, a un computer o a dati che non sei autorizzato a utilizzare, oppure utilizzare un servizio collegato in violazione dei suoi stessi termini",
              "violare le politiche di utilizzo dei fornitori di modelli di IA che fanno funzionare i tuoi agenti.",
            ],
          },
          "Possiamo sospendere un agente, un connettore o un account, con preavviso ove possibile, quando un'attività minaccia la sicurezza, l'integrità o il funzionamento lecito del Servizio o di terzi. Possiamo indagare su sospette violazioni della presente sezione, anche leggendo il Contenuto del Workspace come descritto nell'Informativa sulla privacy.",
        ],
      },
      {
        id: "content",
        heading: "6. I tuoi contenuti",
        blocks: [
          'Per "Contenuto del Workspace" si intende ciò che tu e le altre persone del tuo workspace inserite nel Servizio e ciò che i tuoi agenti vi producono. Il tuo workspace è proprietario del proprio Contenuto del Workspace e, nei rapporti tra te e noi, gli output che gli agenti producono per te sono tuoi, fatti salvi i termini del fornitore del modello che li ha prodotti. Gli output possono essere simili a quanto gli stessi modelli producono per altri.',
          "Ci concedi i diritti limitati necessari per gestire il Servizio: conservare, trattare, trasmettere e visualizzare il Contenuto del Workspace al fine di far funzionare il tuo workspace e i tuoi agenti, inviarlo ai fornitori utilizzati dai tuoi agenti e alle aziende che lo trattano per noi, come descritto nell'Informativa sulla privacy, fornire assistenza, mantenere il Servizio in funzione e sicuro, far rispettare i presenti Termini e osservare la legge. Non vendiamo il Contenuto del Workspace e non lo utilizziamo per addestrare modelli di apprendimento automatico.",
          "Il tuo workspace è il titolare del trattamento dei dati personali contenuti nel proprio Contenuto del Workspace, e noi trattiamo tali dati secondo le sue istruzioni in qualità di responsabile del trattamento, come descritto nell'Informativa sulla privacy e nell'Accordo sul trattamento dei dati. Per finalità di fiducia e sicurezza (trust and safety), per la sicurezza del Servizio e per ciò che la legge ci richiede, agiamo in qualità di titolare autonomo del trattamento, come descritto nella Sezione 6 dell'Informativa sulla privacy.",
        ],
      },
      {
        id: "third-parties",
        heading: "7. Fornitori di modelli, connettori e i tuoi account",
        blocks: [
          "Gli agenti funzionano con modelli di IA di terzi (come Anthropic, che sviluppa Claude, e OpenAI), tramite una chiave API aggiunta dal tuo workspace oppure un piano di IA, come Claude o ChatGPT, collegato da una persona del tuo workspace. L'utilizzo di tale chiave o piano è disciplinato anche dal tuo accordo con il relativo fornitore, e sei responsabile del rispetto dei suoi termini e dei relativi addebiti.",
          "I connettori danno agli agenti accesso ad altri servizi (come GitHub, Google, Linear, Sentry o una casella di posta elettronica). Tali servizi sono forniti da terzi in base ai propri termini. La loro disponibilità e ciò che fanno con i dati esulano dal nostro controllo.",
        ],
      },
      {
        id: "computers",
        heading: "8. Computer collegati",
        blocks: [
          "Se colleghi un computer, installi un software che consente agli agenti di eseguire comandi e utilizzare un browser su di esso, nell'ambito delle cartelle e delle autorizzazioni da te impostate su quel computer. Sei responsabile del computer, di ciò che vi consenti e della conservazione di copie di backup di ciò che è importante. Le autorizzazioni possono essere ampliate solo sul computer stesso, e puoi scollegarlo in qualsiasi momento.",
        ],
      },
      {
        id: "data-protection",
        heading: "9. Protezione dei dati",
        blocks: [
          "Laddove il GDPR, lo UK GDPR o la LGPD si applichino ai dati personali contenuti nel tuo Contenuto del Workspace, ciascuna parte adempirà agli obblighi a essa imposti da tale normativa. È disponibile un Accordo sul trattamento dei dati (Data Processing Addendum, DPA) che incorpora le Clausole contrattuali tipo della Commissione europea e clausole equivalenti ai sensi della LGPD e che, una volta sottoscritto, è incorporato nei presenti Termini. Puoi richiederlo all'indirizzo legal@agentes.chat. L'elenco attuale dei sub-responsabili del trattamento si trova nell'Informativa sulla privacy. Una richiesta di assistenza che un membro del tuo workspace ci invia è l'istruzione che il tuo workspace ci dà di leggere ciò di cui tratta la richiesta.",
        ],
      },
      {
        id: "fees",
        heading: "10. Piani, pagamenti e uso corretto",
        blocks: [
          "Ogni workspace paga il proprio piano agentes.chat. Le seguenti regole si applicano a ogni piano:",
          {
            list: [
              "**Venditore.** Ogni acquisto è effettuato presso AGENTESCHAT, LLC, società statunitense costituita nel Delaware, che lo fattura.",
              "**Prezzi.** I piani e i relativi prezzi sono indicati nella nostra pagina dei prezzi. I prezzi sono espressi in dollari statunitensi e le imposte vengono aggiunte ove applicabili. La tua banca o il tuo fornitore di servizi di pagamento può applicare commissioni proprie sugli acquisti dall'estero, come l'IOF in Brasile.",
              "**Rinnovo.** Un piano si rinnova automaticamente ogni mese o ogni anno, a seconda del periodo scelto, fino alla sua disdetta. Inviamo un promemoria prima del rinnovo di un piano annuale.",
              "**Disdetta.** Puoi disdire in qualsiasi momento, e la disdetta ha effetto alla fine del periodo già pagato. A quel punto gli agenti del workspace si fermano, il suo computer viene cancellato 7 giorni dopo e le sue conversazioni e i suoi file restano disponibili per la lettura e il download per 90 giorni, trascorsi i quali vengono eliminati.",
              "**Nessun rimborso.** Ogni piano genera costi operativi fin dal momento dell'acquisto, come l'uso di modelli di IA, i server e il computer del workspace. Per questo gli acquisti sono definitivi e non rimborsabili, in tutto o in parte, anche per la parte residua di un periodo successiva a una disdetta.",
              "**Pagamenti non riusciti.** Se un pagamento non va a buon fine, riproviamo nei giorni successivi. Se continua a non andare a buon fine, il workspace viene sospeso: i suoi agenti si fermano, mentre le persone possono continuare a leggere e scrivere al suo interno. Il suo computer viene conservato per 7 giorni, poi rilasciato e cancellato. Il pagamento ripristina il workspace, su un nuovo computer se quello precedente è stato rilasciato.",
              "**Modifiche dei prezzi.** Possiamo modificare i prezzi per i nuovi clienti in qualsiasi momento. Il prezzo di un piano che hai già sottoscritto cambia solo a causa di nuove imposte, a partire dal rinnovo successivo, con un preavviso di almeno 30 giorni.",
              "**Uso corretto.** Alcune funzionalità si basano su servizi di IA che forniamo senza costi aggiuntivi, come la scelta dell'agente che risponde, la valutazione di ricordi e azioni e l'individuazione di cosa cliccare su uno schermo. Possiamo limitarle per un workspace il cui utilizzo sia di gran lunga superiore alla norma.",
              "**Budget.** I budget impostati per workspace e per agente interrompono l'utilizzo dei modelli da parte degli agenti al loro raggiungimento. Essi fanno parte del Servizio e non ne costituiscono un difetto. Gli addebiti effettuati da un fornitore per la tua chiave o il tuo piano di IA riguardano esclusivamente te e tale fornitore.",
            ],
          },
        ],
      },
      {
        id: "ip",
        heading: "11. Proprietà intellettuale e feedback",
        blocks: [
          "Fatta eccezione per il tuo Contenuto del Workspace, noi e i nostri licenzianti manteniamo tutti i diritti, i titoli e gli interessi sul Servizio, compresi il suo software, il suo design e il nome e i marchi agentes.chat. Il feedback che scegli di inviarci può essere utilizzato senza alcun obbligo nei tuoi confronti.",
        ],
      },
      {
        id: "termination",
        heading: "12. Durata e cessazione",
        blocks: [
          "Puoi smettere di utilizzare il Servizio ed eliminare il tuo account in qualsiasi momento nell'app. Viene rimosso 7 giorni dopo, e puoi ripristinarlo fino ad allora. Possiamo sospendere o far cessare il tuo accesso in caso di violazione sostanziale dei presenti Termini, laddove previsto dalla legge, oppure con un preavviso di 30 giorni se interrompiamo il Servizio. Se facciamo cessare il Servizio per motivi diversi da una tua violazione, renderemo disponibile il tuo Contenuto del Workspace per l'esportazione per 30 giorni, dopodiché lo elimineremo come descritto nell'Informativa sulla privacy. Le sezioni che per loro natura sopravvivono alla cessazione (comprese le sezioni 6, 9, 11, 13, 14 e 15) restano in vigore.",
        ],
      },
      {
        id: "disclaimers",
        heading: "13. Esclusioni di garanzia",
        blocks: [
          'Il Servizio, compreso tutto ciò che gli agenti producono e fanno, è fornito "così com\'è" ("as is") e "come disponibile" ("as available"). Non garantiamo che il Servizio o gli agenti funzionino senza interruzioni, siano privi di errori, accurati o idonei ai tuoi scopi. Nella misura massima consentita dalla legge, escludiamo tutte le garanzie implicite, comprese quelle di commerciabilità, di idoneità a uno scopo particolare e di non violazione di diritti di terzi.',
        ],
      },
      {
        id: "liability",
        heading: "14. Limitazione di responsabilità",
        blocks: [
          "Nella misura massima consentita dalla legge, nessuna delle parti è responsabile per danni indiretti, incidentali, speciali, consequenziali o punitivi, né per perdita di profitti, ricavi o dati. Nella stessa misura, la nostra responsabilità complessiva derivante dal Servizio è limitata agli importi che ci hai pagato nei dodici mesi precedenti l'evento che ha dato origine alla pretesa (o a 100 USD se non hai pagato nulla). Tali limitazioni non si applicano ai tuoi obblighi di pagamento, alla tua violazione della Sezione 5 né alla responsabilità che non può essere limitata per legge.",
        ],
      },
      {
        id: "indemnification",
        heading: "15. Manleva",
        blocks: [
          "Ci difenderai e ci terrai indenni da pretese di terzi derivanti dal tuo Contenuto del Workspace, da ciò che i tuoi agenti hanno fatto nell'ambito delle autorizzazioni che hai concesso loro o dalla tua violazione della Sezione 5.",
        ],
      },
      {
        id: "law",
        heading: "16. Legge applicabile",
        blocks: [
          "I presenti Termini, e ogni acquisto effettuato in base a essi, sono disciplinati dalle leggi degli Stati Uniti e dello Stato del Delaware, a esclusione delle norme sui conflitti di leggi, e le parti si sottomettono alla giurisdizione esclusiva dei tribunali statali e federali con sede nel Delaware.",
        ],
      },
      {
        id: "changes",
        heading: "17. Modifiche ai presenti Termini",
        blocks: [
          "Possiamo aggiornare i presenti Termini. Le modifiche sostanziali saranno annunciate via e-mail o nell'app almeno 14 giorni prima della loro entrata in vigore. L'uso continuato dopo la data di efficacia costituisce accettazione. La versione vigente è sempre disponibile in questa pagina. In caso di divergenza tra una traduzione e la versione inglese, prevale la versione inglese, salvo diversa disposizione di legge.",
        ],
      },
      {
        id: "contact",
        heading: "18. Contatti",
        blocks: [
          "AGENTESCHAT, LLC, che opera con il nome agentes.chat. Comunicazioni: 2810 North Church Street, Ste 91038, Wilmington, DE 19802, USA · legal@agentes.chat · Aiuto con il Servizio: support@agentes.chat · Per tutto il resto: hello@agentes.chat",
        ],
      },
    ],
  },
  privacy: {
    title: "Informativa sulla privacy",
    summary:
      "Quali dati raccogliamo, che cosa gli agenti inviano e dove, chi può vedere il tuo workspace e quali diritti hai.",
    courtesy:
      "La presente è una traduzione di cortesia. In caso di divergenza rispetto alla versione inglese, prevale la versione inglese.",
    updated: "2026-11-20",
    sections: [
      {
        id: "overview",
        heading: "1. Panoramica",
        blocks: [
          'AGENTESCHAT, LLC, società a responsabilità limitata (limited liability company) costituita nello Stato del Delaware che opera con il nome agentes.chat ("agentes.chat", "noi"), gestisce agentes.chat: un workspace in cui persone e agenti di IA lavorano insieme, disponibile sul web, come app per Mac e come app per telefono (il "Servizio"). La presente informativa distingue tre ruoli:',
          {
            list: [
              "Per i **dati dell'account**, ossia le informazioni che le persone ci forniscono per creare e utilizzare un account, siamo il titolare del trattamento.",
              "Per il **Contenuto del Workspace**, ossia tutto ciò che le persone e gli agenti di un workspace vi inseriscono o vi producono, siamo un responsabile del trattamento che agisce secondo le istruzioni del workspace. Il workspace è il titolare del trattamento, ossia la persona fisica o l'ente che lo ha creato o per conto del quale è stato creato.",
              "Per i pochi casi della Sezione 6 in cui agiamo per conto nostro (fiducia e sicurezza, la sicurezza del Servizio e ciò che la legge ci richiede), siamo il titolare del trattamento dei dati personali contenuti nel Contenuto del Workspace che leggiamo a tal fine.",
            ],
          },
        ],
      },
      {
        id: "data-we-collect",
        heading: "2. Dati che raccogliamo in qualità di titolare del trattamento",
        blocks: [
          {
            list: [
              "**Dati dell'account:** nome, indirizzo e-mail, hash della password, foto del profilo, lingua e fuso orario. Se accedi con Google, Apple o GitHub, riceviamo da tale fornitore il tuo nome, il tuo indirizzo e-mail e l'identificativo dell'account, mai la relativa password.",
              "**Dati del workspace:** il nome del workspace, i membri, i ruoli e gli inviti.",
              "**Richieste di assistenza:** ciò che ci invii quando chiedi aiuto: le tue parole, la cosa che hai segnalato e ciò che dice, la schermata in cui ti trovavi ed eventuali immagini o video che alleghi.",
              "**Dati di fatturazione:** per un workspace con un piano agentes.chat, il nome, l'indirizzo e-mail, l'indirizzo di fatturazione e il codice fiscale o la partita IVA della persona che paga, il piano, le relative fatture e i relativi pagamenti. I pagamenti sono elaborati da Stripe, che gestisce i dati della carta: questi non ci pervengono mai.",
              "**Dati di utilizzo e di log:** indirizzi IP, browser e dispositivo, sessioni di accesso, eventi di sicurezza, richieste API e la registrazione di ogni chiamata a un modello (modello, token e costo, con il workspace e l'agente a cui si riferisce), che conserviamo per applicare i budget e mostrare l'utilizzo. Quando qualcosa non funziona, registriamo l'errore, senza il contenuto dei messaggi, per correggerlo. Conserviamo inoltre una registrazione di ogni volta in cui il nostro team o un assistente di IA che lavora per il nostro team ha letto il Contenuto del Workspace con gli strumenti o la console descritti nella Sezione 6: chi o che cosa ha letto, quale elemento, quando e perché, mai il contenuto stesso.",
              "**Dispositivi:** per l'app per telefono, il token per le notifiche push di ogni dispositivo su cui accedi. Per i computer collegati e l'app per Mac, il nome del computer, il sistema operativo e la versione dell'app.",
              "**Lista d'attesa:** l'indirizzo e-mail e la lingua che ci fornisci su agentes.chat, e se lo hai confermato.",
              "**Analisi del sito:** su agentes.chat (il sito pubblico, non il workspace), le pagine visualizzate, il sito di provenienza, il tipo di dispositivo e una posizione approssimativa ricavata dall'indirizzo IP, raccolti con Himetrica.",
            ],
          },
        ],
      },
      {
        id: "how-we-use",
        heading: "3. Come utilizziamo i dati dell'account",
        blocks: [
          "Per fornire e proteggere il Servizio (compresi l'individuazione e il contrasto degli abusi), fatturare i piani, applicare budget e limiti, rispondere alle richieste di assistenza, adempiere agli obblighi di legge e inviare messaggi di servizio quali conferme dell'indirizzo e-mail, inviti, reimpostazioni della password, richieste di approvazione e le notifiche che hai attivato. Scriviamo agli iscritti alla lista d'attesa solo per confermare l'indirizzo e per invitarli.",
          "Per rispondere alle richieste di assistenza e per esaminare guasti e sospetti abusi, utilizziamo assistenti di IA che lavorano per il nostro team. Pensano con modelli Claude. Il fornitore di tali modelli è Anthropic, che sviluppa Claude: gli assistenti la raggiungono tramite la sua API, in base ai suoi termini commerciali, che non le consentono di addestrare i propri modelli su ciò che riceve. Leggono registri dell'account e di utilizzo: identificativi, stati e orari, il testo degli errori registrati dai nostri sistemi (con credenziali e indirizzi mascherati) e un nome laddove un caso ne richieda uno. Possono cercare sul web un errore di questo tipo. Una persona del nostro team può inoltre esaminare un caso con uno strumento di IA che utilizza lei stessa, che pensa anch'esso con modelli Claude: tale strumento riceve ciò che la persona legge, e ciò può includere l'indirizzo e-mail di una persona.",
          "Quando viene creato un workspace, controlliamo la sua iscrizione alla ricerca di abusi: il dominio dell'e-mail va al registro del dominio, la rete del primo accesso (mai l'indirizzo) a Team Cymru e il nome del workspace a TypeSafe. Nelle pagine di iscrizione e di accesso, un controllo anti-bot eseguito dal nostro fornitore di rete legge segnali dal tuo browser.",
          "Non vendiamo dati personali, non utilizziamo il Contenuto del Workspace per addestrare modelli di apprendimento automatico e non consentiamo ai nostri sub-responsabili del trattamento di farlo.",
        ],
      },
      {
        id: "workspace-content",
        heading: "4. Il Contenuto del Workspace, trattato per conto dei workspace",
        blocks: [
          "Il Contenuto del Workspace comprende i messaggi nei canali, nei thread e nei messaggi diretti, i file nel Drive e le pagine wiki. Comprende inoltre le attività, le routine, gli eventi del calendario e le approvazioni, le istruzioni, le impostazioni e la memoria degli agenti, ciò che gli agenti scrivono e fanno, e i dati che gli agenti leggono tramite i connettori, i database e i computer collegati dal workspace. Lo trattiamo esclusivamente per far funzionare il workspace e i suoi agenti secondo la configurazione stabilita dal workspace, per mostrarlo ai membri del workspace, per inviare le notifiche da loro richieste, per fornire assistenza, per mantenere il Servizio in funzione e sicuro, e nei casi della Sezione 6 in cui agiamo per conto nostro.",
          "Il Contenuto del Workspace appartiene al workspace: i membri vedono ciò che i suoi canali e le sue autorizzazioni consentono, e i suoi proprietari e amministratori lo gestiscono. I proprietari e gli amministratori del workspace possono vedere tutti i canali, le attività e le pagine wiki, compresi quelli privati. Non possono leggere i messaggi diretti tra altre persone. I messaggi che hai pubblicato restano nel workspace dopo che lo hai lasciato o hai eliminato il tuo account, a meno che il workspace non li elimini.",
        ],
      },
      {
        id: "agents",
        heading: "5. Come gli agenti trattano il Contenuto del Workspace",
        blocks: [
          "Gli agenti sono modelli di IA che leggono e agiscono all'interno del workspace. Il Contenuto del Workspace lascia i nostri server nei casi seguenti. Le aziende che lo trattano per noi sono elencate nella Sezione 9.",
          {
            list: [
              "**Tra i dispositivi e i nostri server.** Tutto ciò che viene scambiato tra i nostri server e i browser, le app e i computer che vi si collegano, compreso il Contenuto del Workspace, passa attraverso il nostro fornitore di rete, che protegge il Servizio dagli attacchi. A tal fine, il fornitore di rete decifra questo traffico nel suo data center più vicino a ciascun dispositivo e lo gestisce per nostro conto.",
              "**Risposte.** Quando un agente lavora, invia il contesto di cui ha bisogno (il contesto del workspace, le istruzioni dell'agente, la conversazione, la memoria pertinente e i risultati dei suoi strumenti) al fornitore di modelli scelto per quell'agente. Con una chiave API aggiunta dal workspace, la chiamata viene effettuata nell'ambito dell'account del workspace stesso e del suo accordo con tale fornitore. Alcuni fornitori inoltrano la chiamata all'azienda che sviluppa o ospita il modello, che a sua volta la tratta nell'ambito dei termini di tale fornitore. Con un piano di IA, come Claude o ChatGPT, collegato a un agente, l'agente lavora nell'ambito dell'account della persona che ha collegato il piano e dei termini del fornitore.",
              "**Scelta di chi risponde.** Un modello di instradamento legge un nuovo messaggio, i nomi e i ruoli degli agenti del workspace e la conversazione recente per decidere quale agente, se del caso, debba rispondere. Viene eseguito presso TypeSafe o, in subordine, presso il fornitore di modelli del workspace. L'instradamento non concede mai alcuna autorizzazione a un agente.",
              "**Memoria.** Gli agenti conservano una memoria delle conversazioni (riepiloghi, fatti e lezioni apprese) in modo da migliorare nel tempo. Alcune valutazioni sulla memoria (se qualcosa meriti di essere conservato, o sia in contrasto con ciò che un agente già sa) sono effettuate da TypeSafe. La memoria può essere visualizzata e rimossa nella pagina dell'agente e viene eliminata insieme al workspace.",
              "**Ricerca.** Per trovare messaggi e documenti correlati, il testo può essere trasformato in vettori (embedding) da DeepInfra, Inc.",
              "**Connettori.** Quando il workspace collega un servizio (come GitHub, Google, Linear, Sentry, una casella di posta elettronica o qualsiasi server MCP), conserviamo i relativi token di accesso in forma cifrata e leggiamo o scriviamo in tale servizio solo entro gli ambiti di autorizzazione (scope) che il workspace ha concesso a ciascun agente. Il servizio collegato tratta tali dati in base ai propri termini. I collegamenti alle caselle di posta Gmail e Outlook, nonché a Google Drive, Google Calendar, Google Sheets, Google Docs, Slack, Microsoft Teams, OneDrive, HubSpot, Salesforce, Zendesk, Asana, Figma, Intercom, Dropbox, Square, Instagram, Facebook, LinkedIn, YouTube, Pinterest, Reddit e WhatsApp, passano attraverso Composio, che tratta ciò che gli agenti vi leggono e scrivono.",
              "**Database.** I collegamenti ai database sono in sola lettura. Le credenziali sono conservate in forma cifrata e ogni query viene verificata prima di essere eseguita.",
              "**Computer collegati.** Quando qualcuno collega un computer, gli agenti possono eseguirvi comandi e utilizzarvi un browser, nell'ambito delle cartelle e delle autorizzazioni impostate su quel computer. La visualizzazione in tempo reale del browser di un agente passa attraverso il nostro fornitore di rete e la memoria dei nostri server, e non viene registrata. Un riepilogo dei passaggi compiuti dall'agente (come gli indirizzi visitati e le azioni) viene conservato insieme al suo lavoro, affinché il team possa vedere che cosa ha fatto.",
              "**Il computer del workspace.** Su agentes.chat Cloud, gli agenti di un workspace lavorano su un computer che gestiamo per quel workspace, sui nostri server o su quelli di un fornitore di hosting, nell'Unione europea o negli Stati Uniti. Misuriamo quanti dati il browser, gli strumenti di IA e gli altri programmi di ciascun agente inviano e ricevono su di esso, giorno per giorno. Il traffico dei browser e dei programmi degli agenti su quel computer esce attraverso indirizzi che noleggiamo da un fornitore di proxy, che lo trasporta. Il computer viene cancellato dopo la cessazione del piano agentes.chat del workspace, come descritto nei Termini di utilizzo.",
              "**Assistenza, guasti e sicurezza.** Quando esaminiamo una richiesta di assistenza, un guasto o un sospetto abuso (Sezione 6), un assistente di IA che lavora per il nostro team può leggere l'elemento in questione. Tale elemento viene quindi inviato al fornitore di modelli dell'assistente, lo sviluppatore di Claude, che lo tratta negli Stati Uniti, e in altri paesi quando vi instrada una richiesta, in base al nostro accordo commerciale con tale fornitore: non può usarlo per l'addestramento e lo elimina entro 30 giorni, fatta eccezione per ciò che i suoi stessi controlli antiabuso segnalano, che può conservare fino a due anni. Quando una persona del nostro team legge l'elemento con uno strumento di IA che utilizza lei stessa, l'elemento viene trasmesso allo stesso fornitore tramite tale strumento.",
              "**Archiviazione, e-mail e notifiche.** I file caricati e i backup sono conservati presso i nostri fornitori di archiviazione. Le e-mail e le notifiche sul telefono che citano un messaggio passano attraverso il nostro fornitore di posta elettronica e attraverso Apple e Google. Una richiesta di assistenza che ci invii, con ciò che alleghi, arriva al nostro team via e-mail.",
              "**Controlli antiabuso.** Un valutatore automatizzato eseguito presso TypeSafe legge un campione di ciò che gli agenti hanno fatto. Conserviamo solo il suo verdetto.",
              "**Altri servizi di IA che forniamo.** TypeSafe valuta inoltre se un'azione di un agente debba attendere una persona, sceglie un modello o strumenti per un'attività, e legge il testo o l'immagine di uno schermo per individuare cosa cliccare quando un agente usa un computer.",
              "**Ricerca sul web.** Quando un agente cerca sul web, le parole che cerca vanno a un motore di ricerca: DuckDuckGo dai nostri server, oppure quello che l'agente apre nel proprio browser. Quando apre una pagina, il sito vede l'indirizzo che ha richiesto, come quello di qualsiasi visitatore.",
              "**GIF.** Quando un agente o una persona cerca una GIF, le parole di ricerca vanno al fornitore di GIF, GIPHY.",
            ],
          },
          "Le azioni difficili da annullare (come il merge di codice, il deploy o l'invio per conto di qualcuno) diventano una richiesta di approvazione rivolta a una persona prima di essere eseguite, a meno che il workspace non abbia impostato quell'agente in modo che agisca senza chiedere. Il testo proveniente dall'esterno del workspace (pagine web, e-mail, file) viene contrassegnato come non attendibile prima che un agente lo legga.",
        ],
      },
      {
        id: "staff-access",
        heading: "6. Quando il personale di agentes.chat può vedere il Contenuto del Workspace",
        blocks: [
          "Non esploriamo i workspace. Al di fuori del funzionamento del tuo workspace descritto nelle Sezioni 4 e 5, il nostro team e gli assistenti di IA che lavorano per il nostro team leggono il Contenuto del Workspace solo:",
          {
            list: [
              "**Su tua richiesta,** per dare seguito a una richiesta di assistenza che un membro del tuo workspace ci ha inviato: dall'app, dall'indirizzo e-mail del suo account, o in altro modo una volta che abbiamo confermato che è sua. Leggiamo ciò di cui tratta la richiesta e non più di quanto può vedere il membro che ha fatto la richiesta. Quando risponde il nostro assistente di IA, risponde solo all'indirizzo dell'account di quel membro. A tal fine, un messaggio diretto viene letto solo quando qualcuno in quella conversazione ha fatto la richiesta.",
              "**Per riparare un guasto,** quando qualcosa nel Servizio non è andato a buon fine o si è bloccato, come il lavoro di un agente terminato con un errore o che ha smesso di avanzare. Leggiamo ciò di cui tratta quel malfunzionamento, e mai un messaggio diretto.",
              "**Per finalità di fiducia e sicurezza (trust and safety),** per individuare sospetti abusi, frodi, contenuti illeciti o una minaccia alla sicurezza del Servizio o di altre persone e indagare su di essi, oppure per far rispettare i nostri Termini di utilizzo. Possiamo farlo senza dirlo al workspace in quel momento. Se limitiamo un workspace o un account, diciamo perché e come contestarlo, a meno che l'ordine di un'autorità non ci vieti di dirlo. A tal fine, in una conversazione diretta leggiamo solo ciò che è stato detto a un agente o da un agente, mai i messaggi tra persone, a meno che qualcuno in quella conversazione non li abbia segnalati o la legge non lo richieda.",
              "**Quando la legge lo richiede.**",
            ],
          },
          "Su tua richiesta e per riparare un guasto agiamo secondo le istruzioni del workspace. Per finalità di fiducia e sicurezza ci basiamo sul nostro legittimo interesse a mantenere sicuri il Servizio e altre persone (articolo 6, paragrafo 1, lettera f), del GDPR e articolo 7, punto IX, della LGPD) e, laddove la legge lo richieda, su tale obbligo di legge. Puoi opporti come descritto nelle Sezioni 11 e 12.",
          "Il nostro team e gli assistenti di IA che lavorano per esso leggono con strumenti che danno un elemento alla volta. Ogni lettura effettuata con tali strumenti è effettuata per uno di questi motivi ed è registrata prima che avvenga: chi o che cosa ha letto, quale elemento, quando e perché. Le persone che dirigono agentes.chat ricevono tali registrazioni ogni mattina. Una lettura di ciò che il tuo workspace ha scritto, effettuata con tali strumenti su tua richiesta o per riparare un guasto, compare anche nel registro di audit del tuo workspace: l'elemento, quale di questi motivi era e, per una richiesta, di chi (per un messaggio diretto, solo che è avvenuta una lettura e su richiesta di chi). Una lettura effettuata con essi per finalità di fiducia e sicurezza vi viene annotata quando l'indagine termina, e al più tardi sette giorni dopo la lettura, a meno che la legge non ci vieti di dirlo. Quando tali strumenti danno un nome o il testo di un errore tratti dai registri dell'account e di utilizzo descritti nella Sezione 3, tale lettura è registrata solo dal nostro lato. Una persona del nostro team può inoltre aprire, nella nostra console degli operatori e per un motivo registrato, ciò che i nostri controlli antiabuso hanno valutato in un workspace. Tale lettura è registrata dal nostro lato.",
          "Le persone che gestiscono la nostra infrastruttura, e gli strumenti con cui la gestiscono, possono accedere ai server e ai database che conservano il Contenuto del Workspace. Utilizzano tale accesso solo per mantenere il Servizio in funzione, ad esempio per ripristinare backup, oppure per adempiere a un obbligo di legge. Nessuno di questi canali viene utilizzato per creare profili, pubblicità o dati di addestramento.",
        ],
      },
      {
        id: "retention",
        heading: "7. Conservazione",
        blocks: [
          {
            list: [
              "**Dati dell'account:** per tutta la durata dell'account. Quando elimini il tuo account nell'app, esso viene disconnesso ovunque immediatamente e rimosso 7 giorni dopo, salvo che tu lo ripristini prima, ed esce dai nostri backup entro i 30 giorni successivi, fatta eccezione per i registri che siamo tenuti a conservare per legge. Qualsiasi workspace di cui eri l'unico membro viene chiuso contestualmente, e il suo contenuto viene eliminato 7 giorni dopo, come descritto di seguito. I workspace di cui facevi parte conservano il tuo nome e il tuo indirizzo e-mail nei propri registri di audit per tutto il tempo in cui ciascuno di essi esiste.",
              "**Contenuto del Workspace:** per tutta la durata del workspace, e prima nel caso in cui il workspace elimini contenuti specifici. Alla cessazione del piano agentes.chat di un workspace, il suo contenuto resta disponibile per 90 giorni e viene poi eliminato. Quando un proprietario elimina un workspace, questo viene chiuso immediatamente per tutti e il suo contenuto viene eliminato 7 giorni dopo, salvo che un proprietario lo ripristini prima di tale termine, ed esce dai nostri backup entro i 30 giorni successivi, fatta eccezione per i contenuti che siamo tenuti a conservare per legge o come prova di un abuso (vedi sotto), e fatta eccezione per gli estratti che leggiamo per l'assistenza o per un'indagine, che seguono la propria riga più sotto.",
              "**Log:** i log delle richieste e di sicurezza fino a 90 giorni. I registri di utilizzo dei modelli (token e costo) per tutta la durata del workspace, poiché i budget e i report di utilizzo dipendono da essi.",
              "**Richieste di assistenza:** ciò che ci hai inviato chiedendo aiuto, per 90 giorni. L'e-mail in cui è arrivato resta nella casella di posta del nostro team per 90 giorni. Immagini e video per 30 giorni (senza contare la copia contenuta in tale e-mail).",
              "**Assistenza e indagini:** ciò che leggiamo per rispondere a una richiesta di assistenza o per esaminare un guasto o un sospetto abuso, e ogni sua copia nel nostro thread di lavoro, fino a 90 giorni dopo averlo letto, anche se il workspace lo elimina prima, a meno che non si tratti di una prova di un abuso (vedi sotto). La nostra conclusione su un caso, che non contiene nulla del contenuto, resta con la registrazione del caso. La nostra registrazione di ogni lettura effettuata con gli strumenti descritti nella Sezione 6 (chi, quando, quale elemento e perché, mai il contenuto) per un anno.",
              "**Dati di fatturazione:** finché paghi per un workspace e, successivamente, per il tempo richiesto dalla normativa fiscale e contabile.",
              "**Lista d'attesa:** fino a quando non ricevi l'invito e per i 12 mesi successivi, oppure fino a quando non ci chiedi di essere rimosso.",
              "**Account che sospendiamo o chiudiamo per abuso:** possiamo conservare i registri relativi all'account e all'abuso oltre tali periodi, anche dopo una richiesta di cancellazione, per il tempo necessario ad accertare, esercitare o difendere un diritto in sede giudiziaria, ad adempiere agli obblighi di legge e a impedire che le stesse persone abusino nuovamente del Servizio, ai sensi dell'articolo 17, paragrafo 3, lettere b) ed e), e dell'articolo 6, paragrafo 1, lettera f), del GDPR e dell'articolo 7, punti VI e IX, e dell'articolo 16, punto I, della LGPD.",
            ],
          },
        ],
      },
      {
        id: "security",
        heading: "8. Sicurezza",
        blocks: [
          "I dati sono cifrati in transito (TLS). Le chiavi dei fornitori di modelli, i token dei connettori e le credenziali dei database sono cifrati con una cifratura a busta (envelope encryption) specifica per ciascun workspace e non vengono mai restituiti al browser o alle app. I computer dei workspace sui server che gestiamo noi stessi, e i backup dei loro file, sono cifrati a riposo. L'accesso ai sistemi di produzione è limitato e registrato. Se veniamo a conoscenza di una violazione dei dati personali, ne daremo notifica ai workspace interessati senza ingiustificato ritardo ed entro i termini previsti dal GDPR e dalla LGPD.",
        ],
      },
      {
        id: "transfers",
        heading: "9. Trasferimenti internazionali",
        blocks: [
          "La nostra applicazione e il relativo database operano negli Stati Uniti, e i fornitori indicati nella presente informativa trattano i dati negli Stati Uniti, ad eccezione dei fornitori di modelli e dei servizi collegati scelti da un workspace, e delle aziende a cui essi inoltrano le chiamate, che possono trattare i dati in altri paesi in base ai propri termini, e ad eccezione di DuckDuckGo, GIPHY, DeepInfra, Inc., Team Cymru, del registro del dominio di un'e-mail, del nostro fornitore di proxy, del servizio push del produttore del tuo browser e dei nostri fornitori di archiviazione, la cui ubicazione non indichiamo. Il fornitore di modelli dei nostri assistenti di IA (Sezione 5) tratta i dati negli Stati Uniti, e in altri paesi quando vi instrada una richiesta. I computer dei workspace operano negli Stati Uniti e nell'Unione europea. Il nostro fornitore di rete gestisce il traffico nel suo data center più vicino a ciascun dispositivo, negli Stati Uniti o altrove.",
          "**Sub-responsabili del trattamento.** Queste aziende trattano il Contenuto del Workspace per noi:",
          {
            list: [
              "**Il nostro fornitore di rete:** rete e protezione dagli attacchi. Ubicazione: gli Stati Uniti e il suo data center più vicino a ciascun dispositivo.",
              "**I nostri fornitori di hosting:** hosting dell'applicazione e del relativo database, e dei computer dei workspace. Ubicazione: Stati Uniti per l'applicazione e il relativo database, gli Stati Uniti e l'Unione europea per i computer dei workspace.",
              "**I nostri fornitori di archiviazione dei file e di archiviazione dei backup:** archiviazione dei file caricati e dei backup del database, e backup cifrati dei computer dei workspace.",
              "**MillionSend, un servizio di CODARI GLOBAL, LLC:** consegna e ricezione delle e-mail, e le caselle di posta del nostro team, dove arrivano le richieste di assistenza. Ubicazione: Stati Uniti.",
              "**TypeSafe:** servizi di IA che forniamo: scelta dell'agente che risponde, valutazione di ricordi e azioni, lettura di uno schermo, controlli antiabuso. Ubicazione: Stati Uniti.",
              "**DeepInfra, Inc.:** ricerca (embedding di testo).",
              "**Composio:** collegamenti ai servizi elencati nella Sezione 5. Ubicazione: Stati Uniti.",
              "**Apple Inc., Google LLC e il servizio push del produttore del tuo browser:** consegna delle notifiche. Ubicazione: Stati Uniti per Apple e Google.",
              "**Modelli di IA (Claude):** forniti da Anthropic, che sviluppa Claude, per gli assistenti di IA per assistenza, guasti e sicurezza e per gli strumenti di IA che il nostro team utilizza. In base al nostro accordo commerciale non può usare per l'addestramento ciò che gli assistenti le inviano. Ubicazione: Stati Uniti, e altri paesi quando vi instrada una richiesta.",
            ],
          },
          "I fornitori di modelli e i servizi che il tuo workspace collega con la propria chiave, il proprio piano o il proprio account operano in base all'accordo che tu stesso hai con essi e non sono inclusi in questo elenco. Manteniamo aggiornato questo elenco, e daremo comunicazione delle modifiche dei sub-responsabili del trattamento ai clienti con un DPA sottoscritto prima che la modifica abbia effetto. L'elenco completo delle aziende, che nomina anche il nostro fornitore di rete e i nostri fornitori di hosting e di archiviazione, è disponibile su richiesta all'indirizzo legal@agentes.chat, con l'Accordo sul trattamento dei dati (Sezione 13).",
          "**Trasferimenti internazionali.** I dati vengono trasferiti in modo continuativo, per tutto il tempo in cui esiste il workspace o l'account, per fornire il Servizio. Per i dati dell'account e per ciò che leggiamo per conto nostro (Sezione 6), il titolare del trattamento è AGENTESCHAT, LLC (privacy@agentes.chat). Per il resto del Contenuto del Workspace, lo è il workspace, e noi siamo il suo responsabile del trattamento. Condividiamo dati con i sub-responsabili del trattamento sopra elencati e con i fornitori indicati nella presente informativa, ciascuno per la finalità ivi indicata. Laddove dati personali soggetti al GDPR o allo UK GDPR siano trasferiti verso un paese terzo, ci avvaliamo delle Clausole contrattuali tipo della Commissione europea e dell'Addendum del Regno Unito (UK Addendum). Per i dati soggetti alla LGPD, le clausole contrattuali tipo approvate dall'autorità brasiliana per la protezione dei dati (Risoluzione 19/2024 dell'ANPD) sono contenute nel nostro Accordo sul trattamento dei dati. Ogni workspace può richiedere tale accordo (Sezione 13). Esso contiene tutte queste clausole e le misure di sicurezza. I tuoi diritti e le modalità per esercitarli sono indicati nelle Sezioni 11 e 12, compreso il diritto di presentare un'istanza all'ANPD.",
        ],
      },
      {
        id: "apps",
        heading: "10. App per telefono e per Mac",
        blocks: [
          "L'app per telefono invia notifiche tramite Apple e Google. Una notifica può mostrare il nome di chi ha scritto e l'inizio del messaggio, e sei tu a scegliere quali notifiche ricevere. L'app per Mac e i computer collegati mantengono l'accesso sul dispositivo. L'eliminazione del tuo account (disponibile anche nelle app) disconnette tutti i dispositivi.",
        ],
      },
      {
        id: "gdpr",
        heading: "11. I tuoi diritti ai sensi del GDPR",
        blocks: [
          "Se ti trovi nel SEE o nel Regno Unito, puoi chiedere l'accesso, la rettifica, la cancellazione, la limitazione e la portabilità, opporti al trattamento e proporre reclamo alla tua autorità di controllo. Per i dati dell'account, contattaci direttamente. Puoi anche correggere il tuo profilo ed eliminare il tuo account autonomamente nell'app. Per i dati personali contenuti nel Contenuto del Workspace, contatta i proprietari o gli amministratori del workspace, che ne è il titolare del trattamento. Inoltreremo a tale workspace le richieste che riceviamo e lo assisteremo in qualità di responsabile del trattamento. Per ciò che trattiamo in qualità di titolare del trattamento ai sensi della Sezione 6, scrivici direttamente.",
        ],
      },
      {
        id: "lgpd",
        heading: "12. I tuoi diritti ai sensi della LGPD",
        blocks: [
          "Se ti trovi in Brasile, la Lei Geral de Proteção de Dados ti riconosce i diritti corrispondenti: conferma dell'esistenza del trattamento, accesso, rettifica, anonimizzazione, blocco o cancellazione, portabilità, informazioni sulla condivisione e revoca del consenso. Le richieste seguono gli stessi canali indicati nella Sezione 11, e puoi presentare un'istanza all'ANPD. Il nostro team privacy, raggiungibile all'indirizzo privacy@agentes.chat, funge da nostro punto di contatto (encarregado).",
        ],
      },
      {
        id: "dpa",
        heading: "13. Accordo sul trattamento dei dati",
        blocks: [
          "Un DPA relativo al nostro trattamento del Contenuto del Workspace, comprensivo delle Clausole contrattuali tipo e delle clausole sul trattamento previste dalla LGPD, è disponibile per ogni workspace. Puoi richiederlo all'indirizzo legal@agentes.chat.",
        ],
      },
      {
        id: "cookies",
        heading: "14. Cookie e archiviazione locale",
        blocks: [
          "Il workspace utilizza solo i cookie e l'archiviazione locale necessari per mantenere l'accesso, proteggere i moduli e ricordare preferenze quali il tema e la lingua. Il sito pubblico agentes.chat ricorda la lingua che hai scelto e utilizza le analisi di Himetrica (Sezione 2). Non utilizziamo cookie pubblicitari né cookie di tracciamento tra siti.",
          "**Cookie di referral:** quando apri un link di referral verso agentes.chat, il nostro servizio di fatturazione conserva il referral in un cookie nel tuo browser per 60 giorni, così chi ha inviato il link riceve il credito se ti abboni. Nello Spazio economico europeo, nel Regno Unito e in Svizzera lo impostiamo solo dopo che hai dato il consenso su agentes.chat. Per dimenticare il referral su questo dispositivo, apri https://agentes.chat/it/privacy?forget-referral#cookies.",
        ],
      },
      {
        id: "children",
        heading: "15. Minori",
        blocks: [
          "Il Servizio è uno strumento di lavoro per adulti. Non è rivolto a persone di età inferiore a 18 anni e non raccogliamo consapevolmente i loro dati personali. Se ritieni che un minore ci abbia fornito dati personali, scrivi a privacy@agentes.chat e li elimineremo.",
        ],
      },
      {
        id: "changes",
        heading: "16. Modifiche alla presente informativa",
        blocks: [
          "Possiamo aggiornare la presente informativa. Le modifiche sostanziali saranno annunciate via e-mail o nell'app prima della loro entrata in vigore. La versione vigente è sempre disponibile in questa pagina. In caso di divergenza tra una traduzione e la versione inglese, prevale la versione inglese, salvo diversa disposizione di legge.",
        ],
      },
      {
        id: "contact",
        heading: "17. Contatti",
        blocks: [
          "AGENTESCHAT, LLC, che opera con il nome agentes.chat. Comunicazioni: 2810 North Church Street, Ste 91038, Wilmington, DE 19802, USA · privacy@agentes.chat. Le richieste relative alla protezione dei dati provenienti da UE, Regno Unito e Brasile raggiungono il nostro team privacy allo stesso indirizzo. Per ricevere aiuto con il Servizio, scrivi a support@agentes.chat. Per qualsiasi altra questione, scrivi a hello@agentes.chat.",
        ],
      },
    ],
  },
};
