const { EmbedBuilder } = require('discord.js');

/**
 * Embed builder reusable biar semua embed kelihatan konsisten & profesional.
 * Otomatis dapat: footer, timestamp, warna dari config.
 */
class Embeds {
    constructor(client) {
        this.client = client;
    }

    _base(color, title, description) {
        const embed = new EmbedBuilder().setColor(color).setTimestamp();
        if (title) embed.setTitle(title);
        if (description) embed.setDescription(description);
        if (this.client?.user) {
            embed.setFooter({
                text: this.client.user.username,
                iconURL: this.client.user.displayAvatarURL({ dynamic: true })
            });
        }
        return embed;
    }

    success(title, description) {
        return this._base(0x2ecc71, title, description);
    }

    danger(title, description) {
        return this._base(0xe74c3c, title, description);
    }

    primary(title, description) {
        return this._base(0x3498db, title, description);
    }

    warning(title, description) {
        return this._base(0xe67e22, title, description);
    }

    info(title, description) {
        return this._base(0x5865f2, title, description);
    }
}

module.exports = { Embeds };
