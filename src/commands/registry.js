/**
 * Command Definitions — all bot slash commands (P3-6 refactor).
 *
 * Used by index.js when the bot is ready to register them with Discord.
 * Purpose: separate command definitions from bot logic so index.js stays lean.
 */

const { PermissionFlagsBits } = require('discord.js');

function getCommands() {
    return [
        // === HELP ===
        {
            name: 'help',
            description: 'Help center: pick a category or search commands by keyword',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                // v3.9.39: search directly without opening the menu (alternative to the 🔍 modal).
                // v3.9.40 FIX: max_length 100 — without it Discord allows a STRING
                // option input up to 6000 chars → a long query is echoed into the
                // search results embed → description > 4096 → EmbedBuilder
                // THROWS (uncaught) → /help search silently errors. The search
                // modal is already capped at 100 (setMaxLength in
                // interactions/help.js); the slash path is now consistent.
                {
                    type: 3,
                    name: 'search',
                    description: 'Keyword of the command to search (e.g. key, escrow, panel)',
                    required: false,
                    max_length: 100
                }
            ]
        },

        // === PANEL SETUP ===
        {
            name: 'setup-verify',
            description: 'Set up the verification panel',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'setup-ticket',
            description: 'Set up the ticket panel & price list',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === SET ROLE ===
        {
            name: 'set-role',
            description: 'Set roles (verified / unverified / admin / midman)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Choose the role type',
                    required: true,
                    choices: [
                        { name: 'Verified', value: 'verified' },
                        { name: 'Unverified', value: 'unverified' },
                        { name: 'Admin', value: 'admin' },
                        // v3.9.32: midman/escrow role — handles 3-party escrow deals.
                        { name: 'Midman (Escrow)', value: 'midman' }
                    ]
                },
                { type: 8, name: 'role', description: 'The role to use', required: true }
            ]
        },

        // === SET CHANNEL ===
        // v3.9.30: /set-transcript-channel merged into here (tipe: transcript)
        // so admins only have to remember ONE channel command.
        {
            name: 'set-channel',
            description: 'Set channels (invoice / welcome / goodbye / audit-log / transcript)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Choose the channel type',
                    required: true,
                    choices: [
                        { name: 'Invoice', value: 'invoice' },
                        { name: 'Welcome', value: 'welcome' },
                        { name: 'Goodbye', value: 'goodbye' },
                        { name: 'Audit Log (logs admin actions)', value: 'audit-log' },
                        { name: 'Ticket Transcript (auto-saved on close)', value: 'transcript' }
                    ]
                },
                { type: 7, name: 'channel', description: 'The text channel to use', required: true }
            ]
        },

        // === SET MESSAGE ===
        {
            name: 'set-message',
            description: 'Edit the welcome / goodbye / verify / ticket embed text',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Choose which message to edit',
                    required: true,
                    choices: [
                        { name: 'Welcome Title', value: 'welcomeTitle' },
                        { name: 'Welcome Body', value: 'welcomeBody' },
                        { name: 'Goodbye Title', value: 'goodbyeTitle' },
                        { name: 'Goodbye Body', value: 'goodbyeBody' },
                        { name: 'Verify Title', value: 'verifyTitle' },
                        { name: 'Verify Body', value: 'verifyBody' },
                        { name: 'Ticket Title', value: 'ticketTitle' },
                        { name: 'Ticket Body', value: 'ticketBody' },
                        // v3.9.11 Phase 1: ticket price header configurable
                        { name: 'Ticket Price Header', value: 'ticketPriceHeader' }
                    ]
                },
                {
                    type: 3,
                    name: 'teks',
                    description: 'New text (supports \\n newline). Use {user} {username} {server} {count} {action}',
                    required: true
                }
            ]
        },

        // v3.9.11 Phase 1: verify button configurable
        {
            name: 'set-verify-button',
            description: 'Customize the verification button (label, emoji, style)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'label',
                    description: 'Button text (max 80 chars)',
                    required: true,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'emoji',
                    description: 'Button emoji (unicode or custom <:name:id>)',
                    required: false
                },
                {
                    type: 3,
                    name: 'style',
                    description: 'Button color',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                }
            ]
        },

        // v3.9.11 Phase 2: ticket category management
        {
            name: 'add-category',
            description: 'Add a new ticket category (for dynamic ticket panels)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'id',
                    description: 'Unique category ID (letters/numbers/_/-, max 30 chars)',
                    required: true,
                    min_length: 1,
                    max_length: 30
                },
                {
                    type: 3,
                    name: 'label',
                    description: 'Button label (max 80 chars)',
                    required: true,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'emoji',
                    description: 'Button emoji (unicode or custom <:name:id>)',
                    required: false
                },
                {
                    type: 3,
                    name: 'style',
                    description: 'Button color',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Does this category need the Set Key button? (default: true)',
                    required: false
                }
            ]
        },

        {
            name: 'list-categories',
            description: 'View all registered ticket categories',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        {
            name: 'remove-category',
            description: 'Remove a ticket category from the config',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'The category ID to delete', required: true }]
        },

        // v3.9.19: update an existing category (label/emoji/style/requires_key) without delete+add
        {
            name: 'update-category',
            description: 'Edit an existing ticket category (label/emoji/style/requires_key) without delete+re-add',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'id',
                    description: 'The category ID to update',
                    required: true,
                    min_length: 1,
                    max_length: 30
                },
                {
                    type: 3,
                    name: 'label',
                    description: 'New button label (max 80 chars)',
                    required: false,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'emoji',
                    description: 'New button emoji (unicode or custom <:name:id>)',
                    required: false
                },
                {
                    type: 3,
                    name: 'style',
                    description: 'New button color',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Does this category need the Set Key button?',
                    required: false
                }
            ]
        },

        // v3.9.11 Phase 3: multi-panel ticket (v3.9.14: full customization)
        {
            name: 'setup-ticket-panel',
            description: 'Set up a ticket panel with full customization (multi-panel support)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'title',
                    description: 'Embed title (overrides global). Leave empty = use config default',
                    required: false
                },
                {
                    type: 3,
                    name: 'categories',
                    description: 'Comma-separated category IDs to display (leave empty = all)',
                    required: false
                },
                {
                    type: 3,
                    name: 'body',
                    // v3.9.38 FIX: description was 103 chars — Discord max is 100
                    // (found by scripts/validate-registry.js). Shortened.
                    description: 'Custom body. Supports \\n & {server} {price_list} {categories_list}',
                    required: false
                },
                {
                    type: 3,
                    name: 'color',
                    description: 'Hex color (e.g. #ff5733 or #fff). Leave empty = default orange',
                    required: false
                },
                {
                    type: 3,
                    name: 'image',
                    description: 'Large image URL (https://...). Leave empty = no image',
                    required: false
                },
                {
                    type: 3,
                    name: 'thumbnail',
                    description: 'Small thumbnail URL (https://...). Leave empty = no thumbnail',
                    required: false
                },
                {
                    type: 3,
                    name: 'footer',
                    description: 'Footer text. Leave empty = use the bot name',
                    required: false
                },
                {
                    type: 7,
                    name: 'channel',
                    description: 'Target channel (default: current channel). Must be a text channel',
                    required: false
                },
                {
                    type: 5,
                    name: 'use_dropdown',
                    description: 'TRUE = use a dropdown select menu (default: FALSE = buttons)',
                    required: false
                }
            ]
        },

        // v3.9.14: panel management commands
        {
            name: 'list-panels',
            description: 'View all persistent ticket panels on this server',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'delete-panel',
            description: 'Delete a ticket panel by ID (auto-deletes message + metadata)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'Panel ID (see /list-panels)', required: true }]
        },
        {
            name: 'refresh-panel',
            description: 'Re-render a panel with the latest categories/products (no re-setup needed)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'Panel ID (see /list-panels)', required: true }]
        },
        {
            name: 'update-panel',
            description: 'Edit a panel field (title/body/color/image/thumbnail/footer) via modal',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'id', description: 'Panel ID (see /list-panels)', required: true },
                {
                    type: 3,
                    name: 'field',
                    description: 'Which field to edit',
                    required: true,
                    choices: [
                        { name: 'Title (heading)', value: 'title' },
                        { name: 'Body (content, supports templates)', value: 'body' },
                        { name: 'Color (hex color)', value: 'color' },
                        { name: 'Image (large image URL)', value: 'image' },
                        { name: 'Thumbnail (small image URL)', value: 'thumbnail' },
                        { name: 'Footer (footer text)', value: 'footer' }
                    ]
                }
            ]
        },

        // v3.9.12: /edit-message — modal editor for message config (multi-line, more flexible)
        {
            name: 'edit-message',
            description: 'Edit embed message text via modal (multi-line, more flexible than /set-message)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Choose which message to edit',
                    required: true,
                    choices: [
                        { name: 'Welcome Title', value: 'welcomeTitle' },
                        { name: 'Welcome Body', value: 'welcomeBody' },
                        { name: 'Goodbye Title', value: 'goodbyeTitle' },
                        { name: 'Goodbye Body', value: 'goodbyeBody' },
                        { name: 'Verify Title', value: 'verifyTitle' },
                        { name: 'Verify Body', value: 'verifyBody' },
                        { name: 'Ticket Title', value: 'ticketTitle' },
                        { name: 'Ticket Body', value: 'ticketBody' },
                        { name: 'Ticket Price Header', value: 'ticketPriceHeader' }
                    ]
                }
            ]
        },

        // === PRODUCT MANAGEMENT ===
        {
            name: 'add-product',
            description: 'Add a new product to the price list',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'label',
                    description: 'Product name (e.g. 7 Days, max 80 chars)',
                    required: true,
                    max_length: 80
                },
                { type: 3, name: 'value', description: 'Unique ID (e.g. 7d)', required: true },
                {
                    type: 3,
                    name: 'price',
                    description: 'Price (e.g. Rp. 50.000, max 100 chars)',
                    required: true,
                    max_length: 100
                },
                {
                    type: 3,
                    name: 'duration',
                    description: 'Optional. Duration label (e.g. 7 Days). Leave empty = use the label.',
                    required: false
                },
                // v3.9.11 Phase 2: category & requires_key
                {
                    type: 3,
                    name: 'category',
                    description: 'Product category (default: transaction). See /list-categories for the list.',
                    required: false
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Does this product need Set Key? (default: true for key categories)',
                    required: false
                }
            ]
        },
        {
            name: 'remove-product',
            description: 'Remove a product from the price list',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'value', description: 'The product value to delete (e.g. 7d)', required: true }
            ]
        },
        {
            name: 'list-products',
            description: 'View all current products',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // v3.9.19: update an existing product without delete+re-add
        // value can NOT be changed (used as the customId in modal_set_key).
        {
            name: 'update-product',
            description: 'Edit an existing product (label/price/duration/category/requires_key) without delete+re-add',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'value',
                    description: 'The product value to update (identifier — cannot be changed)',
                    required: true,
                    min_length: 1,
                    max_length: 50
                },
                {
                    type: 3,
                    name: 'label',
                    description: 'New product label (max 80 chars)',
                    required: false,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'price',
                    description: 'New price (e.g. "Rp 25.000")',
                    required: false,
                    min_length: 1,
                    max_length: 100
                },
                {
                    type: 3,
                    name: 'duration',
                    description: 'New duration (submit an empty string to remove the duration)',
                    required: false,
                    max_length: 100
                },
                {
                    type: 3,
                    name: 'category',
                    description: 'New category (see /list-categories)',
                    required: false,
                    min_length: 1,
                    max_length: 30
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Does this product need Set Key? (true=key, false=service/non-key)',
                    required: false
                }
            ]
        },

        // === CONFIG SHOW ===
        {
            name: 'config-show',
            description: 'View all current bot configuration',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === REMOVE ROLE (remove a role from the config) ===
        {
            name: 'remove-role',
            description: 'Remove a role from the config (verified / unverified / admin)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Choose the role type to remove',
                    required: true,
                    choices: [
                        { name: 'Verified', value: 'verified' },
                        { name: 'Unverified', value: 'unverified' },
                        { name: 'Admin', value: 'admin' },
                        // v3.9.32: remove the midman role from the config.
                        { name: 'Midman (Escrow)', value: 'midman' }
                    ]
                }
            ]
        },

        // === MIDMAN / ESCROW (v3.9.32) ===
        {
            name: 'set-midman-fee',
            description: 'Set the escrow fee (percent of the deal price or a flat amount)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'mode',
                    description: 'Fee calculation mode',
                    required: true,
                    choices: [
                        { name: 'Percent (%) of the deal price', value: 'percent' },
                        { name: 'Flat amount (Rp per deal)', value: 'flat' }
                    ]
                },
                {
                    type: 10,
                    name: 'value',
                    description: 'Fee value (percent: 0-90, flat: Rp amount). 0 = free',
                    required: true,
                    minValue: 0
                }
            ]
        },
        {
            name: 'midman-deals',
            description: 'View all active escrow deals on this server',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === REMOVE CHANNEL (remove a channel from the config) ===
        {
            name: 'remove-channel',
            description: 'Remove a channel from the config (invoice / welcome / goodbye / audit-log / transcript)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Choose the channel type to remove',
                    required: true,
                    choices: [
                        { name: 'Invoice', value: 'invoice' },
                        { name: 'Welcome', value: 'welcome' },
                        { name: 'Goodbye', value: 'goodbye' },
                        { name: 'Audit Log', value: 'audit-log' },
                        { name: 'Ticket Transcript', value: 'transcript' }
                    ]
                }
            ]
        },

        // === LIST MESSAGES (view all message texts) ===
        {
            name: 'list-messages',
            description: 'View all current embed message texts',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === RESET MESSAGE (restore messages to default) ===
        {
            name: 'reset-message',
            description: 'Reset embed message text back to default',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Choose which message to reset (or ALL for all of them)',
                    required: true,
                    choices: [
                        { name: 'Welcome Title', value: 'welcomeTitle' },
                        { name: 'Welcome Body', value: 'welcomeBody' },
                        { name: 'Goodbye Title', value: 'goodbyeTitle' },
                        { name: 'Goodbye Body', value: 'goodbyeBody' },
                        { name: 'Verify Title', value: 'verifyTitle' },
                        { name: 'Verify Body', value: 'verifyBody' },
                        { name: 'Ticket Title', value: 'ticketTitle' },
                        { name: 'Ticket Body', value: 'ticketBody' },
                        { name: '⚡ Reset ALL', value: 'ALL' }
                    ]
                }
            ]
        },

        // === RESET CONFIG (reset all settings to a blank state) ===
        {
            name: 'reset-config',
            description: '⚠️ Delete ALL settings (roles, channels, messages) - cannot be undone!',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === AUTO-ROLE PRODUCT (VIP role per product) ===
        {
            name: 'set-product-role',
            description: 'Set a role & auto-expire duration for a specific product',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'value', description: 'Product value (e.g. 30d)', required: true },
                { type: 8, name: 'role', description: 'The role granted when a purchase succeeds', required: true },
                {
                    type: 4,
                    name: 'days',
                    description: 'Days before the role is automatically removed (0 = permanent)',
                    required: true
                }
            ]
        },
        {
            name: 'remove-product-role',
            description: 'Remove the auto-role from a specific product',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'value', description: 'Product value (e.g. 30d)', required: true }]
        },
        {
            name: 'list-product-roles',
            description: 'View all product → role mappings + durations',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === KEY MANAGER (model key-driven) ===
        {
            name: 'set-key',
            description: 'Give a key to a user + grant role + extend schedule (MAX EXTEND)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'The user receiving the key', required: true },
                { type: 3, name: 'value', description: 'Product value (e.g. 30d)', required: true },
                {
                    type: 3,
                    name: 'key',
                    description: 'The key to send to the user (max 200 chars)',
                    required: true,
                    max_length: 200
                }
            ]
        },
        {
            name: 'list-keys',
            description: 'View all keys (active & expired) owned by the user',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 6, name: 'user', description: 'The user whose keys to view', required: true }]
        },
        {
            name: 'clear-schedule',
            description: 'Clear all scheduled roles for a user (+ optionally delete all keys & remove the VIP role)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'The user to clear', required: true },
                {
                    type: 5,
                    name: 'clear_keys',
                    description: 'True = delete ALL user keys + remove the VIP role (full reset). Default: false.',
                    required: false
                }
            ]
        },

        // === FLEXIBLE SELF-ROLE ===
        {
            name: 'setup-selfrole',
            description: 'Create a new self-role panel (members can take/drop roles themselves)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'title', description: 'Panel title (e.g. Pick a Notif Role)', required: true },
                { type: 3, name: 'description', description: 'Panel description (supports \\n newline)', required: true },
                {
                    type: 3,
                    name: 'type',
                    description: 'Panel UI type',
                    required: true,
                    choices: [
                        { name: 'Button (≤25 roles, click to toggle)', value: 'button' },
                        { name: 'Select Menu (dropdown, ≤25 roles)', value: 'select' }
                    ]
                },
                {
                    type: 5,
                    name: 'exclusive',
                    description: 'True = only 1 role allowed at a time (e.g. color roles). Default false.',
                    required: false
                }
            ]
        },
        {
            name: 'selfrole-add',
            description: 'Add a role to an existing self-role panel',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'panel_id',
                    description: 'Panel ID (see /selfrole-list or the panel footer)',
                    required: true
                },
                { type: 8, name: 'role', description: 'The role to add to the panel', required: true },
                { type: 3, name: 'label', description: 'Button / option label (max 80 chars)', required: true },
                { type: 3, name: 'emoji', description: 'Emoji (optional, e.g. 🔔)', required: false },
                {
                    type: 3,
                    name: 'description',
                    description: 'Description (optional, select menu, supports \\n newline)',
                    required: false
                },
                // v3.9.11 Phase 3: per-role button style
                {
                    type: 3,
                    name: 'style',
                    description: 'Button color (default: Secondary)',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                },
                // v3.9.11 Phase 3: conditional role (requiresRoleId)
                {
                    type: 8,
                    name: 'requires_role',
                    description: 'A role the user must have before taking this role (optional)',
                    required: false
                }
            ]
        },
        {
            name: 'selfrole-remove',
            description: 'Remove a role from a self-role panel',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'panel_id', description: 'Panel ID', required: true },
                { type: 8, name: 'role', description: 'The role to remove from the panel', required: true }
            ]
        },
        {
            name: 'selfrole-list',
            description: 'View all self-role panels in this guild',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'selfrole-delete',
            description: 'Delete a self-role panel (deletes the message + config)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'panel_id', description: 'The Panel ID to delete', required: true }]
        },

        // === ANNOUNCE & EMBED BUILDER ===
        {
            name: 'announce',
            description: 'Quick announce — send an embed to a channel (1 command, 1 embed)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Announcement target channel', required: true },
                { type: 3, name: 'title', description: 'Announcement title', required: true },
                { type: 3, name: 'description', description: 'Announcement content (supports newline \\n)', required: true },
                { type: 3, name: 'color', description: 'Hex color (e.g. #FF0000). Default: blurple', required: false },
                { type: 3, name: 'image', description: 'Large image URL (optional)', required: false },
                { type: 3, name: 'thumbnail', description: 'Small corner thumbnail URL (optional)', required: false },
                {
                    type: 3,
                    name: 'mention',
                    description: 'Mention: @everyone, @here, or <@&role_id>',
                    required: false
                }
            ]
        },
        {
            name: 'embed-builder',
            description: 'Interactive embed builder with live preview (for complex embeds)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'embed-list',
            description: 'View all your active embed builder sessions (+ link to the draft message)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'embed-cancel',
            description: 'Cancel an embed builder session by ID (if the draft got deleted/bugged)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'session_id', description: 'Session ID (see /embed-list)', required: true }]
        },

        // === BACKUP SYSTEM ===
        {
            name: 'backup-now',
            description: 'Create a manual backup now (config, keys, scheduledRoles, selfRoles, etc.)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'backup-list',
            description: 'View all saved backups (max 7 most recent)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'restore-backup',
            description: 'Restore a backup by name (auto-creates a safety backup before restoring)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'name',
                    description: 'Backup folder name (see /backup-list, format: YYYY-MM-DD_HH-mm-ss)',
                    required: true
                }
            ]
        },

        // === GIVEAWAY SYSTEM ===
        {
            name: 'giveaway',
            description: 'Manage community giveaways (create, list, end, reroll)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 1,
                    name: 'create',
                    description: 'Create a new giveaway',
                    required: false,
                    options: [
                        { type: 7, name: 'channel', description: 'Channel for the giveaway', required: true },
                        {
                            type: 3,
                            name: 'prize',
                            description: 'Prize (e.g. VIP 30 Days, max 200 chars)',
                            required: true,
                            max_length: 200
                        },
                        { type: 4, name: 'duration', description: 'Duration in minutes (min 1)', required: true },
                        { type: 4, name: 'winners', description: 'Number of winners (1-20, default 1)', required: false },
                        {
                            type: 8,
                            name: 'required_role',
                            description: 'A role participants must have (optional)',
                            required: false
                        }
                    ]
                },
                {
                    type: 1,
                    name: 'list',
                    description: 'View all giveaways in this guild',
                    required: false
                },
                {
                    type: 1,
                    name: 'end',
                    description: 'End a giveaway early + pick winners',
                    required: false,
                    options: [
                        { type: 3, name: 'id', description: 'Giveaway ID (see /giveaway list)', required: true }
                    ]
                },
                {
                    type: 1,
                    name: 'reroll',
                    description: 'Reroll the winner of an ended giveaway',
                    required: false,
                    options: [
                        { type: 3, name: 'id', description: 'Giveaway ID (see /giveaway list)', required: true }
                    ]
                }
            ]
        },

        // === SCHEDULED ANNOUNCEMENTS ===
        {
            name: 'announce-schedule',
            description: 'Schedule an announcement to a channel at a specific time (one-shot or recurring)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Target channel', required: true },
                { type: 3, name: 'title', description: 'Announcement title', required: true },
                {
                    type: 3,
                    name: 'description',
                    description: 'Announcement content (supports \\n for newline)',
                    required: true
                },
                {
                    type: 3,
                    name: 'at',
                    description: 'Send time. Format: "30m", "2h", "1d", or "2026-01-15 20:00"',
                    required: true
                },
                { type: 3, name: 'color', description: 'Hex color (e.g. #FF0000). Default: blurple', required: false },
                { type: 3, name: 'image', description: 'Large image URL (optional)', required: false },
                { type: 3, name: 'thumbnail', description: 'Small corner thumbnail URL (optional)', required: false },
                {
                    type: 3,
                    name: 'mention',
                    description: 'Mention: @everyone, @here, or <@&role_id>',
                    required: false
                },
                {
                    type: 3,
                    name: 'recurring',
                    description: 'Repeat (optional)',
                    required: false,
                    choices: [
                        { name: 'Daily (every day)', value: 'daily' },
                        { name: 'Weekly (every week)', value: 'weekly' },
                        { name: 'Monthly (every month)', value: 'monthly' }
                    ]
                }
            ]
        },
        {
            name: 'announce-list',
            description: 'View all pending scheduled announcements',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'announce-cancel',
            description: 'Cancel a scheduled announcement by ID',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'Announce ID (see /announce-list)', required: true }]
        },

        // === WARN SYSTEM ===
        // P2-3 FIX: defaultMemberPermissions aligned with the isAdmin check (ManageGuild).
        // Before: ModerateMembers → moderators could see the command but got denied when running it.
        {
            name: 'warn',
            description: 'Warn a member (auto-action: 3=mute 1h, 5=mute 1d, 7=kick)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'The member to warn', required: true },
                { type: 3, name: 'reason', description: 'Warning reason (supports \\n newline)', required: true }
            ]
        },
        {
            name: 'warn-list',
            description: 'View all warnings for a user',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 6, name: 'user', description: 'The user to check', required: true }]
        },
        {
            name: 'warn-remove',
            description: 'Delete 1 warning by ID',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'The user who owns the warning', required: true },
                { type: 3, name: 'warn_id', description: 'Warn ID (see /warn-list)', required: true }
            ]
        },
        {
            name: 'warn-clear',
            description: 'Delete ALL warnings for a user',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 6, name: 'user', description: 'The user whose warnings to clear', required: true }]
        },

        // === STATS & LEADERBOARD ===
        {
            name: 'stats',
            description: 'View aggregate server stats (admin only)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'leaderboard',
            description: 'View the top 10 members (public — regular members can use it)',
            options: [
                {
                    type: 3,
                    name: 'metric',
                    description: 'Leaderboard metric',
                    required: false,
                    choices: [
                        { name: '💬 Most Messages', value: 'messages' },
                        { name: '🛒 Top Buyer (transactions)', value: 'vipPurchases' },
                        { name: '💰 Top Spender (purchases)', value: 'totalSpent' },
                        { name: '🎉 Top Winner (giveaways)', value: 'giveawaysWon' }
                    ]
                }
            ]
        },
        {
            name: 'my-stats',
            description: 'View your personal stats (public — regular members can use it)'
        },

        // === POLL SYSTEM ===
        {
            name: 'poll',
            description: 'Manage community polls (create, list, close)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 1,
                    name: 'create',
                    description: 'Create a new poll (modal input for options)',
                    required: false,
                    options: [
                        {
                            type: 7,
                            name: 'channel',
                            description: 'Channel for the poll',
                            required: true,
                            // v3.9.26: restrict to text/announcement — without this, admins
                            // could pick voice/category → channel.send fails in the modal
                            // handler with a misleading error message.
                            channel_types: [0, 5]
                        },
                        {
                            type: 3,
                            name: 'question',
                            description: 'Poll question (max 250 chars)',
                            required: true,
                            max_length: 250
                        },
                        {
                            type: 5,
                            name: 'multiple',
                            description: 'True = members can pick multiple options. Default false (single)',
                            required: false
                        }
                    ]
                },
                {
                    type: 1,
                    name: 'list',
                    description: 'View all polls in this guild',
                    required: false
                },
                {
                    type: 1,
                    name: 'close',
                    description: 'Close a poll + show the final results',
                    required: false,
                    options: [{ type: 3, name: 'id', description: 'Poll ID (see /poll list)', required: true }]
                }
            ]
        },

        // === TEMP VOICE ===
        // v3.8.2: /setup-tempvoice takes no parameters — the bot auto-creates a category
        // containing a text channel (for the panel) + a voice channel (for the trigger).
        {
            name: 'setup-tempvoice',
            description: 'Set up temp voice — auto-creates a category + panel channel + trigger channel',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'tempvoice-remove',
            description: 'Remove the temp voice setup from the guild (category + all related channels are deleted)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === SEND MESSAGE (plain text to a channel) ===
        // v3.9.5: companion to /announce (which sends embeds). /send-message sends
        // regular plain text — great for casual announcements, bot chat, or
        // text that doesn't need embed styling.
        {
            name: 'send-message',
            description: 'Send a plain text message to a text channel (supports \\n & mentions)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Target channel (must be a text channel)', required: true },
                {
                    type: 3,
                    name: 'message',
                    description: 'Message content (supports \\n for newline). Max 2000 chars.',
                    required: true
                },
                {
                    type: 3,
                    name: 'mention',
                    description: 'Mention: @everyone, @here, or <@&role_id> / <@user_id>',
                    required: false
                }
            ]
        },

        // === v3.9.13: AUTO-RESPONDER ===
        {
            name: 'add-responder',
            description: 'Add an auto-responder: trigger keyword → auto reply',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'trigger',
                    description: 'Trigger keyword (e.g. !sosmed). Case-insensitive, max 50 chars.',
                    required: true,
                    min_length: 1,
                    max_length: 50
                },
                {
                    type: 3,
                    name: 'reply',
                    description: 'Reply text (supports \\n). Max 2000 chars.',
                    required: true,
                    min_length: 1,
                    max_length: 2000
                },
                {
                    type: 3,
                    name: 'reply_type',
                    description: 'Reply type (default: text)',
                    required: false,
                    choices: [
                        { name: 'Plain text', value: 'text' },
                        { name: 'Embed', value: 'embed' }
                    ]
                },
                {
                    type: 4,
                    name: 'cooldown',
                    description: 'Cooldown in seconds (anti-spam, default: 3, 0 = off)',
                    required: false,
                    min_value: 0
                }
            ]
        },
        {
            name: 'list-responder',
            description: 'View all registered auto-responders',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'remove-responder',
            description: 'Delete an auto-responder by trigger',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'trigger', description: 'The trigger to delete', required: true }]
        },

        // === v3.9.13: ANTI-SPAM & AUTO-MOD ===
        {
            name: 'set-automod',
            description: 'Configure auto-mod (spam, links, word filter, mention limit)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 4,
                    name: 'spam_threshold',
                    description: 'Number of messages in the window that counts as spam (default: 5)',
                    required: false,
                    min_value: 1
                },
                {
                    type: 3,
                    name: 'spam_action',
                    description: 'Action for spammers',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 minutes', value: 'mute_10m' },
                        { name: 'Mute 1 hour', value: 'mute_1h' },
                        { name: 'Kick', value: 'kick' }
                    ]
                },
                { type: 5, name: 'block_links', description: 'Block all links?', required: false },
                {
                    type: 3,
                    name: 'block_words',
                    description: 'Words to block (comma-separated, e.g. word1,word2)',
                    required: false
                },
                {
                    type: 3,
                    name: 'word_action',
                    description: 'Action for the word filter',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 minutes', value: 'mute_10m' }
                    ]
                },
                {
                    type: 4,
                    name: 'max_mentions',
                    description: 'Max mentions per message (default: 5)',
                    required: false,
                    min_value: 0
                },
                {
                    type: 3,
                    name: 'mention_action',
                    description: 'Action for mass-mentions',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 minutes', value: 'mute_10m' }
                    ]
                }
            ]
        },
        {
            name: 'automod-show',
            description: 'View the current auto-mod configuration',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'automod-toggle',
            description: 'Enable/disable auto-mod',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 5, name: 'enabled', description: 'Enable or disable?', required: true }]
        },
        {
            name: 'add-link-whitelist',
            description: 'Add a channel/role to the link whitelist (allowed to post links)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Channel allowed to post links', required: false },
                { type: 8, name: 'role', description: 'Role allowed to post links', required: false }
            ]
        },

        // === v3.9.23: AUTOMOD WORD FLEX ===
        {
            name: 'add-word',
            description: 'Add words to the auto-mod blocklist/exempt (append, not replace)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'words',
                    description: 'Words to add (comma-separated, e.g. word1,word2)',
                    required: true,
                    max_length: 500
                },
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Which list to add to?',
                    required: false,
                    choices: [
                        { name: 'Blocklist (blocked words)', value: 'blocklist' },
                        { name: 'Exempt (allowed words)', value: 'exempt' }
                    ]
                },
                {
                    type: 3,
                    name: 'action',
                    description: 'Action specific to these words (empty = use the global word_action)',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 minutes', value: 'mute_10m' },
                        { name: 'Mute 1 hour', value: 'mute_1h' },
                        { name: 'Kick', value: 'kick' }
                    ]
                }
            ]
        },
        {
            name: 'remove-word',
            description: 'Remove 1 word from the auto-mod blocklist/exempt',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'word', description: 'The word to remove', required: true, max_length: 100 },
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Which list to remove from?',
                    required: false,
                    choices: [
                        { name: 'Blocklist (blocked words)', value: 'blocklist' },
                        { name: 'Exempt (allowed words)', value: 'exempt' }
                    ]
                }
            ]
        },
        {
            name: 'list-words',
            description: 'View the blocklist + exempt word lists + per-word actions',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'remove-link-whitelist',
            description: 'Remove a channel/role from the link whitelist',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'The channel to remove from the whitelist', required: false },
                { type: 8, name: 'role', description: 'The role to remove from the whitelist', required: false }
            ]
        },

        // === v3.9.13: AFK SYSTEM ===
        {
            name: 'afk',
            description: 'Set AFK status (bot auto-replies when you get mentioned)',
            options: [
                // v3.9.17: added max_length so the reason can't overflow the reply.
                // Before, Discord's default 6000 char max could make the AFK reply
                // (which combines multiple mentions) exceed the 2000 char limit → send failure.
                {
                    type: 3,
                    name: 'reason',
                    description: 'AFK reason (supports \\n, e.g. "Eating, back in 30 minutes")',
                    required: false,
                    max_length: 200
                }
            ]
        },
        {
            name: 'afk-clear',
            description: 'Clear your AFK status'
        },
        {
            name: 'afk-list',
            description: 'View all members who are currently AFK',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === v3.9.13: LEVELING SYSTEM ===
        {
            name: 'setup-leveling',
            description: 'Enable/disable leveling system + config XP',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 5, name: 'enabled', description: 'Enable or disable leveling?', required: true },
                {
                    type: 4,
                    name: 'xp_per_message',
                    description: 'XP per message (default: 15)',
                    required: false,
                    min_value: 1,
                    max_value: 1000
                },
                {
                    type: 4,
                    name: 'cooldown',
                    description: 'Cooldown in seconds (default: 60)',
                    required: false,
                    min_value: 0,
                    max_value: 3600
                },
                {
                    type: 5,
                    name: 'announce_levelup',
                    description: 'Announce when a user levels up? (default: true)',
                    required: false
                }
            ]
        },
        {
            name: 'add-level-role',
            description: 'Add a reward role for a specific level (auto-assigned on level-up)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 4, name: 'level', description: 'The level to reach (e.g. 10)', required: true },
                { type: 8, name: 'role', description: 'The role to assign', required: true }
            ]
        },
        {
            name: 'list-level-roles',
            description: 'View all level reward roles',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'remove-level-role',
            description: 'Remove the reward role for a specific level',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 4, name: 'level', description: 'The level to remove the role from', required: true }]
        },
        {
            name: 'rank',
            description: 'View your level & XP (or another user)',
            options: [{ type: 6, name: 'user', description: 'The user to check (default: you)', required: false }]
        },
        {
            name: 'leaderboard-level',
            description: 'Top 10 members with the highest level (public)'
        }
    ];
}

module.exports = { getCommands };
