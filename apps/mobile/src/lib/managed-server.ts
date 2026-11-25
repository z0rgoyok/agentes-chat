import managedService from "../../managed-service.json";

/** Tich Rooms is distributed for this service only. Account suffixes stay local. */
export const MANAGED_SERVER = managedService.server;

export function isManagedPlace(place: string): boolean {
  if (place === MANAGED_SERVER) return true;
  const prefix = `${MANAGED_SERVER}#`;
  return place.startsWith(prefix) && /^[A-Za-z0-9-]{1,64}$/.test(place.slice(prefix.length));
}

export function requireManagedPlace(place: string): string {
  if (!isManagedPlace(place)) throw new Error("This app only connects to Tich Rooms");
  return place;
}
