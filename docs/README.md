# 📚 Dokumentasi — Thor Bot

Kumpulan dokumen resmi untuk **Thor — All-in-One Discord Community Bot** (v3.9.30).

| Dokumen                            | Isi                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)          | Ringkasan project: fitur, instalasi, konfigurasi awal, development, troubleshooting dasar                                                      |
| [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) | Panduan admin lengkap: setup server, manajemen produk & VIP, operasional harian, moderation, backup & restore, troubleshooting, best practices |
| [CHANGELOG.md](../CHANGELOG.md)    | Riwayat lengkap semua versi (v3.9.0 – v3.9.30)                                                                                                 |

## Mulai Cepat

- **Admin baru?** Baca [ADMIN_GUIDE → Section 1 (Quick Start 5 menit)](./ADMIN_GUIDE.md#1-quick-start-5-menit), lalu ikuti [Section 2 (Setup Awal Server)](./ADMIN_GUIDE.md#2-setup-awal-server) langkah demi langkah.
- **Ingin jualan (produk key / akun / jasa)?** Fokus ke [Section 2 Step 6](./ADMIN_GUIDE.md#step-6-pasang-panel-tiket) (panel tiket & kategori) dan [Section 4](./ADMIN_GUIDE.md#4-operasional-harian-tiket-announce-embed) (flow transaksi harian).
- **Bot bermasalah?** Mulai dari [README → Troubleshooting](../README.md) untuk kasus umum, atau [ADMIN_GUIDE → Section 9](./ADMIN_GUIDE.md#9-troubleshooting) untuk daftar lengkap.
- **Ingin tahu apa yang berubah?** Lihat [CHANGELOG](../CHANGELOG.md) atau ringkasan 3 versi terakhir di [ADMIN_GUIDE → Section 11](./ADMIN_GUIDE.md#11-riwayat-versi).

## Statistik Project

- **82 slash command** — semua fitur dapat dikonfigurasi dari Discord, tanpa edit file
- **248 unit test** — `node:test`, sandbox (aman dijalankan di server live)
- **discord.js v14** · Node.js 18+ · single-guild
- **CI/CD** — GitHub Actions menjalankan lint + test pada setiap push (Node 18/20/22)

## Kontributor / Developer

Struktur kode, arsitektur per-domain, dan panduan development tersedia di [README.md → Struktur Proyek](../README.md). Jalankan `npm test` sebelum commit — CI akan menolak kode yang gagal test.
