/** "Seção" of a channel (ADR 0260): pick which of the person's own sections it sits in. */
export const sectorHref = (channelId: string) => `/channel-sector?channelId=${encodeURIComponent(channelId)}` as const;
