import { type PubSub, SIMULATOR_POWER_PROTOCOL } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { type AuditEntry, recordAudit } from "./audit";
import { machineRule, mayManageDevice, mayUseDevice, phoneRule, publishDevicesChanged } from "./devices";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { getMachine } from "./machines";
import { requirePermission } from "./organizations";

const { machinePhones } = schema;

/**
 * Ligar and Desligar for a simulator or an emulator (`phone.power`): from Settings › Devices and from the agents'
 * `simulator_start` / `simulator_stop`. Its computer boots or shuts it down; the devices list then shows it starting,
 * ready or offline.
 */

type Deps = { db: Database; pubsub?: PubSub; hub: Pick<MachineCaller, "call"> };

/** Starts or shutdowns per person, and per agent. */
export const PHONE_POWER_LIMIT = { limit: 20, windowMs: 10 * 60_000 };

/** The phone row and host `sendPhonePower` needs. */
export interface PowerTarget {
  phone: { id: string; name: string; model: string; platform: "android" | "ios"; kind: string; serial: string };
  host: { id: string; name: string; protocol: number };
}

/** A real phone isn't started from here: only what its computer runs (`device.not_simulator`). */
export function assertSimulator(phone: PowerTarget["phone"]) {
  if (phone.kind === "device")
    throw new ValidationError(
      `${phone.name} is a real phone: only a simulator or an emulator starts and shuts down from here.`,
      "device.not_simulator",
    );
}

/**
 * Asks the host to start (`on`) or shut down the simulator or emulator, and logs who did. Shared by the apps' Ligar and
 * Desligar and the agents' tools. The host's refusals come back as codes the apps word, their English for agents.
 */
export async function sendPhonePower(
  deps: Deps,
  orgId: string,
  { phone, host }: PowerTarget,
  on: boolean,
  by: Pick<AuditEntry, "actor" | "runId" | "channelId" | "onBehalfOfUserId">,
) {
  assertSimulator(phone);
  const params = { name: phone.name, computer: host.name, platform: phone.platform };
  if (host.protocol < SIMULATOR_POWER_PROTOCOL)
    throw new ConflictError(
      `The agentes app on ${host.name} is too old to start or shut down ${phone.name}. Update it there.`,
      "machine.outdated",
      params,
    );
  try {
    await deps.hub.call(host.id, {
      op: "phone.power",
      platform: phone.platform,
      serial: phone.serial,
      model: phone.model,
      on,
    });
  } catch (error) {
    if (!(error instanceof MachineRequestError)) throw error;
    const what = phone.platform === "ios" ? "simulator" : "emulator";
    if (error.code === "tool_missing")
      throw new ConflictError(
        phone.platform === "ios"
          ? `${host.name} needs Xcode to run simulators. Install Xcode from the App Store there.`
          : `${host.name} doesn't have the Android Emulator. Install it there in Android Studio › SDK Manager › SDK Tools.`,
        "device.power_tool_missing",
        params,
      );
    if (error.code === "phone_missing")
      throw new NotFoundError(
        `${phone.name} isn't on ${host.name} anymore (the ${what} was deleted there). Forget it here, or make it again in ${phone.platform === "ios" ? "Xcode" : "Android Studio"}.`,
        "device.power_gone",
        params,
      );
    if (error.code === "phone_busy")
      throw new ConflictError(
        `${phone.name} is in use right now. Stop what uses it first, or try again when it's free.`,
        "device.power_busy",
        params,
      );
    throw new ConflictError(
      `${phone.name} didn't ${on ? "start" : "shut down"}: ${error.message}`,
      on ? "device.power_start_failed" : "device.power_stop_failed",
      { ...params, why: error.message.slice(0, 300) },
    );
  }
  await recordAudit(deps.db, {
    orgId,
    ...by,
    action: on ? "device.phone_started" : "device.phone_shut_down",
    target: { type: "phone", id: phone.id },
    details: { name: phone.name },
  });
  await publishDevicesChanged(deps.pubsub, orgId);
}

/**
 * `POST …/devices/phones/{phoneId}/power` (who may use it or manage it): its computer starts or shuts down the
 * simulator or emulator.
 */
export async function powerPhone(deps: Deps, actorId: string, orgId: string, phoneId: string, on: boolean) {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const [phone] = await deps.db
    .select()
    .from(machinePhones)
    .where(and(eq(machinePhones.orgId, orgId), eq(machinePhones.id, phoneId), isNull(machinePhones.deletedAt)));
  const host = phone?.machineId ? await getMachine(deps.db, orgId, phone.machineId) : null;
  if (!phone || !host || host.kind === "managed") throw new NotFoundError("Device not found", "device.not_found");
  assertSimulator(phone);
  const allowed =
    mayManageDevice(membership, actorId, phone.ownerUserId) ||
    (await mayUseDevice(deps.db, orgId, actorId, phoneRule(phone, machineRule(host)), { membership }));
  if (!allowed)
    throw new ForbiddenError(`Only who may use ${phone.name} can start or shut it down`, "device.forbidden");
  await sendPhonePower(deps, orgId, { phone, host }, on, { actor: { type: "person", id: actorId } });
}
