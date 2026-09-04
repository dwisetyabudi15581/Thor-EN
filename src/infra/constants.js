/**
 * Constants — pusat untuk magic numbers, Discord limits, dan timing.
 *
 * Tujuan: hilangkan magic number yang bertebaran di kode (P3-6 fix).
 * Pakai: const C = require('./utils/constants');
 */

// === Discord embed limits (dari API docs) ===
const EMBED_LIMITS = {
    TITLE: 256,
    DESCRIPTION: 4096,
    FIELD_NAME: 256,
    FIELD_VALUE: 1024,
    FIELDS_COUNT: 25,
    FOOTER_TEXT: 2048,
    AUTHOR_NAME: 256,
    TOTAL_CHARS: 6000
};

// === Discord general limits ===
const DISCORD_LIMITS = {
    EMBED: EMBED_LIMITS,
    MESSAGE_CONTENT: 2000,
    BUTTONS_PER_ROW: 5,
    ACTION_ROWS_PER_MESSAGE: 5,
    SELECT_MENU_OPTIONS: 25,
    SELECT_MENU_MIN_OPTIONS: 1,
    SELECT_MENU_MAX_OPTIONS: 25,
    NICKNAME: 32,
    CHANNEL_NAME: 100,
    CHANNEL_TOPIC: 1024,
    ROLE_NAME: 100,
    GUILD_NAME: 100
};

// === Time constants (milliseconds) ===
const MS = {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
    WEEK: 7 * 24 * 60 * 60 * 1000
};

// === Scheduler / interval timing ===
const SCHEDULER = {
    MAIN_LOOP_INTERVAL_MS: 60 * 1000, // 1 menit — cek expired keys/roles/giveaways/announcements
    STATS_FLUSH_INTERVAL_MS: 30 * 1000, // 30 detik — flush stats cache ke disk
    AUTO_BACKUP_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 jam
    MAX_BACKUPS_KEPT: 7,
    AUDIT_LOG_WINDOW_MS: 10 * 1000, // v3.9.8: naikkan dari 5s ke 10s — lebih toleran latency Discord
    AUDIT_LOG_FETCH_LIMIT: 5, // v3.9.8: turunkan dari 10 ke 5 — pakai type filter, lebih efisien
    EMBED_SESSION_TTL_MS: 60 * 60 * 1000, // 1 jam — TTL session embed builder
    EMBED_SESSION_CLEANUP_MS: 10 * 60 * 1000, // 10 menit — interval cleanup
    // v3.9.8: naikkan dari 5 menit ke 15 menit — match Discord interaction token lifetime
    PROCESSED_INTERACTIONS_TTL_MS: 15 * 60 * 1000,
    INTERACTION_DEDUP_CLEANUP_MS: 60 * 1000 // v3.9.8: cleanup tiap 1 menit (per-entry prune, bukan bulk clear)
};

// === Warn thresholds ===
const WARN_THRESHOLDS = {
    MUTE_1H_COUNT: 3,
    MUTE_1D_COUNT: 5,
    KICK_COUNT: 7
};

const WARN_ACTION_DURATIONS_MS = {
    MUTE_1H: 60 * 60 * 1000, // 1 jam
    MUTE_1D: 24 * 60 * 60 * 1000 // 1 hari
};

// === Giveaway limits ===
const GIVEAWAY = {
    MIN_WINNERS: 1,
    MAX_WINNERS: 20,
    MIN_DURATION_MIN: 1
};

// === Poll limits ===
const POLL = {
    MIN_OPTIONS: 2,
    MAX_OPTIONS: 10,
    OPTION_LABEL_MAX: 80
};

// === Backup ===
const BACKUP = {
    AUTO_INTERVAL_MS: 24 * 60 * 60 * 1000,
    MAX_KEPT: 7
};

// === Colors (hex) ===
const COLORS = {
    SUCCESS: 0x57f287,
    DANGER: 0xed4245,
    WARNING: 0xe67e22,
    INFO: 0x5865f2,
    PRIMARY: 0x5865f2,
    NEUTRAL: 0x95a5a6,
    GOLD: 0xf1c40f,
    PURPLE: 0x9b59b6,
    BLUE: 0x3498db,
    GREEN: 0x2ecc71,
    RED: 0xe74c3c,
    DARK: 0x2c2f33
};

// v3.9.17: ButtonStyle string → ButtonStyle enum mapping (shared).
// Dipakai panels.js, config.js (2x), selfRolePanelBuilder.js, selfRoleManager.js.
// Import dari discord.js supaya gak duplikat.
const { ButtonStyle } = require('discord.js');
const BUTTON_STYLE_MAP = {
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger
};
const VALID_BUTTON_STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];

module.exports = {
    EMBED_LIMITS,
    DISCORD_LIMITS,
    MS,
    SCHEDULER,
    WARN_THRESHOLDS,
    WARN_ACTION_DURATIONS_MS,
    GIVEAWAY,
    POLL,
    BACKUP,
    COLORS,
    BUTTON_STYLE_MAP,
    VALID_BUTTON_STYLES
};
