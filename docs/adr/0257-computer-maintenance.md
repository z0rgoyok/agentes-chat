# 0257. What we do to the workspace's computer is said, never a bare "Offline"

- Status: Accepted
- Date: 2026-11-26
- Amends: ADR 0241 §4 (a move is one kind of maintenance), ADR 0161 (unchanged: standby is never maintenance)
- Code: schema `machines.maintenance` (migration 0362, `moving_at` its latest word), engine `machines.ts`
  (`shownMaintenance`, `shownMoving`, `setMachineMaintenance`, `maintenancePhrase`, `maintenanceWords`,
  `MachineOfflineError`), `devices.ts`, `device-resolve.ts`, `machine-outages.ts`, `computer-queue.ts`,
  `task-manager.ts`, `machine-hub.ts` (status, hello), `brains/select.ts`, `brains/claude-code.ts`, `sandbox-tools.ts`;
  server `operator/machines.ts` (`PUT …/maintenance`), `routes/app/schemas.ts` (`MaintenanceView`); client
  `lib/computer-maintenance.ts`; web `machine-bits.tsx` (`MachineChip`, `MaintenanceHint`), `ComputerDialog.tsx`,
  `MachineOutages.tsx`, `devices/*`; phone `settings/MachineScreen.tsx`, `computer/ComputerScreen.tsx`,
  `outages/logic.ts`, `devices/logic.ts`

## Context

The Cloud said only when a move started and ended (`PUT …/moving`). A workspace's computer the Cloud restarted
because it stopped answering, during a move's copy that overloaded it, showed "Offline" with nothing else: the restart
came before the copy said it moved again, and a move's word counted for two hours from its start. A move called off by
an operator never said it ended, so the same computer could later read "Moving" for up to two hours.

## Decision

1. **One signal.** `PUT /api/operator/v1/orgs/{orgId}/machines/{machineId}/maintenance` takes `kind` (`moving`,
   `restarting`, `updating`, `converting`, `host_maintenance`; null: done), `eta` (when it should be back, or done)
   and `detail` (`copying`, `handover`, `unresponsive`). The same kind said again keeps its start. `PUT …/moving`
   stays for a Cloud from before it, as `kind: moving`; its `false` ends a move only, so a restart said during a move
   still shows after the move ends.
2. **Shown.** Until 30 minutes past `eta` (`MAINTENANCE_OVERRUN_MS`), or two hours after the latest word with none, and never
   more than a day after the latest word (`MAINTENANCE_LONGEST_MS`), so a far `eta` can't stick.
   Away, it is said instead of offline everywhere a computer's state shows (chips, the device list and page, the
   computer dialog, the outage banner, the chat's waiting card, the task manager, the agent's page, the browser card)
   with about when it is back, and an ⓘ (the phone: the line under it) says why, since when, expected back and that
   messages to its agents wait and go on. Online, only work beside its own shows (a move's copy, a conversion): it may
   be slower. A restart or an update ends at the computer's next hello.
3. **Agents.** A run waiting for it records it (`wait.maintenance`), its note and `computer_status` say the same plain
   cause, and the outage notice is not sent (ADR 0241 §4).
4. **Never sleep.** Standby is not a kind: a computer asleep still reads online and ready (ADR 0161). The Cloud tells a
   restart, never a start, since a start may be a wake.
5. **"Offline"** stays for a computer unreachable for reasons we don't control, with what to try, as before.

## Consequences

- Apps from before this read `moving` alone and say a move for every kind until they update.
- A kind this app doesn't know reads "Maintenance".
