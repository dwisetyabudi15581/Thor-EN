# 📖 Admin Guide — Thor Bot v3.9.37

Panduan lengkap untuk admin server Discord yang menjalankan bot ini — cocok untuk admin baru yang pertama kali setup, maupun admin yang sudah berjalan sebagai referensi harian.

> 📜 Riwayat lengkap semua versi: [CHANGELOG.md](../CHANGELOG.md) · Ringkasan 3 versi terakhir ada di [Section 11](#11-riwayat-versi).

---

## 🎯 Daftar Isi

1. [Quick Start (5 menit)](#1-quick-start-5-menit)
2. [Setup Awal Server](#2-setup-awal-server)
3. [Manajemen Produk & VIP](#3-manajemen-produk--vip)
4. [Operasional Harian (Tiket, Announce, Embed)](#4-operasional-harian-tiket-announce-embed)
5. [Moderation (Warn System)](#5-moderation-warn-system)
6. [Engagement (Giveaway & Poll)](#6-engagement-giveaway--poll)
7. [Fitur Komunitas Lanjutan](#7-fitur-komunitas-lanjutan)
8. [Backup & Restore](#8-backup--restore)
9. [Troubleshooting](#9-troubleshooting)
10. [Best Practices](#10-best-practices)
11. [Riwayat Versi](#11-riwayat-versi)

---

## 1. Quick Start (5 menit)

### Prasyarat

- Node.js 18+ (`engines` di package.json mensyaratkan >= 18)
- Bot sudah di-invite ke server dengan permission: **Manage Roles, Manage Channels, Send Messages, Embed Links, View Audit Log, Moderate Members, Move Members**
- **3 Privileged Intents** sudah diaktifkan di Discord Developer Portal (https://discord.com/developers/applications → pilih bot → tab **Bot** → scroll ke _Privileged Gateway Intents_):
    - ✅ **Server Members Intent** — untuk welcome/goodbye, auto-role, member sync
    - ✅ **Message Content Intent** — **WAJIB** untuk auto-responder, anti-spam kata/link, dan AFK mention reply. Tanpa ini, `message.content` selalu kosong → fitur-fitur tersebut tidak berfungsi.
    - ✅ Presence Intent — opsional (belum dipakai)
- **Role bot berada di ATAS** semua role yang akan dikelola (Verified, Unverified, VIP, dst.)

### Install

```bash
npm install
cp .env.example .env
# Edit .env, isi DISCORD_TOKEN dan GUILD_ID
npm start
```

### Verifikasi

- Console menampilkan: `✅ Bot online sebagai NamaBot`
- Console menampilkan: `✅ Slash Commands terdaftar ke guild: Nama Server (instan!)`
- Di Discord, ketik `/` — semua **82 slash command** harus muncul
- Jika command tidak muncul, pastikan `GUILD_ID` di `.env` benar

---

## 2. Setup Awal Server

Urutan berikut adalah **rekomendasi** untuk server baru. Lewati langkah yang sudah pernah diatur.

### Step 1: Set Role

```
/set-role verified @Verified
/set-role unverified @Unverified
/set-role admin @Staff
```

**Penjelasan:**

- Role `verified` — role yang didapat member setelah menekan tombol verifikasi
- Role `unverified` — role default member baru (dilepas setelah verifikasi)
- Role `admin` — role staff yang mendapat akses channel tiket + panel admin
- Perubahan admin role langsung efektif (cache di-invalidate otomatis)

### Step 2: Set Channel

```
/set-channel welcome #welcome
/set-channel goodbye #goodbye
/set-channel invoice #testimoni
/set-channel audit-log #audit-log
/set-channel transcript #transcript
```

**Penjelasan:**

- `welcome` — channel tempat bot mengirim welcome message saat member join
- `goodbye` — channel tempat bot mengirim goodbye message saat member leave/kick/ban
- `invoice` — channel testimoni transaksi (otomatis terisi setiap Set Key / Kirim Pesanan / Pesanan Sukses — **sekali per tiket**, tidak dobel)
- `audit-log` — channel tempat bot mencatat SEMUA admin action (50 action types; dikirim ulang 1x otomatis bila gagal karena rate limit/network)
- `transcript` — channel arsip transcript tiket (chat history tersimpan otomatis setiap tiket di-close)

> 💡 Sejak v3.9.30 semua channel diatur lewat **satu command** `/set-channel` — termasuk transcript (dulu command terpisah `/set-transcript-channel`). Hapus dengan `/remove-channel <tipe>`.

### Step 3: Pasang Panel Verifikasi

```
/setup-verify
```

Bot mengirim embed + tombol "Verifikasi Saya" ke channel tempat command dijalankan. Member baru menekan tombol → mendapat role Verified + role Unverified dilepas.

**Rekomendasi:** pasang di channel `#information` atau `#rules`, lalu pin pesannya.

### Step 4: Tambah Produk ke Price List

```
/add-product label:"7 Days" value:7d price:"Rp. 25.000" duration:"7 Hari"
/add-product label:"30 Days" value:30d price:"Rp. 80.000" duration:"30 Hari"
/add-product label:"Permanent" value:perm price:"Rp. 250.000" duration:"Permanen"
```

**Aturan:**

- `label` — nama yang ditampilkan ke member
- `value` — ID unik (tanpa spasi, mis. `7d`, `30d`, `perm`)
- `price` — string bebas; bisa format Indonesia (`Rp. 50.000`) atau angka biasa
- `duration` — opsional, hanya keterangan (tidak otomatis menjadi durasi expire role)
- Maksimal 25 produk (batas dropdown Discord)

### Step 5: Set Auto-Role untuk Produk

Untuk setiap produk, tentukan role yang akan didapat pembeli + durasi expire:

```
/set-product-role value:7d role:@VIP 7 Days days:7
/set-product-role value:30d role:@VIP 30 Days days:30
/set-product-role value:perm role:@VIP Permanent days:0
```

**Aturan:**

- `days:0` = permanen (role tidak pernah otomatis dihapus)
- `days:7` = role otomatis dihapus setelah 7 hari
- Role bot harus berada di ATAS role VIP di server settings

### Step 6: Pasang Panel Tiket

```
/setup-ticket
```

Bot mengirim embed + 5 tombol default (Beli Key / Transaksi, Help, Report, Claim Giveaway, 🤝 Rekber / Middleman) ke channel tempat command dijalankan. Tombol 🤝 Rekber membuka formulir deal escrow (bukan tiket — lihat bagian Midman/Rekber). Member menekan tombol → bot membuat channel tiket private.

**Rekomendasi:** pasang di `#information` atau channel khusus `#order-here`, lalu pin pesannya.

#### Custom Tombol & Kategori Tiket

Semua tombol tiket **100% dinamis** — dapat ditambah, diubah, dan dihapus dari Discord tanpa edit kode:

```
# Lihat semua kategori
/list-categories

# Tambah kategori baru (contoh: tombol "Partnership")
/add-category id:partnership label:"Partnership" emoji:"🤝" style:"Primary" requires_key:false

# Ubah kategori tanpa hapus + tambah ulang
/update-category id:partnership label:"Kerjasama" emoji:"💼" style:"Success"

# Hapus kategori (kecuali default: transaction, help, report)
/remove-category id:claim_giveaway

# Setelah mengubah kategori, refresh panel yang sudah terpasang:
/refresh-panel id:<panel-id>
```

**Arti `requires_key`:**

- `requires_key: true` → produk di kategori ini default pakai key (dropdown produk, tombol 🔑 **Set Key**). Contoh: `transaction`, `lisensi_key`.
- `requires_key: false` → produk di kategori ini default TANPA key (dropdown produk, tombol 📦 **Kirim Pesanan**). Contoh: `jasa`, `akun_ml`, `help`, `report`, `partnership`.

> **Rule klasifikasi (v3.9.28):** `requires_key` hanya menentukan **paket tombol** (Set Key vs Kirim Pesanan). Routing channel **TRANSAKSI vs BANTUAN** ditentukan oleh "kategori punya produk atau tidak", bukan oleh `requires_key`. Menambah kategori baru (`akun_ml`, `lisensi_key`, `topup_diamond`, ...) **aman otomatis** — hanya kategori `help` / `report` / produk ber-flag `isHelp` yang masuk BANTUAN; semua id kategori lain otomatis TRANSAKSI. Id kategori bebas asal format `[a-zA-Z0-9_-]{1,30}`. Terverifikasi oleh 14 unit test khusus (`tests/unit/newCategorySafety.test.js`).
>
> ⚠️ **Penting:** produk transaksi yang **tidak memiliki** flag `requires_key` (mis. produk lama) dianggap **pakai key** (tombol Set Key). Untuk produk akun/jasa pastikan `requires_key:false` — cara termudah: set di **kategori**-nya, semua produk baru di kategori itu mewarisi otomatis.

**Matriks behavior tiket:**

| Skenario Kategori                      | Produk di kategori   | Behavior                                                        |
| -------------------------------------- | -------------------- | --------------------------------------------------------------- |
| `transaction` (requires_key: true)     | Ada produk key       | Dropdown 🔑 → Set Key                                           |
| `transaction` (requires_key: true)     | Campur key & non-key | Dropdown 🔑/📦 → Set Key untuk key, Kirim Pesanan untuk non-key |
| `jual_akun` (requires_key: false)      | Ada produk akun/jasa | Dropdown 📦 → Kirim Pesanan (tanpa Set Key)                     |
| `akun_ml` (requires_key: false)        | Ada produk           | Dropdown 📦 → Kirim Pesanan                                     |
| `lisensi_key` (requires_key: true)     | Ada produk           | Dropdown 🔑 → Set Key                                           |
| `help` / `report` / `partnership` dll. | Kosong               | Langsung buat tiket (BANTUAN)                                   |

> **Safety-net (v3.9.29):** `/setup-ticket-panel` & `/refresh-panel` memberi **peringatan** jika ada kategori di panel yang belum punya produk — klik tombol kategori kosong membuka tiket BANTUAN, bukan transaksi. Tambahkan minimal 1 produk via `/add-product` jika kategori memang untuk jualan. Kategori `help`/`report` tidak diperingatkan (memang quick-action); kategori `midman` juga tidak (v3.9.37 — tombolnya membuka deal rekber, bukan tiket, jadi "tanpa produk" bukan masalah).

**Contoh setup kategori baru (terverifikasi aman oleh unit test):**

```
# Jual akun ML — produk tanpa key (tombol 📦 Kirim Pesanan)
/add-category id:akun_ml label:"Akun ML" emoji:🎮 requires_key:false
/add-product label:"Akun ML Mythic" value:ml_mythic price:"Rp 150.000" category:akun_ml
#  ↑ requires_key tidak diisi → mewarisi false dari kategori

# Lisensi key — produk pakai key (tombol 🔑 Set Key)
/add-category id:lisensi_key label:"Lisensi Key" emoji:🔑 requires_key:true
/add-product label:"Windows 11 Pro OEM" value:win11_pro price:"Rp 150.000" category:lisensi_key

# Refresh panel supaya kategori baru muncul:
/refresh-panel id:<panel-id>
```

**Tiga pendekatan setup — pilih sesuai kebutuhan:**

- **Cara 1 (sederhana):** semua produk (key + non-key) di kategori `transaction`. Member memilih lewat satu dropdown.
- **Cara 2 (terpisah):** buat kategori khusus (mis. `jasa`, `akun_ml`) dan isi dengan produknya. Member memilih kategori dulu → dropdown produk muncul.
- **Cara 3 (quick action):** kategori tanpa produk (mis. `claim_giveaway`, `partnership`) untuk akses cepat tanpa pemilihan produk.

**Ubah produk yang sudah ada:**

```
# Edit tanpa hapus + tambah ulang — hanya field yang diisi yang berubah
/update-product value:vip30 label:"VIP 30 Hari Promo" price:"Rp 40.000"

# Pindah kategori produk
/update-product value:joki category:jasa

# Ubah requires_key (dari key ke non-key atau sebaliknya)
/update-product value:joki requires_key:false
```

Tombol Set Key di tiket lama tetap berfungsi setelah rename (lookup produk memakai `value` yang stabil, bukan label).

**Migrasi otomatis saat bot start:**

- Label `"Bantuan Staff"` → `"Help"` (hanya jika belum di-customize)
- Label `"Laporkan Member"` → `"Report"` (hanya jika belum di-customize)
- Kategori `claim_giveaway` ditambahkan jika belum ada. Jika admin menghapusnya via `/remove-category`, bot menandai `claimGiveawayDismissed` dan **tidak menambahkannya kembali**.

### Step 7: (Opsional) Pasang Self-Role Panel

Untuk member yang ingin mengambil role sendiri (mis. role notif game):

```
/setup-selfrole title:"Pilih Notif Game" description:"Klik role yang Anda mau" type:button exclusive:false
/selfrole-add panel_id:sr_xxx role:@Notif ML label:"Notif ML" emoji:"🎮" style:Primary
/selfrole-add panel_id:sr_xxx role:@Notif PUBG label:"Notif PUBG" emoji:"🔫" style:Success
```

**Opsi lanjutan `/selfrole-add`:**

- `style` — warna tombol: Primary (blurple), Secondary (abu-abu), Success (hijau), Danger (merah)
- `requires_role` — role prerequisite: role baru bisa diambil setelah member memiliki role lain (berguna untuk role bertingkat)
- `type:select` di `/setup-selfrole` — memakai dropdown (lebih rapi untuk banyak role)

### Step 8: Cek Konfigurasi

```
/config-show
```

Menampilkan embed dengan seluruh setting saat ini: roles, channels, products, key stats, schedule stats, self-role panels.

---

## 3. Manajemen Produk & VIP

### Tambah Produk Baru

```
/add-product label:"60 Days" value:60d price:"Rp. 150.000" duration:"60 Hari"
/set-product-role value:60d role:@VIP 60 Days days:60
```

### Ubah Produk (label / harga / durasi / kategori)

```
/update-product value:60d price:"Rp. 175.000"
/update-product value:60d label:"60 Days+" duration:"60 Hari" category:transaction
```

Semua field opsional — hanya yang diisi yang berubah. Tombol Set Key di tiket lama tetap berfungsi setelah rename (lookup memakai `value` yang stabil).

### Lihat Semua Produk

```
/list-products
/list-product-roles
```

### Beri Key Manual (tanpa tiket)

Untuk member yang sudah bayar lewat DM / transfer langsung:

```
/set-key user:@member value:30d key:ABCDE-12345-FGHIJ
```

Bot otomatis:

1. Menyimpan key ke `keys.json` (di-scope per guild)
2. Memberi role VIP
3. Menjadwalkan auto-remove (model MAX EXTEND)
4. DM member dengan key + info expire
5. Mengirim invoice ke channel invoice
6. Mencatat purchase ke stats
7. Audit log `SET_KEY` — **key dimasking** (hanya `***` + panjang, nilai key tidak pernah bocor)

### Lihat Key Member

```
/list-keys user:@member
```

Menampilkan semua key member (aktif & expired) + sisa waktu masing-masing.

### Reset VIP Member (Full Reset)

Untuk kasus reset / refund:

```
/clear-schedule user:@member clear_keys:true
```

Bot akan:

- Menghapus semua schedule role user (di guild ini saja)
- Menghapus SEMUA key user dari `keys.json` (di guild ini saja)
- Melepas semua role VIP terkait produk

**Hati-hati:** tidak bisa di-undo. Gunakan `clear_keys:false` jika hanya ingin menghapus schedule tanpa menghapus key.

---

## 4. Operasional Harian (Tiket, Announce, Embed)

### Flow Tiket Transaksi (paling sering dipakai)

#### A. Produk pakai key (mis. VIP 30 Hari)

1. Member menekan **🛒 Beli Key** di panel tiket → memilih produk (🔑)
2. Bot membuat channel tiket private `#ticket-{user-id}`
3. Member mengirim bukti pembayaran
4. Admin konfirmasi → menekan **🔑 Set Key** di tiket
5. Modal muncul → admin mengetik key → submit
6. Bot otomatis: simpan key, beri role, jadwalkan expire, DM member, kirim invoice
7. Channel tiket **tetap terbuka** (tidak otomatis dihapus) — bot mengirim pesan singkat "key sudah dikirim ke DM". Admin & member bisa tanya-jawab dulu (mis. cara pakai key)
8. Setelah selesai, admin menekan **🔒 Tutup Tiket** → pilih **✅ Selesai** → bot menyimpan transcript otomatis ke channel transcript, lalu menghapus channel

#### B. Produk TANPA key (jual akun ML, jasa, dll.)

1. Tambahkan produk dengan `requires_key:false`:

    ```
    /add-product label:"Akun ML Mythic" value:akun_ml price:"Rp 150.000" category:transaction requires_key:false
    ```

    (opsional: `/set-product-role value:akun_ml role:@Customer days:0` untuk auto-role)

2. Member memilih produk (📦) di dropdown → tiket TRANSAKSI dibuat dengan tombol **📦 Kirim Pesanan**
3. Member mengirim bukti pembayaran
4. Admin konfirmasi → menekan **📦 Kirim Pesanan** → modal muncul → admin mengetik detail pesanan (username/password/note — Enter = baris baru, maks 1500 karakter)
5. Bot otomatis: **DM detail pesanan ke pembeli** (channel tiket terhapus saat close — DM menjadi satu-satunya salinan permanen bagi pembeli), auto-role (+ auto-expire jika `days` diisi), mencatat pembelian ke stats/leaderboard, mengirim invoice, audit log `ORDER_DELIVERED`
6. Tombol Tutup Tiket berubah menjadi **✅ Selesai** → transcript + hapus channel

> **Alternatif tanpa Kirim Pesanan:** admin langsung menekan **🔒 Tutup Tiket → ✅ Pesanan Sukses** — role + stats + invoice tetap berjalan otomatis. Cocok jika pesanan disampaikan lewat chat/bukan digital.

### Format DM & Notifikasi Tiket

Bot mengirim DM ke pembeli dengan format yang ramah mobile — key ditulis sebagai inline code (long-press di Discord mobile langsung memunculkan menu **Copy**), memakai emoji dan nama role (bukan mention, karena mention role tidak tampil di DM).

**Contoh DM yang dikirim ke member:**

```
Halo thor064747! Transaksi kamu udah selesai 🎉

📦 Produk: 3 DAYS
🌐 Server: Chronos

🔑 KEY:
`Abgs-1828`

🎭 Role: VIP 3 Days
⏰ Expire: 3 hari lagi

📋 Key aktif kamu untuk role ini:
1. `Test-1233` (sisa 3 hari lagi)
2. `12345` (sisa 3 hari lagi)
3. `Test-2910` (sisa 3 hari lagi)
4. `Abgs-1828` (sisa 3 hari lagi)

💡 Simpan keynya. Kalau role tiba-tiba hilang padahal key masih aktif, hubungi admin.
```

**Contoh notif di channel tiket (untuk member, bukan admin):**

```
Halo @user! 🔑 Key kamu udah dikirim via DM, cek ya 📬
```

Jika DM gagal dikirim (kemungkinan DM member ditutup):

```
⚠️ @user — gagal kirim DM (kemungkinan DM ditutup). Admin akan kirim key manual ya.
```

**Tips operasional tiket:**

- Sebelum menekan Set Key / Kirim Pesanan, pastikan pembayaran sudah masuk
- Key dapat berupa string bebas, mis. `ABCDE-12345-FGHIJ-67890`
- Detail pesanan dikirim ke DM **apa adanya** (tanpa modifikasi) — password tidak berubah
- Invoice otomatis terkirim ke channel invoice — **sekali per tiket** (tidak dobel)
- Transcript otomatis tersimpan ke channel transcript saat Tutup Tiket
- Metadata tiket (userId, productName, price, isTransaction, requiresKey, isCompleted) disimpan di `tickets.json` — bukan di channel topic (anti spoof/edit)
- Set Key sukses → channel **tetap terbuka**; karena `isCompleted=true`, saat Tutup Tiket hanya muncul tombol "✅ Selesai" (tanpa "Tidak Jadi Beli")

### Tutup Tiket Tanpa Transaksi

Menekan **🔒 Tutup Tiket** → pilih **❌ Tidak Jadi Beli** → tiket ditutup tanpa key/role.

### Quick Announce

```
/announce channel:#announcements title:"Maintenance Besok" description:"Server akan maintenance jam 03:00 WIB" color:#FF0000 mention:@everyone
```

**Format mention yang valid:**

- `@everyone` atau `everyone`
- `@here` atau `here`
- `<@&ROLE_ID>` — role mention (copy dari Discord)
- `<@USER_ID>` atau `<@!USER_ID>` — user mention

String lain ditolak dengan pesan error — mencegah admin tidak sengaja ping karena typo.

### Interactive Embed Builder (untuk embed kompleks)

```
/embed-builder
```

Bot mengirim draft + dropdown. Klik dropdown → pilih bagian (Title/Description/Color/Image/dst) → modal input → embed otomatis ter-update (live preview). Setelah selesai, klik **📤 Send** → input channel target → kirim.

**Tips:**

- Embed yang sudah terkirim tidak bisa diedit via builder — hapus manual + buat ulang
- Session hilang jika bot restart; TTL 1 jam (auto-cleanup anti memory leak)
- Gunakan `/embed-list` untuk melihat session aktif, `/embed-cancel` untuk membatalkan
- Validasi panjang: title (256), description (4096), field name (256), field value (1024) — kelebihan ditolak dengan pesan jelas

### Scheduled Announcement

```
/announce-schedule channel:#announcements title:"Event Weekend" description:"Mulai 19:00 WIB" at:"2h" mention:@here
/announce-schedule channel:#info title:"Reset Bulanan" description:"Top 10 dapat reward" at:"2026-02-01 09:00" recurring:monthly
```

**Format `at`:**

- `30m` — 30 menit dari sekarang
- `2h` — 2 jam dari sekarang
- `1d` — 1 hari dari sekarang (maks 365 hari)
- `2026-01-15 20:00` — tanggal & waktu spesifik (format `YYYY-MM-DD HH:mm`, WIB; maks 5 tahun ke depan)

**Recurring:** `daily`, `weekly`, `monthly` — bot otomatis menjadwalkan ulang setelah terkirim.

### Lihat & Cancel Scheduled Announcement

```
/announce-list
/announce-cancel id:ann_xxx
```

### 🤝 Midman / Rekber (Deal Escrow 3-Pihak)

Layanan jasa tengah untuk transaksi antar-member: **pembeli + penjual + midman** dalam satu channel deal. Inti keamanannya: **Deal Board** (embed bot) jadi sumber kebenaran — chat cuma tempat bukti (screenshot transfer, bukti kirim barang), dan setiap langkah hanya bisa digerakkan oleh pihak yang berhak, lewat tombol.

**Setup sekali (urutan bebas, semua wajib sebelum dipakai member):**

```
/set-role midman @Midman          ← role khusus tim rekber (siapa pun yang pegang role ini bisa handle deal)
/set-midman-fee mode:Persen value:5   ← fee 5% dari harga deal (atau mode:flat value:5000 untuk nominal tetap)
                                       fee DITAMBAH di atas harga: deal 100rb + fee 5rb → pembeli bayar 105rb, penjual terima 100rb PENUH
/set-channel tipe:invoice #testi     ← invoice deal sukses otomatis ke sini (sudah pernah? skip)
/set-channel tipe:transcript #log    ← transcript deal otomatis ke sini (sudah pernah? skip)
/setup-ticket                          ← pasang ulang panel — tombol 🤝 Rekber muncul otomatis
```

**Alur deal (versi cerita):**

1. **Siapa saja** (pembeli, penjual, atau pihak yang menolong — mis. midman/staff) klik 🤝 Rekber di panel → isi **formulir 3 langkah**: (1) modal item + harga, (2) **pilih 🛒 pembeli** dari dropdown daftar member, (3) **pilih 🏷️ penjual** — semua tinggal ketik nama di kolom pencarian (tidak perlu copy ID/mention) → bot buat channel di kategori `🤝 REKBER` + Deal Board.
2. **Pembeli & penjual** dua-duanya klik **🤝 Setuju Deal** → baru item & harga **TERKUNCI**. Board selalu menunjukkan siapa yang sudah/belum setuju. Mau ubah = batal & buat ulang.
3. **Pembeli** transfer **Total Pembayaran** (harga + fee — nominalnya tertera di board) ke midman, kirim bukti di channel. **Midman** cek rekening → klik **✅ Dana Masuk**.
4. **Penjual** kirim barang. **Pembeli** cek → klik **✅ Barang Diterima**.
5. **Midman** transfer **PENUH** ke penjual sesuai jumlah di board (fee tetap milik midman — tidak dipotong dari dana penjual) → klik **💸 Cairkan ke Penjual** → invoice + transcript + stats otomatis, channel close.

**Menambah / mengeluarkan orang di channel deal (mis. salah tambah, atau butuh saksi):**

- Tombol **👥 Tambah Member** (baris ke-2 Deal Board — khusus midman/admin) → pilih user dari dropdown → dia dapat akses lihat & chat sebagai **member tambahan**. Observer TIDAK bisa menggerakkan deal apa pun (transisi tetap hak pembeli/penjual/midman/admin) — jadi aman buat saksi atau staff yang dilatih.
- Tombol **➖ Keluarkan Member** → dropdown berisi member tambahan saat ini → pilih → aksesnya dihapus. Pembeli/penjual **tidak bisa** dikeluarkan lewat sini (urusan mereka hanya lewat batal deal / dispute).
- Semua add/remove tercatat di history deal (muncul di ringkasan riwayat saat close), audit log, dan field **👀 Member Tambahan** di Deal Board — siapa pun di channel tahu siapa tamunya.

**Kalau ada masalah:** siapa saja peserta klik **⚠️ Ada Masalah** → deal **DIBEKUKAN** (semua tombol mati, admin di-ping). Admin resolve: **⚖️ Resolve: Cairkan** (deal sukses) atau **↩️ Resolve: Refund** (dana kembali ke pembeli — midman wajib refund manual).

**Monitoring:** `/midman-deals` (list semua deal aktif + status), `/config-show` (role midman + fee terpasang).

**Yang dijaga bot secara struktural (tidak bisa diakali):**

- Cairkan sebelum barang diterima → ditolak. Buyer klik "Dana Masuk" → ditolak (bukan midman).
- Terms terkunci HANYA setelah pembeli & penjual **dua-duanya** setuju — siapa pun yang membuat deal, tidak ada satu orang yang bisa mengunci terms sendirian.
- Semua aksi saat dispute → mati. Hanya admin yang resolve.
- Fee dari config, bukan ketikan — midman tidak bisa patok fee sembarangan. Fee ditambah di atas harga (additive): penjual SELALU menerima harga penuh; pembeli membayar harga + fee.
- Member tambahan (observer) tidak bisa menggerakkan deal; pembeli/penjual tidak bisa dikeluarkan dari deal-nya sendiri.
- Semua klik tercatat: siapa, kapan, event apa (history deal + audit log + ringkasan sebelum close).
- 1 deal aktif per orang; user dengan deal aktif tidak bisa buka tiket biasa (anti-bypass).

**Tidak jadi pakai fitur rekber?** `/remove-category midman` — tombol hilang dari panel dan tidak muncul lagi.

**Catatan penting:** bot TIDAK memegang uang — transfer tetap manual oleh midman. Bot = buku besar + penjaga urutan + pencatat bukti. Pilih orang midman yang kamu percaya; bot memastikan semua tindakannya tercatat.

---

## 5. Moderation (Warn System)

### Beri Warning

```
/warn user:@member reason:"Spam di #general"
```

Bot akan:

- Menambah warning ke `warns.json` (di-scope per guild)
- DM member dengan alasan + total warning
- Auto-action saat mencapai threshold:
    - **3 warning** → mute (timeout) 1 jam
    - **5 warning** → mute (timeout) 1 hari
    - **7 warning** → kick dari server

**Catatan:** auto-action tidak diulang. Jika member mendapat warning ke-4 (setelah mute 1 jam di warning ke-3), bot tidak mute ulang — hanya threshold baru (5, 7) yang memicu action baru.

### Lihat History Warning

```
/warn-list user:@member
```

### Hapus 1 Warning

```
/warn-remove user:@member warn_id:warn_xxx
```

### Hapus SEMUA Warning

```
/warn-clear user:@member
```

### Hierarki Check

Bot menolak `/warn` jika:

- Admin mencoba warn diri sendiri
- Admin mencoba warn bot
- Admin mencoba warn member dengan role setingkat/lebih tinggi dari dirinya

---

## 6. Engagement (Giveaway & Poll)

### Buat Giveaway

```
/giveaway create channel:#giveaway prize:"VIP 30 Hari" duration:60 winners:1 required_role:@Verified
```

**Aturan:**

- `duration` dalam **menit** (min 1)
- `winners` 1–20
- `required_role` opsional — hanya member dengan role itu yang bisa ikut
- **Tidak otomatis ping `@everyone`** — jika ingin ping, gunakan `/announce` terpisah atau edit pesan giveaway setelah dibuat

Bot mengirim embed giveaway + tombol 🎉 Join / 🚪 Leave. Saat berakhir:

- Bot memilih winners (Fisher-Yates shuffle, distribusi uniform)
- Mengedit pesan menjadi "ENDED"
- Mengumumkan winners ke channel + DM winners
- Mencatat ke stats (leaderboard Top Winner)

**Anti double-join:** klik Join terlalu cepat (double-click < 100 ms) ditolak dengan pesan "Tunggu sebentar" — mencegah participant terdaftar dobel.

### Akhiri Giveaway Lebih Awal

```
/giveaway end id:gw_xxx
```

Bot memilih winners + update pesan + umumkan + DM + catat stats (sama seperti auto-end). Dikunci dengan user lock — double-invoke tidak menghasilkan pengumuman dobel.

### Reroll Winner

```
/giveaway reroll id:gw_xxx
```

Bot memilih 1 winner baru (mengecualikan winner lama), persist, umumkan, DM, catat stats.

### Buat Poll

```
/poll create channel:#polls question:"Event weekend ini?" multiple:false
```

Modal muncul → input options (1 per baris, min 2, maks 10). Bot mengirim embed poll dengan tombol per option. Member menekan → vote (toggle). Bar chart live update.

**Mode:**

- `multiple:false` — single choice (memilih option lain otomatis memindah vote)
- `multiple:true` — multi choice

**Anti double-vote:** klik terlalu cepat ditolak (sama seperti giveaway) supaya toggle dobel tidak membuat vote hilang.

### Tutup Poll

```
/poll close id:poll_xxx
```

Bot menonaktifkan semua tombol + menampilkan hasil akhir.

---

## 7. Fitur Komunitas Lanjutan

### Auto-Responder

Bot membalas pesan otomatis saat member mengetik trigger di awal pesan (case-insensitive).

```
/add-responder trigger:"!sosmed" reply:"Instagram: ig.com/serverkita\nYouTube: yt.com/@serverkita" reply_type:embed
/list-responder
/remove-responder trigger:"!sosmed"
```

- `reply_type`: `text` (plain) atau `embed`
- Support `\n` untuk multi-baris
- Cooldown default 3 detik per-user (dapat diatur per responder, `0` = nonaktif)
- Maks 50 responder per guild
- Anti mass-ping: mention di reply tidak memicu ping (`allowedMentions` dikunci)

### Anti-Spam & Auto-Mod

```
/set-automod spam_action:mute_10m word_action:delete_only mention_action:warn
/automod-toggle enabled:true
/automod-show
/add-word words:"kata1 kata2" tipe:blocklist action:mute_10m
/remove-word word:kata1
/list-words
/add-link-whitelist channel:#share-link
/remove-link-whitelist channel:#share-link
```

- **Spam**: N pesan dalam window (default 5/10 detik) → action
- **Word filter**: tambah kata satu per satu, action per kata, exempt word, matching **whole-word** ("asu" tidak match "asus")
- **Link block** + whitelist channel/role
- **Mass-mention** (default > 5 mention/pesan)
- Action: `delete_only`, `warn`, `mute_10m`, `mute_1h`, `kick`
- Admin & user ter-whitelist otomatis kebal

### AFK System

```
/afk reason:"Tidur\nJangan ganggu"
/afk-clear
/afk-list
```

- Saat di-mention, bot auto-reply dengan reason + durasi AFK (auto-delete 30 detik)
- AFK auto-clear saat user mengirim pesan lagi (bot menyapa "welcome back")
- Reason support `\n` multi-baris dan tidak bisa mass-ping

### Leveling System

```
/setup-leveling enabled:true xp_per_message:15 cooldown:60 announce_levelup:true
/add-level-role level:10 role:@Member Aktif
/list-level-roles
/remove-level-role level:10
/rank
/leaderboard-level
```

- XP per pesan dengan cooldown per-user (anti spam chat)
- Role reward otomatis saat level up (dapat bertingkat)
- `/rank` menampilkan kartu level pribadi, `/leaderboard-level` top 10

### Temp Voice

```
/setup-tempvoice channel:#Join For Voice
/tempvoice-remove
```

- Member join channel trigger → bot membuat voice channel pribadi (otomatis menjadi owner)
- Kontrol via panel: rename, lock, limit user, transfer ownership, delete
- Channel kosong otomatis dihapus; owner keluar → auto-transfer ke member paling senior

### Multi-Panel Tiket + Kustomisasi

```
/setup-ticket-panel channel:#tiket title:"Klik untuk order" body:"Harga:\n{price_list}" color:#ff5733
/list-panels
/update-panel id:tp_xxx field:thumbnail
/refresh-panel id:tp_xxx
/delete-panel id:tp_xxx
/set-channel transcript #transcript
```

- Beberapa panel berbeda di channel berbeda, masing-masing dapat memfilter kategori (`categories:transaction,help`)
- Semua field dapat dikustom: title, body (support template `{server}`, `{price_list}`, `{price_list:<kategori>}` + `\n`), warna, image, thumbnail, footer, tombol/dropdown
- Panel terdaftar persisten di `data/panels.json` (ikut backup)
- Transcript tiket otomatis tersimpan ke channel transcript sebelum close

**Edit image/thumbnail via `/update-panel`:** isi URL gambar di modal yang muncul — batas **2048 karakter** (limit URL embed Discord; URL CDN Discord yang signed umumnya 300–450 karakter). Kosongkan input untuk kembali ke default. Berlaku juga untuk `field:image`, `field:footer`, `field:title`, `field:body`, `field:color`.

**Safety-net kategori kosong:** `/setup-ticket-panel` & `/refresh-panel` memberi peringatan jika ada kategori di panel yang belum punya produk — klik tombolnya membuka tiket BANTUAN, bukan transaksi. Tambahkan produk via `/add-product` jika kategori memang untuk jualan.

### Edit Teks Pesan (modal + newline)

```
/set-message tipe:welcomeBody teks:"Halo {user}\nSelamat datang di {server}"
/edit-message tipe:ticketBody
/list-messages
/reset-message tipe:welcomeBody
```

- Input slash command di PC **tidak bisa Enter** (Enter = kirim form) — tulis `\n` untuk baris baru
- `\n` didukung di: send-message, announce, announce-schedule, set-message (tipe Body), setup-ticket-panel, responder, afk, warn, selfrole
- Di **modal** (popup form), Enter menghasilkan baris baru asli — tidak perlu `\n`
- ⚠️ Tipe **Title** sengaja tidak dikonversi — embed title Discord menolak newline (tulis `\n` di Title = tampil literal)

---

## 8. Backup & Restore

### Backup Manual

```
/backup-now
```

Bot membuat folder `backups/YYYY-MM-DD_HH-mm-ss/` berisi salinan **semua 16 file data** dari folder `data/`: config, keys, scheduledRoles, selfRoles, giveaways, polls, warns, stats, scheduledAnns, tempVoice, tickets, automod, levels, responders, afk, panels.

### Auto-Backup

- Saat bot start: backup otomatis
- Setiap 24 jam: backup otomatis
- Maksimal 7 backup terbaru disimpan (yang lama di-clean otomatis)

### Lihat Daftar Backup

```
/backup-list
```

Menampilkan semua backup, termasuk safety backup `pre-restore_*` (jika pernah restore).

### Restore Backup

```
/restore-backup name:2026-01-15_20-00-00
```

**Flow:**

1. Bot mengirim embed konfirmasi dengan 2 tombol: **Ya, Restore Sekarang** dan **Batal**
2. Admin menekan tombol → restore dijalankan
3. Bot otomatis membuat safety backup `pre-restore_*` sebelum menimpa (antisipasi salah restore)
4. Setelah restore selesai, semua cache in-memory di-reload otomatis (stats, panels, permissions, automod, afk, responders, levels)
5. **Restart bot** (`Ctrl+C` lalu `npm start`) tetap disarankan untuk konsistensi penuh

**Proteksi:**

- 2-step confirmation — tidak ada lagi restore tidak sengaja karena typo
- Restore lock — jika 2 admin menekan restore bersamaan, hanya 1 yang berjalan
- Path traversal guard — nama backup divalidasi (tidak boleh mengandung `..`, `/`, `\`)
- Pre-restore backup juga bisa di-restore

---

## 9. Troubleshooting

### Bot tidak online

- Cek `DISCORD_TOKEN` di `.env` benar
- Cek koneksi internet
- Cek console untuk pesan error

### Slash command tidak muncul

- Cek `GUILD_ID` di `.env` benar (server ID, bukan user ID)
- Cek bot sudah di-invite ke server itu
- Tunggu 1–2 menit untuk propagasi
- Jika masih tidak muncul, fallback ke global commands (kosongkan `GUILD_ID`, tunggu ± 1 jam)

### Member tidak dapat role setelah Set Key

- Cek **role bot berada di ATAS** role VIP di server settings (drag role bot ke atas)
- Cek bot punya permission `Manage Roles`
- Cek console untuk error "Gagal add role"

### Welcome/Goodbye tidak terkirim

- Cek `config.channels.welcome` / `config.channels.goodbye` sudah di-set via `/config-show`
- Cek bot punya `Send Messages` + `Embed Links` di channel itu
- Cek channel masih ada (belum dihapus)

### Auto-responder / anti-spam / AFK mention reply tidak berfungsi

**Penyebab paling sering: Message Content Intent belum diaktifkan.**

Bot membutuhkan akses ke `message.content`. Tanpa intent itu, Discord mengirim content sebagai **string kosong** → trigger tidak pernah match.

**Cara fix:**

1. Buka https://discord.com/developers/applications
2. Pilih bot Anda
3. Tab **Bot**
4. Scroll ke bagian _Privileged Gateway Intents_
5. Aktifkan ketiga intent:
    - ✅ PRESENCE INTENT
    - ✅ SERVER MEMBERS INTENT
    - ✅ **MESSAGE CONTENT INTENT** ← paling penting untuk fitur ini
6. Klik **Save Changes**
7. **Restart bot** (`npm start`)

Cek juga `/list-responder` untuk memastikan responder terdaftar. Trigger bersifat case-insensitive dan harus berada di awal pesan (`!sosmed` match `!sosmed halo`, tetapi tidak match `halo !sosmed`).

### Cooldown auto-responder terasa lama

Default 3 detik per-user. Untuk mengubah:

```
/add-responder trigger:"!sosmed" reply:"..." cooldown:0    # 0 = nonaktifkan cooldown
/add-responder trigger:"!sosmed" reply:"..." cooldown:10   # 10 detik
```

Cooldown bersifat **per-user** — user A memicu tidak memengaruhi user B.

### Audit log tidak terkirim

- Cek `config.channels['audit-log']` sudah di-set via `/set-channel audit-log #channel`
- Cek bot punya `Send Messages` + `Embed Links` + `View Audit Log` di channel itu
- Audit log otomatis dikirim ulang 1x jika gagal karena rate limit/network

### Stats tidak update

- Stats di-cache di memory, di-flush setiap 30 detik — tunggu sebentar lalu cek lagi
- Jika bot baru restart, stats lama tetap ada di `stats.json`
- Setelah restore backup, stats cache otomatis di-reload
- Cek `/stats` untuk agregat server, `/my-stats` untuk pribadi

### Tiket tidak bisa dibuat

- Cek `config.roles.admin` sudah di-set via `/set-role admin @role`
- Cek bot punya permission `Manage Channels`
- Cek kategori "🎫 TICKETS" dapat dibuat (server tidak mencapai limit 500 channel)
- Member hanya dapat memiliki 1 tiket aktif pada satu waktu

### Giveaway tidak auto-end

- Scheduler berjalan setiap 60 detik — tunggu maksimal 1 menit setelah `endsAt`
- Cek `giveaways.json` apakah entry ada dengan `ended: false`
- Gunakan `/giveaway end id:gw_xxx` untuk force-end manual

### Setelah restore, data masih lama

- Cache otomatis di-invalidate setelah restore; manager lain membaca dari disk dengan cache 15 detik
- Untuk konsistensi penuh, **restart bot** tetap disarankan

### Pesan "Tunggu sebentar, kamu lagi klik terlalu cepat"

- Muncul jika user double-click tombol (giveaway/poll) dalam < 100 ms
- Lock otomatis release dalam 5 detik — coba klik sekali lagi setelah 1 detik

---

## 10. Best Practices

### Keamanan

1. **Jangan pernah membagikan `DISCORD_TOKEN`** — siapa pun yang punya token dapat mengontrol bot
2. **Jangan pernah commit `.env`** ke git (sudah di `.gitignore`)
3. Folder `backups/` juga jangan di-commit (berisi data sensitif)
4. Rotasi token secara berkala (1–2 bulan sekali) di Discord Developer Portal
5. Batasi admin role hanya untuk orang yang dipercaya
6. Cek `#audit-log` secara berkala untuk deteksi penyalahgunaan

### Performa

1. Jangan menambah > 100 produk (melambatkan `/config-show` dan dropdown)
2. Jangan menambah > 10 self-role panel (memory + kompleksitas)
3. Backup manual sebelum maintenance besar: `/backup-now`
4. Jika server memiliki > 10.000 member, pertimbangkan migrasi dari JSON ke SQLite

### Operasional

1. **Selalu backup sebelum** mengubah config besar (`/backup-now`)
2. **Test di server kecil** dulu jika ada perubahan role/channel
3. **Pantau audit log** — cek `#audit-log` secara berkala
4. **Komunikasikan ke member** sebelum maintenance: `/announce` atau `/announce-schedule`
5. **Gunakan `/config-show`** sebelum troubleshooting — sering masalahnya config belum di-set

### Moderasi

1. **Jangan langsung kick/ban** — gunakan `/warn` dulu agar ada rekam jejak
2. **Beri alasan jelas** di `/warn reason:` — member perlu tahu kesalahannya
3. **Cek `/warn-list`** sebelum eskalasi — mungkin member sudah punya warning lama yang bisa dihapus
4. **Kick otomatis di threshold 7** — pastikan member sudah tahu sistem warning sebelum di-kick

### Member Engagement

1. **Gunakan `/leaderboard`** untuk menyorot member aktif di announcement
2. **Giveaway rutin** (mingguan/bulanan) untuk boost engagement
3. **Poll sebelum keputusan besar** (event, perubahan rule) — member lebih engaged
4. **Self-role panel** untuk personalisasi — member senang memilih role sendiri

---

## 11. Riwayat Versi

Riwayat lengkap semua versi (v3.9.0 – v3.9.37) tersedia di **[CHANGELOG.md](../CHANGELOG.md)**.

Ringkasan 3 versi terbaru:

- **v3.9.37** (2026-09-02) — 🐛 fix **/help** (Auto-Split kini 3 kategori TRANSAKSI/BANTUAN/REKBER — bug user-reported "masih 2"), section Midman/Rekber ditambah, versi embed kini dinamis dari package.json (anti stale); 🩹 audit menyeluruh v2: **restore-backup tidak lagi memutus deal rekber** (deals.json bolong dari FILES_TO_BACKUP), **deal zombie di-reconcile otomatis** (channel dihapus manual → pembeli/penjual dibebaskan dari lock, startup + harian), router `ticket_cat:midman` kini exact-match (kategori `midman_*` custom tidak mati), penjual deal kini juga dicek tiket aktifnya, deskripsi dropdown & warning panel rekber tidak menyesatkan lagi, label audit MIDMAN_*, +12 unit test (total 82 command, 324 unit test).
- **v3.9.36** (2026-09-02) — 🧹 code cleanup hasil audit menyeluruh: seluruh 37 lint warning dibersihkan jadi **0 error 0 warning**, dead code dihapus (formatTimeLeft duplikat, findOwnerVoiceChannel, save() legacy), variabel/import/require redundan dirapikan, typo pesan warning diperbaiki — tanpa perubahan perilaku, 312 unit test tetap hijau (total 82 command, 312 unit test).
- **v3.9.35** (2026-09-02) — 🐛 fix tombol konfirmasi close tiket non-transaksi (bantuan/help/report/claim/giveaway): tombol **❌ Tutup Tanpa Selesai** dulunya salah wiring ke customId yang sama dengan **⏏️ Batal Tutup** — akibatnya kedua tombol sama-sama hanya membatalkan penutupan dan tiket tidak bisa ditutup tanpa selesai. Sekarang tombol itu benar-benar menutup tiket (transcript ditandai tidak selesai, channel dihapus, meta dibersihkan); "Batal Tutup" konsisten memakai customId yang sama di semua skenario; tombol konfirmasi ephemeral lama tetap kompatibel (total 82 command, 312 unit test).
- **v3.9.34** (2026-09-02) — 🤝 rekber redesign alur: deal bisa dibuka **siapa saja** (pembeli/penjual/pihak yang menolong) lewat **formulir 3 langkah** (item+harga → pilih pembeli → pilih penjual, semua via dropdown searchable), **persetujuan ganda** (state WAITING_AGREE — pembeli & penjual dua-duanya klik Setuju Deal sebelum terms terkunci; deal lama dimigrasi otomatis), tombol **👥 Tambah Member / ➖ Keluarkan Member** di Deal Board (midman/admin; observer hanya bisa lihat & chat; pembeli/penjual tidak bisa dikeluarkan; maks 10), Deal Board field baru 👀 Member Tambahan, add/remove tercatat di history + audit (total 82 command, 305 unit test).
- **v3.9.33** (2026-09-02) — 🤝 rekber revisi: penjual dipilih via **dropdown member** (searchable — tanpa copy ID/mention; buat deal jadi 2 langkah), **fee additive** (ditambah di atas harga — penjual selalu terima harga penuh, contoh 100rb + 5% = pembeli bayar 105rb), Deal Board tampil `Total Dibayar Pembeli` + `Diterima Penjual` (penuh), invoice/stats pencatat pengeluaran nyata pembeli (harga+fee), fee snapshot ke deal (config berubah tidak mengubah deal berjalan), `parseSellerInput` dihapus (total 82 command, 291 unit test).
- **v3.9.32** (2026-09-02) — 🤝 fitur baru **Midman/Rekber**: deal escrow 3-pihak dengan Deal Board + state machine (gerbang ganda dana/barang), dispute & resolve admin, fee otomatis dari config, invoice/transcript/audit terintegrasi, `/set-midman-fee` + `/midman-deals`, kategori panel otomatis (total 82 command, 289 unit test).
- **v3.9.31** (2026-09-01) — hardening hasil code review: orphan meta saat close, null-safety channel, snapshot clear-schedule, +10 unit test.
- **v3.9.30** (2026-09-01) — `/set-transcript-channel` digabung ke `/set-channel tipe:transcript` — satu command untuk semua channel (total 80 command); `/remove-channel` & `/config-show` ikut mendukung transcript.
- **v3.9.28** (2026-09-01) — kategori baru aman otomatis (`classifyProduct()`): semua id kategori selain `help`/`report` otomatis TRANSAKSI; fix deskripsi dropdown kategori campur.

---

## 📞 Bantuan

Jika ada masalah yang tidak ada di Troubleshooting:

1. **Cek console output bot** — pesan error biasanya ada di sana
2. **Cek `/config-show`** — pastikan semua setting benar
3. **Cek `#audit-log`** — lihat action terakhir yang mungkin memicu masalah
4. **Cek file JSON** di folder `data/` — apakah formatnya valid (dapat dibuka di text editor). Jika ada file `*.corrupt-<timestamp>`, itu file yang gagal di-parse dan otomatis dikarantina bot — isinya dapat diperiksa/dipulihkan manual sebelum di-rename kembali.
5. **Backup dulu** (`/backup-now`) sebelum debugging lebih lanjut

---

**Versi dokumen:** v3.9.37
**Last updated:** 2 September 2026
**Bot version:** 3.9.37 · 82 slash command · 324 unit test
