# 🤖 Thor — All-in-One Discord Community Bot

Bot Discord serbaguna untuk komunitas apa pun — server jualan, gaming, content creator, hingga komunitas umum. Semua konfigurasi dapat diatur langsung dari Discord melalui slash command, tanpa mengedit file.

> **v3.9.37** · 82 slash command · 324 unit test · discord.js v14 · Node.js 18+ · single-guild
>
> 📖 **[Panduan Admin Lengkap](./docs/ADMIN_GUIDE.md)** — setup, operasional harian, troubleshooting
> 📜 **[Changelog](./CHANGELOG.md)** — riwayat semua versi

---

## ✨ Fitur Utama

### 🎫 Tiket & Transaksi

- **Panel tiket multi-kategori & multi-panel** — kategori dan produk dapat ditambah, diubah, dan dihapus sepenuhnya dari Discord (CRUD tanpa edit kode).
- **Kategori custom otomatis aman** — id kategori apa pun (`akun_ml`, `lisensi_key`, `jasa`, `topup`, ...) otomatis terklasifikasi sebagai TRANSAKSI; hanya `help`/`report` yang menjadi BANTUAN.
- **Dua alur transaksi**: produk ber-key (**🔑 Set Key**) dan produk non-key seperti jual akun/jasa (**📦 Kirim Pesanan** — detail pesanan dikirim via DM ke pembeli).
- **Invoice otomatis** ke channel testimoni (sekali per tiket) + **transcript otomatis** tersimpan sebelum channel tiket dihapus.
- **🤝 Midman / Rekber (deal escrow 3-pihak)** — pembeli, penjual, dan midman dalam satu channel deal dengan **Deal Board** (embed sumber kebenaran) + **state machine**: dana masuk (konfirmasi midman) → barang diterima (konfirmasi pembeli) → cairkan (midman). Dispute → freeze, hanya admin yang resolve. **Deal bisa dibuka siapa saja** (pembeli/penjual/pihak yang menolong) lewat **formulir 3 langkah** (item + harga → pilih pembeli → pilih penjual, semua dropdown searchable), **terms terkunci hanya setelah pembeli & penjual dua-duanya setuju**. Tombol **👥 Tambah Member / ➖ Keluarkan Member** untuk mengelola member tambahan di dalam channel deal (hanya bisa lihat & chat; tidak bisa menggerakkan deal). **Fee ditambah di atas harga** (penjual selalu terima harga penuh; pembeli bayar harga + fee), history klik tercatat, invoice/transcript/audit terintegrasi.

### 🔑 Produk & VIP (Key-Driven)

- Produk dengan kategori, harga, dan flag `requires_key` (diwariskan dari kategori ke produk).
- Role VIP berbasis key dengan model **MAX EXTEND** — role mengikuti key dengan sisa waktu terbanyak; auto-expire terjadwal.
- Set Key sukses → simpan key, beri role, DM member, invoice, catat stats — semua otomatis.
- Key selalu **dimasking** di audit log (tidak pernah bocor nilai).

### 🛡️ Anti-Spam & Auto-Mod

- Spam detection (N pesan dalam window → action) + mass-mention block.
- Link blocking dengan whitelist channel/role.
- **Word filter fleksibel**: tambah kata satu per satu (`/add-word`), action per kata, exempt word, matching **whole-word** ("asu" tidak match "asus").

### 💬 Auto-Responder & AFK

- Trigger keyword (`!sosmed`, `!jadwal`, ...) → auto-reply plain text atau embed, dengan cooldown per-user.
- AFK system: auto-reply saat di-mention, auto-clear saat kembali, `/afk-list` untuk admin.

### 📊 Leveling & Stats

- XP per pesan (cooldown anti-spam) + role reward per level + `/rank` + `/leaderboard-level`.
- Stats & leaderboard server: messages, purchases, totalSpent, giveawaysWon.

### 🎭 Lainnya

- **Verifikasi** — tombol customizable (label, emoji, style), auto-swap role Unverified → Verified.
- **Self-Role** — panel button/select, mode exclusive/multi, prerequisite role bertingkat.
- **Temp Voice** — channel voice pribadi otomatis + panel kontrol (rename, kick, limit, lock, transfer).
- **Giveaway** — required role, multiple winners, reroll, per-user lock anti double-join.
- **Poll** — live bar chart, single/multi choice, toggle vote.
- **Announce** — quick embed, scheduled (one-shot & recurring daily/weekly/monthly), embed builder interaktif dengan live preview.
- **Warn system** — auto-action: 3 warning → mute 1 jam, 5 → mute 1 hari, 7 → kick.
- **Backup** — otomatis tiap 24 jam + saat start, maks 7 backup, restore dengan 2-step confirmation + safety backup.
- **Audit log** — semua admin action tercatat ke channel khusus (50 action types, retry otomatis).

---

## 📁 Struktur Proyek

```
Thor/
├── index.js                      # Entry point
├── .github/workflows/ci.yml      # GitHub Actions: lint + test (Node 18/20/22)
├── src/
│   ├── bot/events/               # Discord event handlers
│   ├── commands/                 # Slash command handlers (per-domain)
│   ├── interactions/             # Button/select/modal handlers (per-domain)
│   ├── data/                     # JSON persistence layer (16 managers)
│   ├── services/                 # Business logic (scheduler, dll)
│   ├── ui/                       # Embed/panel builders
│   └── infra/                    # safeWrite, safeReply, userLock, permissions, auditLog
├── data/                         # Runtime JSON files (gitignored)
├── docs/                         # ADMIN_GUIDE + index dokumen
├── tests/unit/                   # 324 unit test (node:test)
├── CHANGELOG.md                  # Riwayat versi
├── .env.example
├── eslint.config.js
└── .prettierrc.json
```

---

## 🚀 Setup

### Prasyarat

- Node.js v18+ (disarankan v20+)
- Discord bot token ([cara mendapatkan](https://discord.com/developers/applications))
- **3 Privileged Intents** diaktifkan di Discord Developer Portal (tab **Bot** → _Privileged Gateway Intents_):
    - ✅ **Server Members Intent** — untuk welcome/goodbye, auto-role
    - ✅ **Message Content Intent** — **WAJIB** untuk auto-responder, anti-spam kata/link, dan AFK mention reply. Tanpa intent ini, `message.content` selalu kosong dan fitur tersebut tidak berfungsi.
    - ✅ Presence Intent — opsional
- Bot diundang ke server target dengan permission: `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`, `View Audit Log`, `Moderate Members`, `Move Members`
- Role bot berada **di atas** semua role yang dikelola

### Instalasi

```bash
# 1. Clone repo
git clone https://github.com/dwisetyabudi15581/Thor.git
cd Thor

# 2. Install dependencies
npm install

# 3. Siapkan environment
cp .env.example .env
# Isi .env:
#   DISCORD_TOKEN=token_bot_anda
#   GUILD_ID=id_server_discord_anda

# 4. Jalankan bot
npm start
```

Registrasi slash command berlangsung instan ke guild yang ditentukan `GUILD_ID`. Untuk development dengan auto-restart: `npm run dev`.

### Konfigurasi Awal (setelah bot online)

1. `/set-role admin @role` — role admin bot
2. `/set-role verified @role` — role member terverifikasi
3. `/set-role unverified @role` — role default member baru
4. `/set-channel welcome #channel` — channel welcome
5. `/set-channel goodbye #channel` — channel goodbye
6. `/set-channel invoice #channel` — channel invoice/testimoni
7. `/set-channel audit-log #channel` — channel audit log
8. `/set-channel transcript #channel` — channel arsip transcript tiket (opsional)
9. `/setup-verify` — pasang panel verifikasi
10. `/setup-ticket` — pasang panel tiket
11. `/config-show` — verifikasi semua setting

Panduan lengkap termasuk contoh produk, kategori custom, dan operasional harian: **[docs/ADMIN_GUIDE.md](./docs/ADMIN_GUIDE.md)**.

---

## 🧪 Development

| Script           | Deskripsi                              |
| ---------------- | -------------------------------------- |
| `npm start`      | Jalankan bot                           |
| `npm run dev`    | Jalankan dengan nodemon (auto-restart) |
| `npm test`       | Jalankan semua unit test (324 test)    |
| `npm run lint`   | ESLint check                           |
| `npm run format` | Prettier format semua file             |

Test memakai `node:test` bawaan Node.js v18+ — tidak perlu dependensi tambahan. Semua test berjalan dalam sandbox (snapshot/restore) sehingga aman dijalankan di server live. CI (GitHub Actions) menjalankan lint + test pada setiap push untuk Node 18/20/22.

---

## 🛡️ Keamanan

- **Token Discord** hanya di `.env` (di-gitignore) — jangan pernah di-commit.
- **Atomic write** — semua file JSON ditulis via `safeWriteJSON` (tmp+rename), anti corrupt saat crash/power loss.
- **Karantina file korup** — file data gagal parse di-rename `.corrupt-<ts>`, tidak pernah tertimpa diam-diam.
- **TOCTOU guard** — `userLock` mencegah double-process saat user double-click.
- **Audit log** — key selalu dimasking; semua admin action tercatat.
- **Guild-scoped data** — key, warn, stats, dan config di-scope per guild (single-guild bot, dengan guard `GUILD_ID` di semua event).

---

## 🆘 Troubleshooting

### Bot tidak online

Cek `DISCORD_TOKEN` di `.env` dan pastikan bot sudah di-invite ke server dengan ID `GUILD_ID`.

### Slash command tidak muncul

Pastikan `GUILD_ID` benar (server ID, bukan user ID) dan bot adalah member guild itu. Restart bot — registrasi ulang instan.

### Permission error

Role bot harus **di atas** role yang dikelola, dan bot memerl permission yang tercantum di bagian Prasyarat.

### Auto-responder / anti-spam / AFK tidak berfungsi

Penyebab paling sering: **Message Content Intent** belum diaktifkan.

1. Buka https://discord.com/developers/applications → pilih bot
2. Tab **Bot** → _Privileged Gateway Intents_
3. Aktifkan **MESSAGE CONTENT INTENT** (dan SERVER MEMBERS INTENT jika belum)
4. Save Changes → restart bot

Jika console bot menampilkan warning `⚠️ [HINT] Pesan dari ... isinya kosong`, intent memang belum aktif.

Troubleshooting lengkap (tiket, role, stats, backup, dll): **[docs/ADMIN_GUIDE.md → Section 9](./docs/ADMIN_GUIDE.md)**.

---

## 📝 Lisensi

MIT — bebas dipakai, dimodifikasi, dan didistribusikan. Lihat [LICENSE](./LICENSE).
