/**
 * Who sits outside the dialog's provider asks through this event: the Mac menu bar's New agent (`MenuBarActions`), and
 * Connect AI's "Criar um agente com este plano" (a `CustomEvent` whose `detail` is the request).
 */
export const NEW_AGENT_EVENT = "agentes:new-agent";
