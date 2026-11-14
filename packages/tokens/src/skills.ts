const MIB = 1024 * 1024;

/**
 * What a skill keeps, unzipped: its text and scripts (past it the skill is refused) and its images, PDFs and other
 * files that aren't text (past it the rest are only listed). The server's `SKILL_LIMITS` and the apps read these.
 */
export const SKILL_TEXT_BYTES = 16 * MIB;
export const SKILL_ASSET_BYTES = 40 * MIB;

/**
 * The longest base64 .zip a skill install takes: everything a skill keeps, stored uncompressed, with room for the
 * zip's own headers. The import's schema refuses past it, and its body limit sits just above.
 */
export const SKILL_ZIP_BASE64_CHARS = Math.ceil(((SKILL_TEXT_BYTES + SKILL_ASSET_BYTES) * 4) / 3) + 1_000_000;

/** The largest .zip whose base64 fits `SKILL_ZIP_BASE64_CHARS`: the apps refuse a bigger one the moment it's picked. */
export const SKILL_ZIP_BYTES = Math.floor(SKILL_ZIP_BASE64_CHARS / 4) * 3;
