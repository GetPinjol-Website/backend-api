import pkg from 'natural';
const { StemmerId } = pkg;
import fs from 'fs';
import path from 'path';
// --- FIX START ---
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --- FIX END ---


// --- 1. Muat Kamus dan Stopwords ---
// This line will now work correctly
const normalizationDict = JSON.parse(fs.readFileSync(path.join(__dirname, 'model_assets', 'normalization_dict.json'), 'utf8'));

// Daftar stopwords Bahasa Indonesia (bisa ditambah/dikurangi)
// Termasuk stopwords custom dari notebook Anda
const customStopwords = new Set([
    'yg', 'dg', 'rt', 'dgn', 'ny', 'd', 'klo', 'kalo', 'amp', 'biar', 'bikin', 'bilang',
    'gak', 'ga', 'krn', 'nya', 'nih', 'sih', 'si', 'tau', 'tdk', 'tuh', 'utk', 'ya',
    'jd', 'jgn', 'sdh', 'aja', 'n', 't', 'nyg', 'hehe', 'pen', 'u', 'nan', 'loh', 'ko', 'dst', 'dll',
    'di', 'ke', 'dari', 'dan', 'atau', 'tapi', 'yang', 'untuk', 'dengan', 'saya', 'ini', 'itu', 'adalah'
    // Tambahkan stopwords lain jika perlu
]);

// --- 2. Fungsi-fungsi Helper ---

/**
 * Mengubah kata slang/singkatan menjadi kata baku.
 * @param {string[]} tokens - Array kata-kata.
 * @returns {string[]} Array kata-kata yang sudah dinormalisasi.
 */
function normalizeSlang(tokens) {
    return tokens.map(token => normalizationDict[token] || token);
}

/**
 * Fungsi utama untuk membersihkan dan memproses teks ulasan.
 * @param {string} text - Teks ulasan mentah.
 * @returns {string} Teks yang sudah bersih dan siap untuk di-vektorisasi.
 */
export function preprocessText(text) {
    if (!text) return '';

    // 1. Lowercasing
    let cleanedText = text.toLowerCase();

    // 2. Hapus URL, mention, hashtag (opsional, tapi bagus)
    cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, '');
    cleanedText = cleanedText.replace(/@[^\s]+/g, '');
    cleanedText = cleanedText.replace(/#[^\s]+/g, '');

    // 3. Hapus angka dan tanda baca
    cleanedText = cleanedText.replace(/[\d.,\/#!$%\^&\*;:{}=\-_`~()\[\]?]/g, '');
    
    // 4. Hapus emoji (opsional)
    cleanedText = cleanedText.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '');

    // 5. Tokenisasi (membagi string menjadi array kata)
    let tokens = cleanedText.split(/\s+/).filter(Boolean); // filter(Boolean) untuk hapus string kosong

    // 6. Normalisasi Slang
    tokens = normalizeSlang(tokens);
    
    // 7. Hapus Stopwords
    tokens = tokens.filter(token => !customStopwords.has(token));

    // 8. Stemming menggunakan 'natural'
    tokens = tokens.map(token => StemmerId.stem(token));

    // 9. Gabungkan kembali menjadi string
    return tokens.join(' ');
}