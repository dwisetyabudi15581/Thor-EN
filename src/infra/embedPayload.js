/**
 * Embed Payload — shared validation + builder for WEB-built embeds (v3.20.0).
 *
 * Why this exists: since v3.20.0 embeds can be built from the web dashboard
 * (full Embed Builder + Custom Command responses) AND from Discord
 * (/embed-builder, /send-message). Validation rules must live in ONE place
 * for all of those paths — same pattern as normalizeDisabledList
 * (commands.js) — so web and Discord can never disagree about limits.
 *
 * Data shape (plain object — discord.js-free, JSON-serializable):
 *   {
 *     title:        string <=256
 *     description:  string <=4096
 *     color:        integer 0..0xFFFFFF
 *     authorName:   string <=256
 *     authorIconURL: URL string <=500 (http/https)
 *     thumbnail:    URL string <=500
 *     image:        URL string <=500
 *     footerText:   string <=2048
 *     footerIconURL: URL string <=500
 *     timestamp:    boolean
 *     fields:       [{ name <=256, value <=1024, inline boolean }] max 25
 *   }
 *
 * Numeric limits are the real Discord API limits (title 256, description
 * 4096, etc.). Combined embed text total is capped at 6000 chars (Discord).
 */

// Official Discord API limits.
const CAPS = {
    title: 256,
    description: 4096,
    authorName: 256,
    footerText: 2048,
    fieldName: 256,
    fieldValue: 1024,
    maxFields: 25,
    url: 500,
    total: 6000
};

/** Safe trim: null/undefined -> empty string. */
function s(v) {
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * Valid URL? http/https only + sane length. Discord rejects anything else
 * at send time — better to reject here with a clear message.
 */
function validUrl(v) {
    return /^https?:\/\/\S+$/i.test(v) && v.length <= CAPS.url;
}

/** Total embed characters (Discord's 6000 rule). */
function totalEmbedLength(def) {
    let total = 0;
    total += s(def.title).length;
    total += s(def.description).length;
    total += s(def.authorName).length;
    total += s(def.footerText).length;
    for (const f of def.fields || []) {
        total += s(f.name).length + s(f.value).length;
    }
    return total;
}

/**
 * Is this embed def completely empty (not a single element filled in)?
 * Used for the "at least content OR embed must be set" check.
 */
function isEmbedEmpty(def) {
    if (!def || typeof def !== 'object') return true;
    return (
        !s(def.title) &&
        !s(def.description) &&
        !s(def.authorName) &&
        !s(def.footerText) &&
        !s(def.thumbnail) &&
        !s(def.image) &&
        !(Array.isArray(def.fields) && def.fields.some((f) => s(f.name) || s(f.value)))
    );
}

/**
 * Validate + normalize an embed from raw input (web dashboard / API).
 * All fields optional; empty ones are dropped so storage stays clean.
 *
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 *   value = normalized def (may be an empty object {} for empty input).
 */
function normalizeEmbedDef(raw) {
    const value = {
        title: '',
        description: '',
        color: 0x5865f2,
        authorName: '',
        authorIconURL: '',
        thumbnail: '',
        image: '',
        footerText: '',
        footerIconURL: '',
        timestamp: false,
        fields: []
    };
    if (!raw || typeof raw !== 'object') return { ok: true, value };

    const title = s(raw.title);
    if (title.length > CAPS.title) return { ok: false, error: `Title is limited to ${CAPS.title} characters` };
    value.title = title;

    const description = s(raw.description);
    if (description.length > CAPS.description)
        return { ok: false, error: `Description is limited to ${CAPS.description} characters` };
    value.description = description;

    // Color: integer 0..0xFFFFFF. Hex strings ("#5865f2") accepted too.
    let color = 0x5865f2;
    if (raw.color !== undefined && raw.color !== null) {
        if (typeof raw.color === 'number' && Number.isInteger(raw.color) && raw.color >= 0 && raw.color <= 0xffffff) {
            color = raw.color;
        } else if (typeof raw.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(raw.color.trim())) {
            color = parseInt(raw.color.trim().replace('#', ''), 16);
        } else {
            return { ok: false, error: 'Invalid color (must be integer 0-16777215 or hex #RRGGBB)' };
        }
    }
    value.color = color;

    const authorName = s(raw.authorName);
    if (authorName.length > CAPS.authorName) return { ok: false, error: `Author name is limited to ${CAPS.authorName} characters` };
    value.authorName = authorName;

    const footerText = s(raw.footerText);
    if (footerText.length > CAPS.footerText) return { ok: false, error: `Footer is limited to ${CAPS.footerText} characters` };
    value.footerText = footerText;

    for (const [key, label] of [
        ['authorIconURL', 'Author icon'],
        ['thumbnail', 'Thumbnail'],
        ['image', 'Image'],
        ['footerIconURL', 'Footer icon']
    ]) {
        const url = s(raw[key]);
        if (!url) continue;
        if (!validUrl(url)) return { ok: false, error: `${label} must be a valid http(s) URL (max ${CAPS.url} chars)` };
        value[key] = url;
    }

    value.timestamp = raw.timestamp === true;

    if (raw.fields !== undefined && raw.fields !== null) {
        if (!Array.isArray(raw.fields)) return { ok: false, error: 'Fields must be an array' };
        if (raw.fields.length > CAPS.maxFields) return { ok: false, error: `Maximum ${CAPS.maxFields} fields per embed` };
        for (const f of raw.fields) {
            if (!f || typeof f !== 'object') return { ok: false, error: 'Invalid field' };
            const name = s(f.name);
            const fv = s(f.value);
            if (!name && !fv) continue; // empty field -> skip
            if (name.length > CAPS.fieldName) return { ok: false, error: `Field name is limited to ${CAPS.fieldName} characters` };
            if (fv.length > CAPS.fieldValue) return { ok: false, error: `Field value is limited to ${CAPS.fieldValue} characters` };
            value.fields.push({ name, value: fv, inline: f.inline === true });
        }
    }

    const total = totalEmbedLength(value);
    if (total > CAPS.total) {
        return { ok: false, error: `Total embed text is limited to ${CAPS.total} characters (currently ${total})` };
    }

    return { ok: true, value };
}

/**
 * Build a discord.js EmbedBuilder from an ALREADY-normalized def.
 * The caller is responsible for calling normalizeEmbedDef first (except
 * for internal defs that are already clean — e.g. from
 * customCommandManager).
 *
 * @param {object} def        normalized embed def
 * @param {Function} EmbedBuilderClass discord.js EmbedBuilder class (injected
 *                            so this file stays easy to mock in unit tests)
 */
function buildEmbedFromDef(def, EmbedBuilderClass) {
    const embed = new EmbedBuilderClass().setColor(def.color ?? 0x5865f2);
    if (def.title) embed.setTitle(def.title);
    if (def.description) embed.setDescription(def.description);
    if (def.authorName) {
        const author = { name: def.authorName };
        if (def.authorIconURL) author.iconURL = def.authorIconURL;
        embed.setAuthor(author);
    }
    if (def.thumbnail) embed.setThumbnail(def.thumbnail);
    if (def.image) embed.setImage(def.image);
    if (def.footerText) {
        const footer = { text: def.footerText };
        if (def.footerIconURL) footer.iconURL = def.footerIconURL;
        embed.setFooter(footer);
    }
    if (def.timestamp === true) embed.setTimestamp();
    for (const f of def.fields || []) {
        embed.addFields({ name: f.name, value: f.value, inline: f.inline === true });
    }
    return embed;
}

module.exports = {
    CAPS,
    normalizeEmbedDef,
    buildEmbedFromDef,
    totalEmbedLength,
    isEmbedEmpty
};
