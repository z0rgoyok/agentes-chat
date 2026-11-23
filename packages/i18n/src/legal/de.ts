import type { LegalDocument, LegalKind } from "./types";

/** Terms and Privacy in de, each with its `courtesy` notice: a page not here shows in English. */
export const legalDe: Partial<Record<LegalKind, LegalDocument>> = {
  terms: {
    title: "Nutzungsbedingungen",
    summary:
      "Die Vereinbarung über die Nutzung von agentes.chat: Ihr Workspace, Ihre Agenten und wofür jede Seite verantwortlich ist.",
    courtesy:
      "Dies ist eine unverbindliche Übersetzung. Weicht sie von der englischen Fassung ab, ist die englische Fassung maßgeblich.",
    updated: "2026-11-20",
    sections: [
      {
        id: "agreement",
        heading: "1. Vereinbarung",
        blocks: [
          "Diese Nutzungsbedingungen (die „Bedingungen“) sind eine verbindliche Vereinbarung zwischen der AGENTESCHAT, LLC, einer Gesellschaft mit beschränkter Haftung (limited liability company) nach dem Recht des Bundesstaates Delaware, die unter dem Namen agentes.chat geschäftlich tätig ist („agentes.chat“, „wir“, „uns“), und der natürlichen oder juristischen Person, die ein Konto oder einen Workspace anlegt („Sie“). Indem Sie ein Konto anlegen, einem Workspace beitreten oder agentes.chat auf andere Weise im Web, in der Mac-App oder in der Smartphone-App (der „Dienst“) nutzen, akzeptieren Sie diese Bedingungen und unsere Datenschutzerklärung. Wenn Sie den Dienst im Namen eines Unternehmens oder einer anderen Organisation nutzen, sichern Sie zu, dass Sie befugt sind, diese rechtlich zu verpflichten.",
          "Um den Dienst zu nutzen, müssen Sie mindestens 18 Jahre alt und in der Lage sein, einen Vertrag zu schließen.",
        ],
      },
      {
        id: "service",
        heading: "2. Der Dienst",
        blocks: [
          "Der Dienst ist ein Workspace, in dem Menschen und KI-Agenten zusammenarbeiten. Er umfasst Kanäle, Threads und Direktnachrichten sowie Agenten mit eigenen Rollen, Anweisungen, Erinnerungen und Budgets. Außerdem umfasst er Aufgaben, Wiki, Drive, Kalender und Routinen, Freigaben, Konnektoren zu anderen Diensten und die Möglichkeit, Computer anzubinden, auf denen Agenten arbeiten können.",
          "Der Dienst ist neu und entwickelt sich weiter: Funktionen können sich ändern, eingeschränkt oder entfernt werden. Wir können neue Konten für eine gewisse Zeit nur auf Einladung eröffnen oder für jeden, der sich registriert. Soweit praktikabel, informieren wir Sie im Voraus, bevor wir etwas entfernen, auf das Sie angewiesen sind.",
        ],
      },
      {
        id: "accounts",
        heading: "3. Konten und Workspaces",
        blocks: [
          "Sie sind verantwortlich für die Richtigkeit Ihrer Kontoangaben, für die Sicherheit Ihrer Zugangsdaten und für sämtliche Aktivitäten unter Ihrem Konto. Die Eigentümer und Administratoren eines Workspace entscheiden, wer ihm beitritt, welche Rollen diese Personen haben, welche Agenten es gibt und was diese Agenten tun dürfen. Wenn diese Bedingungen davon sprechen, dass ein Workspace etwas besitzt, über etwas entscheidet oder für etwas einsteht, ist damit die natürliche oder juristische Person gemeint, die ihn angelegt hat oder in deren Namen er angelegt wurde, handelnd durch seine Eigentümer und Administratoren. Benachrichtigen Sie uns unverzüglich unter security@agentes.chat, wenn Sie annehmen, dass ein Konto, ein Schlüssel oder ein angebundener Computer kompromittiert wurde.",
        ],
      },
      {
        id: "agents",
        heading: "4. Agenten und ihr Handeln",
        blocks: [
          "Agenten handeln auf Grundlage der Anweisungen, Berechtigungen, Konnektoren, Budgets und Computer, die Sie und Ihr Workspace ihnen zur Verfügung stellen. Was ein Agent im Rahmen dieser Berechtigungen tut, einschließlich der Nachrichten, die er sendet, des Codes, den er ändert, der Daten, die er liest, schreibt oder löscht, und der Befehle, die er auf einem Computer ausführt, geschieht im Namen Ihres Workspace, und Ihr Workspace ist dafür nach diesen Bedingungen verantwortlich. Für jeden Agenten ist eine Person verantwortlich.",
          "Aktionen, die schwer rückgängig zu machen sind, werden vor ihrer Ausführung zu einer Freigabeanfrage an eine Person, es sei denn, Ihr Workspace hat diesen Agenten so eingestellt, dass er ohne Nachfrage handelt. Die Erteilung einer Freigabe ist Ihre Entscheidung. Der Dienst zeigt an, was ausgeführt wird, die Prüfung obliegt jedoch Ihnen.",
          "KI-Ausgaben können falsch, unvollständig oder veraltet sein, auch wenn sie überzeugt klingen. Prüfen Sie, was Agenten erzeugen, bevor Sie sich darauf verlassen, und verwenden Sie es weder als Ersatz für fachliche Beratung (rechtlicher, medizinischer, finanzieller oder sonstiger Art) noch als alleinige Grundlage für Entscheidungen mit rechtlicher oder ähnlich erheblicher Wirkung für Menschen.",
        ],
      },
      {
        id: "acceptable-use",
        heading: "5. Zulässige Nutzung",
        blocks: [
          "Sie verpflichten sich, den Dienst nicht zu nutzen und Agenten nicht nutzen zu lassen, um:",
          {
            list: [
              "gegen Gesetze zu verstoßen, Rechte anderer zu verletzen oder personenbezogene Daten ohne Rechtsgrundlage zu verarbeiten",
              "Spam oder unerwünschte Nachrichten zu versenden oder jemanden zu belästigen, zu bedrohen, zu täuschen oder sich als jemand anderes auszugeben",
              "Schadsoftware, Phishing oder Inhalte zu erstellen oder zu verbreiten, die Minderjährige sexualisieren, Gewalt fördern oder auf andere Weise rechtswidrig sind",
              "die Grenzen und Schutzmechanismen des Dienstes zu umgehen, etwa Budgets, Ratenbegrenzungen, Freigaben, Berechtigungen oder die Prüfungen bei angebundenen Computern und Datenbanken",
              "den Dienst oder über ihn andere anzugreifen, einschließlich der Suche nach Schwachstellen, seiner Überlastung oder des Einschleusens von Anweisungen, die darauf abzielen, die Agenten anderer Personen zu übernehmen",
              "auf einen Dienst, einen Computer oder Daten zuzugreifen, zu deren Nutzung Sie nicht berechtigt sind, oder einen angebundenen Dienst entgegen dessen eigenen Bedingungen zu nutzen",
              "gegen die Nutzungsrichtlinien der KI-Modellanbieter zu verstoßen, auf deren Modellen Ihre Agenten laufen.",
            ],
          },
          "Wir können einen Agenten, einen Konnektor oder ein Konto sperren, soweit praktikabel nach vorheriger Mitteilung, wenn Aktivitäten die Sicherheit, die Integrität oder den rechtmäßigen Betrieb des Dienstes oder Dritter gefährden. Wir können mutmaßliche Verstöße gegen diesen Abschnitt untersuchen, auch indem wir Workspace-Inhalte lesen, wie es die Datenschutzerklärung beschreibt.",
        ],
      },
      {
        id: "content",
        heading: "6. Ihre Inhalte",
        blocks: [
          "„Workspace-Inhalte“ bezeichnet alles, was Sie und die anderen Personen in Ihrem Workspace in den Dienst einbringen, und alles, was Ihre Agenten darin erzeugen. Ihr Workspace ist Eigentümer seiner Workspace-Inhalte, und im Verhältnis zwischen Ihnen und uns gehören die Ausgaben, die Agenten für Sie erzeugen, Ihnen, vorbehaltlich der Bedingungen des Modellanbieters, der sie erzeugt hat. Ausgaben können dem ähneln, was dieselben Modelle für andere erzeugen.",
          "Sie räumen uns die beschränkten Rechte ein, die für den Betrieb des Dienstes erforderlich sind: Workspace-Inhalte zu speichern, zu verarbeiten, zu übermitteln und anzuzeigen, um Ihren Workspace und Ihre Agenten zu betreiben, sie wie in der Datenschutzerklärung beschrieben an die Anbieter, die Ihre Agenten nutzen, und an die Unternehmen zu übermitteln, die sie für uns verarbeiten, Support zu leisten, den Dienst funktionsfähig und sicher zu halten, diese Bedingungen durchzusetzen und das Gesetz einzuhalten. Wir verkaufen keine Workspace-Inhalte und verwenden sie nicht zum Training von Modellen des maschinellen Lernens.",
          "Ihr Workspace ist Verantwortlicher für die personenbezogenen Daten in seinen Workspace-Inhalten, und wir verarbeiten diese Daten als Auftragsverarbeiter nach seinen Weisungen, wie in der Datenschutzerklärung und im Auftragsverarbeitungsvertrag beschrieben. Für Vertrauen und Sicherheit, die Sicherheit des Dienstes und das, was das Gesetz von uns verlangt, handeln wir als eigenständiger Verantwortlicher, wie es Abschnitt 6 der Datenschutzerklärung beschreibt.",
        ],
      },
      {
        id: "third-parties",
        heading: "7. Modellanbieter, Konnektoren und Ihre eigenen Konten",
        blocks: [
          "Agenten laufen auf KI-Modellen von Dritten (etwa Anthropic, dem Hersteller von Claude, und OpenAI), und zwar über einen API-Schlüssel, den Ihr Workspace hinterlegt, oder über ein KI-Abonnement wie Claude oder ChatGPT, das eine Person in Ihrem Workspace verbindet. Die Nutzung dieses Schlüssels oder Abonnements unterliegt zusätzlich Ihrer Vereinbarung mit dem jeweiligen Anbieter, und Sie sind für die Einhaltung seiner Bedingungen und für seine Entgelte verantwortlich.",
          "Konnektoren gewähren Agenten Zugriff auf andere Dienste (etwa GitHub, Google, Linear, Sentry oder ein E-Mail-Postfach). Diese Dienste werden von Dritten zu deren eigenen Bedingungen bereitgestellt. Ihre Verfügbarkeit und ihr Umgang mit Daten liegen außerhalb unseres Einflussbereichs.",
        ],
      },
      {
        id: "computers",
        heading: "8. Angebundene Computer",
        blocks: [
          "Wenn Sie einen Computer anbinden, installieren Sie Software, mit der Agenten darauf Befehle ausführen und einen Browser nutzen können, innerhalb der Ordner und Berechtigungen, die Sie auf diesem Computer festlegen. Sie sind für den Computer verantwortlich, für das, was Sie dort zulassen, und dafür, Sicherungskopien des Wichtigen anzulegen. Berechtigungen können nur auf dem Computer selbst erweitert werden, und Sie können die Verbindung jederzeit trennen.",
        ],
      },
      {
        id: "data-protection",
        heading: "9. Datenschutz",
        blocks: [
          "Soweit die DSGVO, die UK GDPR oder das LGPD auf personenbezogene Daten in Ihren Workspace-Inhalten anwendbar ist, erfüllt jede Partei ihre Pflichten nach diesem Recht. Ein Auftragsverarbeitungsvertrag (Data Processing Addendum, DPA), der die Standardvertragsklauseln der Europäischen Kommission und gleichwertige Bestimmungen nach dem LGPD einbezieht, ist erhältlich und wird nach Unterzeichnung Bestandteil dieser Bedingungen. Fordern Sie ihn unter legal@agentes.chat an. Die aktuelle Liste der Unterauftragsverarbeiter steht in der Datenschutzerklärung. Eine Supportanfrage, die ein Mitglied Ihres Workspace uns sendet, ist die Weisung Ihres Workspace an uns, zu lesen, worum es in der Anfrage geht.",
        ],
      },
      {
        id: "fees",
        heading: "10. Tarife, Zahlungen und faire Nutzung",
        blocks: [
          "Jeder Workspace bezahlt seinen eigenen agentes.chat-Tarif. Die folgenden Regeln gelten für jeden Tarif:",
          {
            list: [
              "**Verkäufer.** Jeder Kauf wird bei der AGENTESCHAT, LLC, einem in Delaware gegründeten Unternehmen der Vereinigten Staaten, getätigt und von diesem abgerechnet.",
              "**Preise.** Die Tarife und ihre Preise finden Sie auf unserer Preisseite. Die Preise verstehen sich in US-Dollar, zuzüglich anfallender Steuern. Ihre Bank oder Ihr Zahlungsdienstleister kann für Käufe im Ausland eigene Gebühren erheben, etwa die IOF in Brasilien.",
              "**Verlängerung.** Ein Tarif verlängert sich je nach gewähltem Zeitraum automatisch jeden Monat oder jedes Jahr, bis er gekündigt wird. Vor der Verlängerung eines Jahrestarifs senden wir eine Erinnerung.",
              "**Kündigung.** Sie können jederzeit kündigen. Die Kündigung wird zum Ende des bereits bezahlten Zeitraums wirksam. Danach werden die Agenten des Workspace angehalten, sein Computer wird 7 Tage später gelöscht, und seine Unterhaltungen und Dateien bleiben 90 Tage lang zum Lesen und Herunterladen verfügbar und werden anschließend gelöscht.",
              "**Keine Erstattungen.** Jeder Tarif verursacht ab dem Kauf Betriebskosten, etwa für die Nutzung von KI-Modellen, für Server und für den Computer des Workspace. Deshalb sind Käufe endgültig und werden weder ganz noch teilweise erstattet, auch nicht für den Rest eines Zeitraums nach einer Kündigung.",
              "**Fehlgeschlagene Zahlungen.** Schlägt eine Zahlung fehl, versuchen wir es in den folgenden Tagen erneut. Schlägt sie weiterhin fehl, wird der Workspace pausiert: Seine Agenten werden angehalten, die Personen können darin aber weiterhin lesen und schreiben. Sein Computer wird 7 Tage lang vorgehalten, dann freigegeben und gelöscht. Mit der Zahlung wird der Workspace wiederhergestellt, auf einem neuen Computer, falls der alte freigegeben wurde.",
              "**Preisänderungen.** Wir können die Preise für Neukunden jederzeit ändern. Der Preis eines Tarifs, den Sie bereits haben, ändert sich nur aufgrund neuer Steuern, ab seiner nächsten Verlängerung und mit einer Ankündigungsfrist von mindestens 30 Tagen.",
              "**Faire Nutzung.** Einige Funktionen laufen auf KI-Diensten, die wir ohne Aufpreis bereitstellen, etwa die Auswahl, welcher Agent antwortet, die Bewertung von Erinnerungen und Aktionen sowie das Auffinden der Stelle, auf die auf einem Bildschirm geklickt werden soll. Wir können sie für einen Workspace einschränken, dessen Nutzung weit über dem Üblichen liegt.",
              "**Budgets.** Pro Workspace und pro Agent festgelegte Budgets stoppen die Modellnutzung der Agenten, sobald sie erreicht sind. Sie sind Teil des Dienstes und kein Mangel desselben. Entgelte, die ein Anbieter für Ihren eigenen Schlüssel oder Ihr eigenes KI-Abonnement berechnet, betreffen ausschließlich Sie und diesen Anbieter.",
            ],
          },
        ],
      },
      {
        id: "ip",
        heading: "11. Geistiges Eigentum und Feedback",
        blocks: [
          "Mit Ausnahme Ihrer Workspace-Inhalte behalten wir und unsere Lizenzgeber sämtliche Rechte, Titel und Ansprüche am Dienst, einschließlich seiner Software, seines Designs sowie des Namens und der Marken agentes.chat. Feedback, das Sie uns freiwillig senden, darf ohne jede Verpflichtung Ihnen gegenüber verwendet werden.",
        ],
      },
      {
        id: "termination",
        heading: "12. Laufzeit und Beendigung",
        blocks: [
          "Sie können die Nutzung des Dienstes jederzeit einstellen und Ihr Konto in der App löschen. Es wird 7 Tage später entfernt, und Sie können es bis dahin wiederherstellen. Wir können Ihren Zugang bei einem wesentlichen Verstoß gegen diese Bedingungen, wenn das Gesetz es verlangt, oder mit einer Frist von 30 Tagen bei Einstellung des Dienstes sperren oder beenden. Beenden wir den Dienst aus anderen Gründen als Ihrem Verstoß, stellen wir Ihre Workspace-Inhalte 30 Tage lang zum Export bereit und löschen sie anschließend wie in der Datenschutzerklärung beschrieben. Abschnitte, die ihrer Natur nach über die Beendigung hinaus fortgelten (darunter 6, 9, 11, 13, 14 und 15), gelten fort.",
        ],
      },
      {
        id: "disclaimers",
        heading: "13. Gewährleistungsausschluss",
        blocks: [
          "Der Dienst, einschließlich allem, was Agenten erzeugen und tun, wird „wie besehen“ („as is“) und „nach Verfügbarkeit“ („as available“) bereitgestellt. Wir gewährleisten nicht, dass der Dienst oder die Agenten ununterbrochen, fehlerfrei, genau oder für Ihre Zwecke geeignet sind. Im größtmöglichen gesetzlich zulässigen Umfang schließen wir alle stillschweigenden Gewährleistungen aus, einschließlich der Marktgängigkeit, der Eignung für einen bestimmten Zweck und der Nichtverletzung von Rechten Dritter.",
        ],
      },
      {
        id: "liability",
        heading: "14. Haftungsbeschränkung",
        blocks: [
          "Im größtmöglichen gesetzlich zulässigen Umfang gilt: Keine Partei haftet für indirekte Schäden, Neben-, besondere oder Folgeschäden oder Strafschadensersatz oder für entgangenen Gewinn, Umsatz oder Datenverlust. Im selben Umfang ist unsere Gesamthaftung aus dem Dienst auf die Beträge beschränkt, die Sie uns in den zwölf Monaten vor dem Ereignis gezahlt haben, das den Anspruch begründet (oder USD 100, wenn Sie nichts gezahlt haben). Diese Beschränkungen gelten nicht für Ihre Zahlungspflichten, Ihren Verstoß gegen Abschnitt 5 oder eine Haftung, die gesetzlich nicht beschränkt werden kann.",
        ],
      },
      {
        id: "indemnification",
        heading: "15. Freistellung",
        blocks: [
          "Sie werden uns gegen Ansprüche Dritter verteidigen und uns von diesen freistellen, die sich aus Ihren Workspace-Inhalten, aus dem, was Ihre Agenten im Rahmen der von Ihnen erteilten Berechtigungen getan haben, oder aus Ihrem Verstoß gegen Abschnitt 5 ergeben.",
        ],
      },
      {
        id: "law",
        heading: "16. Anwendbares Recht",
        blocks: [
          "Diese Bedingungen und jeder Kauf auf ihrer Grundlage unterliegen dem Recht der Vereinigten Staaten und des Bundesstaates Delaware, unter Ausschluss der kollisionsrechtlichen Bestimmungen, und die Parteien unterwerfen sich der ausschließlichen Zuständigkeit der einzelstaatlichen Gerichte und der Bundesgerichte mit Sitz in Delaware.",
        ],
      },
      {
        id: "changes",
        heading: "17. Änderungen dieser Bedingungen",
        blocks: [
          "Wir können diese Bedingungen aktualisieren. Wesentliche Änderungen werden mindestens 14 Tage vor ihrem Inkrafttreten per E-Mail oder in der App angekündigt. Die fortgesetzte Nutzung nach dem Zeitpunkt des Inkrafttretens gilt als Zustimmung. Die aktuelle Fassung ist stets auf dieser Seite abrufbar. Weicht eine Übersetzung von der englischen Fassung ab, ist die englische Fassung maßgeblich, sofern das Gesetz nichts anderes vorschreibt.",
        ],
      },
      {
        id: "contact",
        heading: "18. Kontakt",
        blocks: [
          "AGENTESCHAT, LLC, geschäftlich tätig unter dem Namen agentes.chat. Mitteilungen: 2810 North Church Street, Ste 91038, Wilmington, DE 19802, USA · legal@agentes.chat · Hilfe zum Dienst: support@agentes.chat · Alles andere: hello@agentes.chat",
        ],
      },
    ],
  },
  privacy: {
    title: "Datenschutzerklärung",
    summary:
      "Welche Daten wir erheben, was Agenten wohin senden, wer Ihren Workspace sehen kann und welche Rechte Sie haben.",
    courtesy:
      "Dies ist eine unverbindliche Übersetzung. Weicht sie von der englischen Fassung ab, ist die englische Fassung maßgeblich.",
    updated: "2026-11-20",
    sections: [
      {
        id: "overview",
        heading: "1. Überblick",
        blocks: [
          "Die AGENTESCHAT, LLC, eine Gesellschaft mit beschränkter Haftung (limited liability company) nach dem Recht des Bundesstaates Delaware, die unter dem Namen agentes.chat geschäftlich tätig ist („agentes.chat“, „wir“), betreibt agentes.chat: einen Workspace, in dem Menschen und KI-Agenten zusammenarbeiten, verfügbar im Web, als Mac-App und als Smartphone-App (der „Dienst“). Diese Erklärung unterscheidet drei Rollen:",
          {
            list: [
              "Für **Kontodaten**, also die Informationen, die Personen uns zum Anlegen und Nutzen eines Kontos übermitteln, sind wir der Verantwortliche.",
              "Für **Workspace-Inhalte**, also alles, was die Personen und Agenten eines Workspace in ihn einbringen oder darin erzeugen, sind wir Auftragsverarbeiter und handeln nach den Weisungen des Workspace. Verantwortlicher ist der Workspace, d. h. die natürliche oder juristische Person, die ihn angelegt hat oder in deren Namen er angelegt wurde.",
              "Für die wenigen Fälle in Abschnitt 6, in denen wir für uns selbst handeln (Vertrauen und Sicherheit, die Sicherheit des Dienstes und das, was das Gesetz von uns verlangt), sind wir der Verantwortliche für die personenbezogenen Daten in den Workspace-Inhalten, die wir dafür lesen.",
            ],
          },
        ],
      },
      {
        id: "data-we-collect",
        heading: "2. Daten, die wir als Verantwortlicher erheben",
        blocks: [
          {
            list: [
              "**Kontodaten:** Name, E-Mail-Adresse, Passwort-Hash, Profilfoto, Sprache und Zeitzone. Wenn Sie sich mit Google, Apple oder GitHub anmelden, erhalten wir von diesem Anbieter Ihren Namen, Ihre E-Mail-Adresse und die Kontokennung, niemals jedoch Ihr Passwort.",
              "**Workspace-Daten:** Name, Mitglieder, Rollen und Einladungen des Workspace.",
              "**Supportanfragen:** was Sie uns senden, wenn Sie um Hilfe bitten: Ihre Worte, das, was Sie gemeldet haben, und was darin steht, der Bildschirm, auf dem Sie sich befanden, sowie alle Bilder oder Videos, die Sie anhängen.",
              "**Abrechnungsdaten:** für einen Workspace mit einem agentes.chat-Tarif Name, E-Mail-Adresse, Rechnungsadresse und Steuernummer der zahlenden Person, der Tarif sowie dessen Rechnungen und Zahlungen. Zahlungen werden von Stripe abgewickelt, das die Kartendaten verarbeitet: Diese erreichen uns nie.",
              "**Nutzungs- und Protokolldaten:** IP-Adressen, Browser und Gerät, Anmeldesitzungen, Sicherheitsereignisse, API-Anfragen sowie der Datensatz jedes Modellaufrufs (Modell, Tokens und Kosten, mit dem zugehörigen Workspace und Agenten), den wir speichern, um Budgets durchzusetzen und die Nutzung anzuzeigen. Wenn etwas fehlschlägt, erfassen wir den Fehler ohne Nachrichteninhalte, um ihn zu beheben. Außerdem führen wir eine Aufzeichnung über jeden Fall, in dem unser Team oder ein KI-Assistent, der für unser Team arbeitet, Workspace-Inhalte mit den Werkzeugen oder der Konsole gelesen hat, die Abschnitt 6 beschreibt: wer oder was gelesen hat, welches Element, wann und warum, niemals den Inhalt selbst.",
              "**Geräte:** für die Smartphone-App das Push-Benachrichtigungstoken jedes Geräts, auf dem Sie sich anmelden. Für angebundene Computer und die Mac-App Name, Betriebssystem und App-Version des Computers.",
              "**Warteliste:** die E-Mail-Adresse und die Sprache, die Sie uns auf agentes.chat angeben, und ob Sie die Adresse bestätigt haben.",
              "**Website-Analyse:** auf agentes.chat (der öffentlichen Website, nicht dem Workspace) die aufgerufenen Seiten, die verweisende Website, der Gerätetyp und ein aus der IP-Adresse abgeleiteter ungefährer Standort, erhoben mit Himetrica.",
            ],
          },
        ],
      },
      {
        id: "how-we-use",
        heading: "3. Wie wir Kontodaten verwenden",
        blocks: [
          "Um den Dienst bereitzustellen und abzusichern (einschließlich der Erkennung und Unterbindung von Missbrauch), Tarife abzurechnen, Budgets und Grenzen anzuwenden, Supportanfragen zu beantworten, gesetzliche Pflichten zu erfüllen und Dienstnachrichten zu senden, etwa E-Mail-Bestätigungen, Einladungen, Passwortzurücksetzungen, Freigabeanfragen und Benachrichtigungen, die Sie aktiviert haben. Der Warteliste senden wir E-Mails nur, um die Adresse zu bestätigen und Sie einzuladen.",
          "Um Supportanfragen zu beantworten und um Störungen und mutmaßlichem Missbrauch nachzugehen, setzen wir KI-Assistenten ein, die für unser Team arbeiten. Sie denken mit Claude-Modellen. Diese Modelle werden von Anthropic, dem Hersteller von Claude, bereitgestellt: Die Assistenten erreichen diesen Anbieter über dessen API, zu dessen kommerziellen Bedingungen, die es ihm nicht erlauben, seine Modelle mit dem zu trainieren, was er erhält. Sie lesen Konto- und Nutzungsaufzeichnungen: Kennungen, Zustände und Zeitpunkte, den Text von Fehlern, die unsere Systeme erfasst haben (mit maskierten Zugangsdaten und Adressen), und einen Namen, wo ein Fall einen benötigt. Sie können einen solchen Fehler im Web nachschlagen. Eine Person aus unserem Team kann einem Fall auch mit einem KI-Werkzeug nachgehen, das sie selbst nutzt und das ebenfalls mit Claude-Modellen denkt: Dieses Werkzeug erhält, was die Person liest, und das kann die E-Mail-Adresse einer Person einschließen.",
          "Wenn ein Workspace angelegt wird, prüfen wir seine Registrierung auf Missbrauch: Die Domain der E-Mail-Adresse geht an die Registrierungsstelle (Registry) der Domain, das Netzwerk der ersten Anmeldung (niemals die Adresse) an Team Cymru und der Name des Workspace an TypeSafe. Auf den Registrierungs- und Anmeldeseiten liest eine von unserem Netzwerkanbieter betriebene Bot-Prüfung Signale aus Ihrem Browser.",
          "Wir verkaufen keine personenbezogenen Daten, verwenden Workspace-Inhalte nicht zum Training von Modellen des maschinellen Lernens und gestatten dies auch unseren Unterauftragsverarbeitern nicht.",
        ],
      },
      {
        id: "workspace-content",
        heading: "4. Workspace-Inhalte, verarbeitet im Auftrag von Workspaces",
        blocks: [
          "Zu den Workspace-Inhalten gehören Nachrichten in Kanälen, Threads und Direktnachrichten, Dateien im Drive und Wiki-Seiten. Dazu gehören außerdem Aufgaben, Routinen, Kalendertermine und Freigaben, die Anweisungen, Einstellungen und Erinnerungen von Agenten, was Agenten schreiben und tun, sowie die Daten, die Agenten über die Konnektoren, Datenbanken und Computer lesen, die der Workspace anbindet. Wir verarbeiten sie nur, um den Workspace und seine Agenten so zu betreiben, wie der Workspace sie konfiguriert, um sie den Mitgliedern des Workspace anzuzeigen, um die von ihnen gewünschten Benachrichtigungen zu senden, um Support zu leisten, um den Dienst funktionsfähig und sicher zu halten, und in den Fällen des Abschnitts 6, in denen wir für uns selbst handeln.",
          "Workspace-Inhalte gehören dem Workspace: Mitglieder sehen, was seine Kanäle und Berechtigungen zulassen, und seine Eigentümer und Administratoren verwalten sie. Eigentümer und Administratoren des Workspace können jeden Kanal, jede Aufgabe und jede Wiki-Seite sehen, auch private. Direktnachrichten zwischen anderen Personen können sie nicht lesen. Nachrichten, die Sie gepostet haben, verbleiben im Workspace, nachdem Sie ihn verlassen oder Ihr Konto löschen, es sei denn, der Workspace löscht sie.",
        ],
      },
      {
        id: "agents",
        heading: "5. Wie Agenten Workspace-Inhalte verarbeiten",
        blocks: [
          "Agenten sind KI-Modelle, die innerhalb des Workspace lesen und handeln. Workspace-Inhalte verlassen unsere Server in den folgenden Fällen. Die Unternehmen, die sie für uns verarbeiten, sind in Abschnitt 9 aufgeführt.",
          {
            list: [
              "**Zwischen Geräten und unseren Servern.** Alles, was zwischen unseren Servern und den Browsern, Apps und Computern übertragen wird, die sich mit ihnen verbinden, einschließlich der Workspace-Inhalte, läuft über unseren Netzwerkanbieter, der den Dienst vor Angriffen schützt. Dazu entschlüsselt der Netzwerkanbieter diesen Datenverkehr in seinem dem jeweiligen Gerät nächstgelegenen Rechenzentrum und verarbeitet ihn in unserem Auftrag.",
              "**Antworten.** Wenn ein Agent arbeitet, sendet er den benötigten Kontext (den Kontext des Workspace, die Anweisungen des Agenten, die Unterhaltung, relevante Erinnerungen und die Ergebnisse seiner Werkzeuge) an den für diesen Agenten gewählten Modellanbieter. Mit einem API-Schlüssel, den der Workspace hinterlegt hat, erfolgt der Aufruf über das eigene Konto des Workspace und auf Grundlage seiner eigenen Vereinbarung mit diesem Anbieter. Einige Anbieter leiten den Aufruf an das Unternehmen weiter, das das Modell entwickelt oder hostet, und dieses verarbeitet ihn dann ebenfalls zu den Bedingungen dieses Anbieters. Ist mit einem Agenten ein KI-Abonnement wie Claude oder ChatGPT verbunden, arbeitet der Agent über das Konto der Person, die das Abonnement verbunden hat, und zu den Bedingungen des Anbieters.",
              "**Entscheidung, wer antwortet.** Ein Routing-Modell liest eine neue Nachricht, die Namen und Rollen der Agenten des Workspace und die jüngste Unterhaltung, um zu entscheiden, welcher Agent gegebenenfalls antworten soll. Es läuft bei TypeSafe oder, ersatzweise, beim Modellanbieter des Workspace. Das Routing gewährt einem Agenten niemals eine Berechtigung.",
              "**Erinnerungen.** Agenten bewahren Erinnerungen aus Unterhaltungen auf (Zusammenfassungen, Fakten und Erkenntnisse), damit sie sich mit der Zeit verbessern. Einige Beurteilungen von Erinnerungen (ob etwas aufbewahrenswert ist oder im Widerspruch zu dem steht, was ein Agent bereits weiß) nimmt TypeSafe vor. Erinnerungen können auf der Seite des Agenten eingesehen und entfernt werden und werden mit dem Workspace gelöscht.",
              "**Suche.** Um verwandte Nachrichten und Dokumente zu finden, kann Text von DeepInfra, Inc. in Vektoren (Embeddings) umgewandelt werden.",
              "**Konnektoren.** Wenn der Workspace einen Dienst anbindet (etwa GitHub, Google, Linear, Sentry, ein E-Mail-Postfach oder einen beliebigen MCP-Server), speichern wir dessen Zugriffstoken verschlüsselt und lesen oder schreiben in diesem Dienst nur innerhalb der Berechtigungsumfänge, die der Workspace jedem Agenten erteilt hat. Der angebundene Dienst verarbeitet diese Daten zu seinen eigenen Bedingungen. Verbindungen zu Gmail- und Outlook-Postfächern sowie zu Google Drive, Google Calendar, Google Sheets, Google Docs, Slack, Microsoft Teams, OneDrive, HubSpot, Salesforce, Zendesk, Asana, Figma, Intercom, Dropbox, Square, Instagram, Facebook, LinkedIn, YouTube, Pinterest, Reddit und WhatsApp laufen über Composio, das verarbeitet, was Agenten dort lesen und schreiben.",
              "**Datenbanken.** Datenbankverbindungen sind schreibgeschützt. Zugangsdaten werden verschlüsselt gespeichert, und jede Abfrage wird vor ihrer Ausführung geprüft.",
              "**Angebundene Computer.** Wenn jemand einen Computer anbindet, können Agenten dort Befehle ausführen und einen Browser nutzen, innerhalb der Ordner und Berechtigungen, die auf diesem Computer festgelegt sind. Die Live-Ansicht des Browsers eines Agenten läuft über unseren Netzwerkanbieter und über den Arbeitsspeicher unserer Server und wird nicht aufgezeichnet. Eine Zusammenfassung der Schritte, die der Agent ausgeführt hat (etwa besuchte Adressen und Aktionen), wird zusammen mit seiner Arbeit gespeichert, damit das Team sehen kann, was er getan hat.",
              "**Der Computer des Workspace.** Bei agentes.chat Cloud arbeiten die Agenten eines Workspace auf einem Computer, den wir für diesen Workspace in der Europäischen Union oder in den Vereinigten Staaten betreiben, auf unseren Servern oder denen eines Hosting-Anbieters. Wir erfassen pro Tag, wie viele Daten der Browser, die KI-Werkzeuge und die anderen Programme jedes Agenten dort senden und empfangen. Der Datenverkehr der Browser und Programme der Agenten dort geht über Adressen nach außen, die wir von einem Proxy-Anbieter mieten, der ihn überträgt. Der Computer wird nach dem Ende des agentes.chat-Tarifs des Workspace gelöscht, wie in den Nutzungsbedingungen beschrieben.",
              "**Support, Störungen und Sicherheit.** Wenn wir einer Supportanfrage, einer Störung oder mutmaßlichem Missbrauch nachgehen (Abschnitt 6), kann ein KI-Assistent, der für unser Team arbeitet, das betreffende Element lesen. Dieses Element wird dann an den Modellanbieter des Assistenten, den Hersteller von Claude, gesendet, der es in den Vereinigten Staaten verarbeitet, und in anderen Ländern, wenn er eine Anfrage dorthin leitet, auf Grundlage unserer Geschäftsvereinbarung mit ihm: Er darf nicht damit trainieren und löscht es innerhalb von 30 Tagen, mit Ausnahme dessen, was seine eigenen Missbrauchsprüfungen markieren, was er bis zu zwei Jahre aufbewahren darf. Wenn eine Person aus unserem Team das Element mit einem KI-Werkzeug liest, das sie selbst nutzt, geht es über dieses Werkzeug an denselben Anbieter.",
              "**Speicherung, E-Mail und Benachrichtigungen.** Hochgeladene Dateien und Sicherungen werden bei unseren Speicheranbietern aufbewahrt. E-Mails und Smartphone-Benachrichtigungen, die eine Nachricht zitieren, laufen über unseren E-Mail-Anbieter sowie über Apple und Google. Eine Supportanfrage, die Sie uns senden, erreicht unser Team zusammen mit dem, was Sie anhängen, per E-Mail.",
              "**Missbrauchsprüfungen.** Ein automatisierter Prüfer, der bei TypeSafe läuft, liest eine Stichprobe dessen, was Agenten getan haben. Wir bewahren nur sein Urteil auf.",
              "**Weitere KI-Dienste, die wir bereitstellen.** TypeSafe beurteilt außerdem, ob eine Aktion eines Agenten auf eine Person warten soll, wählt ein Modell oder Werkzeuge für eine Aufgabe aus und liest den Text oder das Bild eines Bildschirms, um zu finden, worauf geklickt werden soll, wenn ein Agent einen Computer nutzt.",
              "**Websuche.** Wenn ein Agent im Web sucht, gehen die Wörter, nach denen er sucht, an eine Suchmaschine: von unseren Servern aus an DuckDuckGo oder an diejenige, die der Agent in seinem eigenen Browser öffnet. Wenn er eine Seite öffnet, sieht die Website die Adresse, die er angefragt hat, wie bei jedem Besucher.",
              "**GIFs.** Wenn ein Agent oder eine Person nach einem GIF sucht, gehen die Suchwörter an den GIF-Anbieter GIPHY.",
            ],
          },
          "Aktionen, die schwer rückgängig zu machen sind (etwa das Zusammenführen von Code, ein Deployment oder das Senden im Namen einer Person), werden vor ihrer Ausführung zu einer Freigabeanfrage an eine Person, es sei denn, der Workspace hat diesen Agenten so eingestellt, dass er ohne Nachfrage handelt. Text, der von außerhalb des Workspace stammt (Webseiten, E-Mails, Dateien), wird als nicht vertrauenswürdig gekennzeichnet, bevor ein Agent ihn liest.",
        ],
      },
      {
        id: "staff-access",
        heading: "6. Wann Mitarbeitende von agentes.chat Workspace-Inhalte sehen können",
        blocks: [
          "Wir durchsuchen keine Workspaces. Außerhalb des Betriebs Ihres Workspace, den die Abschnitte 4 und 5 beschreiben, lesen unser Team und die KI-Assistenten, die für unser Team arbeiten, Workspace-Inhalte nur:",
          {
            list: [
              "**Auf Ihre Anfrage,** um bei einer Supportanfrage zu helfen, die ein Mitglied Ihres Workspace uns gesendet hat: aus der App, von der E-Mail-Adresse seines Kontos oder auf anderem Weg, sobald wir bestätigt haben, dass sie von ihm stammt. Wir lesen, worum es in der Anfrage geht, und nicht mehr, als das anfragende Mitglied sehen kann. Wenn unser KI-Assistent antwortet, antwortet er nur an die Adresse des Kontos dieses Mitglieds. Hierfür wird eine Direktnachricht nur gelesen, wenn jemand aus dieser Unterhaltung angefragt hat.",
              "**Um eine Störung zu beheben,** wenn im Dienst etwas fehlgeschlagen oder hängen geblieben ist, etwa die Arbeit eines Agenten, die mit einem Fehler endete oder nicht mehr vorankam. Wir lesen, worum es bei diesem Fehlschlag geht, und niemals eine Direktnachricht.",
              "**Aus Gründen von Vertrauen und Sicherheit,** um mutmaßlichen Missbrauch, Betrug, rechtswidrige Inhalte oder eine Gefahr für die Sicherheit des Dienstes oder anderer Personen zu erkennen und zu untersuchen oder um unsere Nutzungsbedingungen durchzusetzen. Wir können dies tun, ohne den Workspace zu diesem Zeitpunkt zu informieren. Wenn wir einen Workspace oder ein Konto einschränken, sagen wir, warum und wie dies angefochten werden kann, es sei denn, die Anordnung einer Behörde verbietet uns, dies zu sagen. Hierfür lesen wir in einer Direktunterhaltung nur, was zu einem Agenten oder von einem Agenten gesagt wurde, niemals Nachrichten zwischen Personen, es sei denn, jemand aus dieser Unterhaltung hat sie gemeldet oder das Gesetz verlangt es.",
              "**Wenn das Gesetz es verlangt.**",
            ],
          },
          "Auf Ihre Anfrage und zur Behebung einer Störung handeln wir nach den Weisungen des Workspace. Aus Gründen von Vertrauen und Sicherheit stützen wir uns auf unser berechtigtes Interesse daran, den Dienst und andere Personen sicher zu halten (Artikel 6 Absatz 1 Buchstabe f DSGVO und Artikel 7 Ziffer IX LGPD), und, wo das Gesetz es verlangt, auf diese gesetzliche Pflicht. Sie können widersprechen, wie es die Abschnitte 11 und 12 beschreiben.",
          "Unser Team und die KI-Assistenten, die für das Team arbeiten, lesen mit Werkzeugen, die jeweils ein einzelnes Element ausgeben. Jeder Lesevorgang mit diesen Werkzeugen erfolgt aus einem dieser Gründe und wird aufgezeichnet, bevor er stattfindet: wer oder was gelesen hat, welches Element, wann und warum. Die Personen, die agentes.chat leiten, erhalten diese Aufzeichnungen jeden Morgen. Ein Lesevorgang, der mit diesen Werkzeugen auf Ihre Anfrage oder zur Behebung einer Störung erfolgt und das betrifft, was Ihr Workspace geschrieben hat, erscheint außerdem im Audit-Protokoll Ihres Workspace: das Element, welcher dieser Gründe es war, und, bei einer Anfrage, wessen Anfrage (bei einer Direktnachricht nur, dass ein Lesevorgang stattgefunden hat und auf wessen Anfrage). Ein Lesevorgang, der mit ihnen aus Gründen von Vertrauen und Sicherheit erfolgt, wird dort vermerkt, wenn die Untersuchung endet, und spätestens sieben Tage nach dem Lesevorgang, es sei denn, das Gesetz verbietet uns, dies zu sagen. Wenn diese Werkzeuge einen Namen oder den Text eines Fehlers aus den Konto- und Nutzungsaufzeichnungen ausgeben, die Abschnitt 3 beschreibt, wird dieser Lesevorgang nur auf unserer Seite aufgezeichnet. Eine Person aus unserem Team kann außerdem in unserer Betreiberkonsole und aus einem aufgezeichneten Grund öffnen, was unsere Missbrauchsprüfungen in einem Workspace beurteilt haben. Dieser Lesevorgang wird auf unserer Seite aufgezeichnet.",
          "Die Personen, die unsere Infrastruktur betreiben, und die Werkzeuge, mit denen sie sie betreiben, haben Zugang zu den Servern und Datenbanken, in denen Workspace-Inhalte gespeichert sind. Sie nutzen diesen Zugang nur, um den Dienst am Laufen zu halten, etwa zur Wiederherstellung von Sicherungen, oder um eine gesetzliche Pflicht zu erfüllen. Keiner dieser Wege wird genutzt, um Profile, Werbung oder Trainingsdaten zu erstellen.",
        ],
      },
      {
        id: "retention",
        heading: "7. Speicherdauer",
        blocks: [
          {
            list: [
              "**Kontodaten:** für die Dauer des Bestehens des Kontos. Wenn Sie Ihr Konto in der App löschen, wird es sofort überall abgemeldet und 7 Tage später entfernt, sofern Sie es nicht vorher wiederherstellen, und verschwindet danach innerhalb von 30 Tagen aus unseren Sicherungen, mit Ausnahme von Aufzeichnungen, die wir gesetzlich aufbewahren müssen. Jeder Workspace, in dem Sie das einzige Mitglied waren, wird zum selben Zeitpunkt geschlossen, und seine Inhalte werden 7 Tage später wie nachstehend beschrieben gelöscht. Die Workspaces, denen Sie angehörten, behalten Ihren Namen und Ihre E-Mail-Adresse in ihren Audit-Protokollen, solange der jeweilige Workspace besteht.",
              "**Workspace-Inhalte:** für die Dauer des Bestehens des Workspace, und früher, wenn der Workspace bestimmte Inhalte löscht. Endet der agentes.chat-Tarif eines Workspace, bleiben seine Inhalte 90 Tage lang verfügbar und werden dann gelöscht. Löscht ein Eigentümer einen Workspace, wird dieser sofort für alle geschlossen, und seine Inhalte werden 7 Tage später gelöscht, sofern ein Eigentümer ihn nicht vorher wiederherstellt, und verschwinden danach innerhalb von 30 Tagen aus unseren Sicherungen, mit Ausnahme von Inhalten, die wir gesetzlich oder als Nachweis von Missbrauch (siehe unten) aufbewahren müssen, und mit Ausnahme der Auszüge, die wir für den Support oder eine Untersuchung lesen und für die ihre eigene Zeile weiter unten gilt.",
              "**Protokolle:** Anfrage- und Sicherheitsprotokolle bis zu 90 Tage. Aufzeichnungen über die Modellnutzung (Tokens und Kosten) für die Dauer des Bestehens des Workspace, da Budgets und Nutzungsberichte darauf beruhen.",
              "**Supportanfragen:** was Sie uns gesendet haben, als Sie um Hilfe baten, 90 Tage lang. Die E-Mail, in der es eingegangen ist, verbleibt 90 Tage lang im Postfach unseres Teams. Bilder und Videos 30 Tage lang (die Kopie in dieser E-Mail nicht mitgerechnet).",
              "**Support und Untersuchungen:** was wir lesen, um eine Supportanfrage zu beantworten oder einer Störung oder mutmaßlichem Missbrauch nachzugehen, sowie jede Kopie davon in unserem Arbeits-Thread, bis zu 90 Tage, nachdem wir es gelesen haben, auch wenn der Workspace es früher löscht, es sei denn, es ist ein Nachweis von Missbrauch (siehe unten). Unsere Schlussfolgerung zu einem Fall, die nichts von dem Inhalt enthält, verbleibt bei der Aufzeichnung des Falls. Unsere Aufzeichnung jedes Lesevorgangs mit den Werkzeugen, die Abschnitt 6 beschreibt (wer, wann, welches Element und warum, niemals der Inhalt), ein Jahr lang.",
              "**Abrechnungsdaten:** solange Sie für einen Workspace bezahlen, und danach so lange, wie es das Steuer- und Handelsrecht verlangt.",
              "**Warteliste:** bis Sie eingeladen werden und 12 Monate danach, oder bis Sie uns bitten, Sie zu entfernen.",
              "**Konten, die wir wegen Missbrauchs sperren oder schließen:** Wir können die Aufzeichnungen über das Konto und den Missbrauch über diese Fristen hinaus aufbewahren, auch nachdem die Löschung verlangt wurde, solange dies zur Geltendmachung, Ausübung oder Verteidigung von Rechtsansprüchen, zur Erfüllung gesetzlicher Pflichten und dazu erforderlich ist, dieselben Personen von erneutem Missbrauch des Dienstes abzuhalten, gemäß Artikel 17 Absatz 3 Buchstaben b und e und Artikel 6 Absatz 1 Buchstabe f DSGVO sowie Artikel 7 Ziffer VI, Artikel 7 Ziffer IX und Artikel 16 Ziffer I LGPD.",
            ],
          },
        ],
      },
      {
        id: "security",
        heading: "8. Sicherheit",
        blocks: [
          "Daten werden bei der Übertragung (TLS) verschlüsselt. Schlüssel von Modellanbietern, Konnektor-Token und Datenbank-Zugangsdaten werden mit einer Umschlagverschlüsselung (Envelope Encryption) pro Workspace verschlüsselt und niemals an den Browser oder die Apps zurückgesendet. Die Computer der Workspaces auf Servern, die wir selbst betreiben, und die Sicherungen ihrer Dateien sind im Ruhezustand verschlüsselt. Der Zugriff auf Produktivsysteme ist beschränkt und wird protokolliert. Erfahren wir von einer Verletzung des Schutzes personenbezogener Daten, benachrichtigen wir die betroffenen Workspaces unverzüglich und innerhalb der Fristen, die die DSGVO und das LGPD vorschreiben.",
        ],
      },
      {
        id: "transfers",
        heading: "9. Internationale Übermittlungen",
        blocks: [
          "Unsere Anwendung und ihre Datenbank laufen in den Vereinigten Staaten, und die in dieser Erklärung genannten Anbieter verarbeiten Daten in den Vereinigten Staaten, ausgenommen die Modellanbieter und angebundenen Dienste, die ein Workspace wählt, sowie die Unternehmen, an die diese Aufrufe weiterleiten, die Daten zu ihren eigenen Bedingungen in anderen Ländern verarbeiten können, und ausgenommen DuckDuckGo, GIPHY, DeepInfra, Inc., Team Cymru, die Registrierungsstelle der Domain einer E-Mail-Adresse, unser Proxy-Anbieter, der Push-Dienst des Herstellers Ihres Browsers und unsere Speicheranbieter, deren Standort wir nicht angeben. Der Modellanbieter unserer KI-Assistenten (Abschnitt 5) verarbeitet Daten in den Vereinigten Staaten, und in anderen Ländern, wenn er eine Anfrage dorthin leitet. Die Computer der Workspaces laufen in den Vereinigten Staaten und in der Europäischen Union. Unser Netzwerkanbieter verarbeitet den Datenverkehr in seinem dem jeweiligen Gerät nächstgelegenen Rechenzentrum, in den Vereinigten Staaten oder anderswo.",
          "**Unterauftragsverarbeiter.** Diese Unternehmen verarbeiten Workspace-Inhalte für uns:",
          {
            list: [
              "**Unser Netzwerkanbieter:** Netzwerk und Schutz vor Angriffen. Standort: die Vereinigten Staaten und sein dem jeweiligen Gerät nächstgelegenes Rechenzentrum.",
              "**Unsere Hosting-Anbieter:** Hosting der Anwendung und ihrer Datenbank sowie der Computer der Workspaces. Standort: Vereinigte Staaten für die Anwendung und ihre Datenbank, die Vereinigten Staaten und die Europäische Union für die Computer der Workspaces.",
              "**Unsere Anbieter für Dateispeicher und Sicherungsspeicher:** Speicherung hochgeladener Dateien und von Datenbanksicherungen sowie verschlüsselte Sicherungen der Computer der Workspaces.",
              "**MillionSend, ein Dienst der CODARI GLOBAL, LLC:** Zustellung und Empfang von E-Mails sowie die Postfächer unseres Teams, in denen Supportanfragen eingehen. Standort: Vereinigte Staaten.",
              "**TypeSafe:** KI-Dienste, die wir bereitstellen: die Auswahl, welcher Agent antwortet, die Beurteilung von Erinnerungen und Aktionen, das Lesen eines Bildschirms, Missbrauchsprüfungen. Standort: Vereinigte Staaten.",
              "**DeepInfra, Inc.:** Suche (Text-Embeddings).",
              "**Composio:** Verbindungen zu den in Abschnitt 5 aufgeführten Diensten. Standort: Vereinigte Staaten.",
              "**Apple Inc., Google LLC und der Push-Dienst des Herstellers Ihres Browsers:** Zustellung von Benachrichtigungen. Standort: Vereinigte Staaten für Apple und Google.",
              "**KI-Modelle (Claude):** bereitgestellt von Anthropic, dem Hersteller von Claude, für die KI-Assistenten für Support, Störungen und Sicherheit sowie für die KI-Werkzeuge, die unser Team nutzt. Nach unserer Geschäftsvereinbarung darf er nicht mit dem trainieren, was die Assistenten ihm senden. Standort: Vereinigte Staaten, und andere Länder, wenn er eine Anfrage dorthin leitet.",
            ],
          },
          "Die Modellanbieter und Dienste, die Ihr Workspace mit seinem eigenen Schlüssel, Abonnement oder Konto verbindet, arbeiten auf Grundlage Ihrer eigenen Vereinbarung mit ihnen und stehen nicht auf dieser Liste. Wir halten diese Liste aktuell, und wir werden Kunden mit einem unterzeichneten DPA über Änderungen bei Unterauftragsverarbeitern informieren, bevor die Änderung wirksam wird. Die vollständige Liste der Unternehmen, die auch unseren Netzwerkanbieter sowie unsere Hosting- und Speicheranbieter nennt, ist auf Anfrage unter legal@agentes.chat erhältlich, zusammen mit dem Auftragsverarbeitungsvertrag (Abschnitt 13).",
          "**Internationale Übermittlungen.** Daten werden fortlaufend übermittelt, solange der Workspace oder das Konto besteht, um den Dienst bereitzustellen. Für Kontodaten und für das, was wir für uns selbst lesen (Abschnitt 6), ist die AGENTESCHAT, LLC (privacy@agentes.chat) der Verantwortliche. Für die übrigen Workspace-Inhalte ist es der Workspace, und wir sind sein Auftragsverarbeiter. Wir geben Daten an die oben aufgeführten Unterauftragsverarbeiter und an die in dieser Erklärung genannten Anbieter weiter, jeweils zu dem dort angegebenen Zweck. Werden personenbezogene Daten, die der DSGVO oder der UK GDPR unterliegen, in ein Drittland übermittelt, stützen wir uns auf die Standardvertragsklauseln der Europäischen Kommission und das UK Addendum. Für Daten, die dem LGPD unterliegen, sind die von der brasilianischen Datenschutzbehörde genehmigten Standardvertragsklauseln (ANPD-Resolution 19/2024) in unserem Auftragsverarbeitungsvertrag enthalten. Jeder Workspace kann diesen Vertrag anfordern (Abschnitt 13). Er enthält alle diese Klauseln und die Sicherheitsmaßnahmen. Ihre Rechte und wie Sie sie ausüben, stehen in den Abschnitten 11 und 12, einschließlich des Rechts, eine Eingabe bei der ANPD einzureichen.",
        ],
      },
      {
        id: "apps",
        heading: "10. Smartphone- und Mac-Apps",
        blocks: [
          "Die Smartphone-App sendet Benachrichtigungen über Apple und Google. Eine Benachrichtigung kann den Namen der verfassenden Person und den Anfang der Nachricht anzeigen, und Sie wählen aus, welche Benachrichtigungen Sie erhalten. Die Mac-App und angebundene Computer speichern ihre Anmeldung auf dem Gerät. Das Löschen Ihres Kontos (auch in den Apps möglich) meldet alle Geräte ab.",
        ],
      },
      {
        id: "gdpr",
        heading: "11. Ihre Rechte nach der DSGVO",
        blocks: [
          "Wenn Sie sich im EWR oder im Vereinigten Königreich befinden, können Sie Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung und Datenübertragbarkeit verlangen, der Verarbeitung widersprechen und Beschwerde bei Ihrer Aufsichtsbehörde einlegen. Wenden Sie sich bei Kontodaten direkt an uns. Sie können Ihr Profil auch selbst in der App berichtigen und Ihr Konto selbst löschen. Bei personenbezogenen Daten in Workspace-Inhalten wenden Sie sich an die Eigentümer oder Administratoren des Workspace, der für diese Daten verantwortlich ist. Anfragen, die bei uns eingehen, leiten wir an diesen Workspace weiter und unterstützen ihn als Auftragsverarbeiter. Für das, was wir nach Abschnitt 6 als Verantwortlicher verarbeiten, schreiben Sie uns direkt.",
        ],
      },
      {
        id: "lgpd",
        heading: "12. Ihre Rechte nach dem LGPD",
        blocks: [
          "Wenn Sie sich in Brasilien befinden, gewährt Ihnen die Lei Geral de Proteção de Dados die entsprechenden Rechte: Bestätigung der Verarbeitung, Auskunft, Berichtigung, Anonymisierung, Sperrung oder Löschung, Datenübertragbarkeit, Information über die Weitergabe sowie Widerruf der Einwilligung. Anfragen laufen über dieselben Kanäle wie in Abschnitt 11, und Sie können eine Eingabe bei der ANPD einreichen. Unser Datenschutzteam, erreichbar unter privacy@agentes.chat, fungiert als unsere Kontaktstelle (encarregado).",
        ],
      },
      {
        id: "dpa",
        heading: "13. Auftragsverarbeitungsvertrag",
        blocks: [
          "Ein Auftragsverarbeitungsvertrag (DPA) über unsere Verarbeitung von Workspace-Inhalten, einschließlich der Standardvertragsklauseln und der Verarbeitungsbestimmungen nach dem LGPD, steht jedem Workspace zur Verfügung. Fordern Sie ihn unter legal@agentes.chat an.",
        ],
      },
      {
        id: "cookies",
        heading: "14. Cookies und lokaler Speicher",
        blocks: [
          "Der Workspace verwendet nur die Cookies und den lokalen Speicher, die erforderlich sind, um Sie angemeldet zu halten, Formulare zu schützen und Einstellungen wie Design und Sprache zu speichern. Die öffentliche Website agentes.chat speichert die von Ihnen gewählte Sprache und verwendet Himetrica-Analysen (Abschnitt 2). Wir verwenden keine Werbe-Cookies und keine Cookies zum websiteübergreifenden Tracking.",
          "**Empfehlungs-Cookie:** Wenn Sie einen Empfehlungslink zu agentes.chat öffnen, speichert unser Abrechnungsdienst die Empfehlung 60 Tage lang in einem Cookie in Ihrem Browser, damit Ihr Abonnement der Person gutgeschrieben wird, die den Link gesendet hat. Im Europäischen Wirtschaftsraum, im Vereinigten Königreich und in der Schweiz setzen wir es erst, nachdem Sie auf agentes.chat zugestimmt haben. Um die Empfehlung auf diesem Gerät zu vergessen, öffnen Sie https://agentes.chat/de/privacy?forget-referral#cookies.",
        ],
      },
      {
        id: "children",
        heading: "15. Kinder",
        blocks: [
          "Der Dienst ist ein Arbeitswerkzeug für Erwachsene. Er richtet sich an niemanden unter 18 Jahren, und wir erheben wissentlich keine personenbezogenen Daten solcher Personen. Wenn Sie annehmen, dass uns eine minderjährige Person personenbezogene Daten übermittelt hat, schreiben Sie an privacy@agentes.chat, und wir löschen sie.",
        ],
      },
      {
        id: "changes",
        heading: "16. Änderungen dieser Erklärung",
        blocks: [
          "Wir können diese Erklärung aktualisieren. Wesentliche Änderungen werden vor ihrem Inkrafttreten per E-Mail oder in der App angekündigt. Die aktuelle Fassung ist stets auf dieser Seite abrufbar. Weicht eine Übersetzung von der englischen Fassung ab, ist die englische Fassung maßgeblich, sofern das Gesetz nichts anderes vorschreibt.",
        ],
      },
      {
        id: "contact",
        heading: "17. Kontakt",
        blocks: [
          "AGENTESCHAT, LLC, geschäftlich tätig unter dem Namen agentes.chat. Mitteilungen: 2810 North Church Street, Ste 91038, Wilmington, DE 19802, USA · privacy@agentes.chat. Datenschutzanfragen aus der EU, dem Vereinigten Königreich und Brasilien erreichen unser Datenschutzteam unter derselben Adresse. Für Hilfe zum Dienst schreiben Sie an support@agentes.chat. Für alles andere schreiben Sie an hello@agentes.chat.",
        ],
      },
    ],
  },
};
