
'use strict';

const Hapi = require('@hapi/hapi');
const fs = require('fs').promises;
const path = require('path');

// --- PERBAIKAN IMPORT FINAL ---
// Mengakses properti 'default' dari modul yang diimpor
const gplay = require('google-play-scraper').default;
const { NotFoundError } = require('google-play-scraper').default; // Asumsi NotFoundError juga ada di dalam default

// Global object untuk menampung aset yang dimuat
// Di lingkungan serverless, variabel global mungkin di-reset antar invocations,
// tapi Vercel meng-cache instance function, jadi aset kemungkinan tetap di memori
// setelah cold start pertama.
const assets = {};

/**
 * Memuat semua file aset (JSON) dari folder model_assets ke memori.
 * PATH PERLU DISESUAIKAN AGAR RELATIF TERHADAP LOKASI FILE INI (api/index.js).
 * Jika api/index.js ada di root dan model_assets ada di root, path-nya sudah benar.
 * Jika api/index.js ada di folder api, dan model_assets ada di root,
 * Anda mungkin perlu menggunakan path seperti '../model_assets'.
 * Asumsi saat ini api/index.js dan model_assets ada di root.
 */
const loadAssets = async () => {
    // Jika aset sudah dimuat, tidak perlu memuat lagi (untuk re-use instance function)
    if (Object.keys(assets).length > 0 && assets.legal_companies_set) {
        console.log("✅ Aset sudah dimuat sebelumnya. Menggunakan cache.");
        return;
    }

    try {
        console.log("🚀 Memuat aset dari file JSON...");

        // Path disesuaikan jika diperlukan. Saat ini diasumsikan model_assets ada di root.
        const assetsPath = path.join(__dirname, 'model_assets'); // Sesuaikan path jika model_assets tidak di root

        const [
            legalitasData,
            modelParams,
            normalizationDict,
            tfidfVocab,
            tfidfIdfWeights
        ] = await Promise.all([
            fs.readFile(path.join(assetsPath, 'legalitas_data.json'), 'utf-8'),
            fs.readFile(path.join(assetsPath, 'model_params.json'), 'utf-8'),
            fs.readFile(path.join(assetsPath, 'normalization_dict.json'), 'utf-8'),
            fs.readFile(path.join(assetsPath, 'tfidf_vocabulary.json'), 'utf-8'),
            fs.readFile(path.join(assetsPath, 'tfidf_idf_weights.json'), 'utf-8'),
        ]);

        assets.legal_companies_set = new Set(JSON.parse(legalitasData).legal_companies);
        assets.ilegal_developers_set = new Set(JSON.parse(legalitasData).ilegal_developers);
        assets.model_params = JSON.parse(modelParams);
        assets.normalization_dict = JSON.parse(normalizationDict);
        assets.tfidf_vocab = JSON.parse(tfidfVocab);
        assets.tfidf_idf_weights = JSON.parse(tfidfIdfWeights);

        console.log("✅ Semua aset berhasil dimuat.");
    } catch (error) {
        console.error("❌ Gagal memuat aset penting!", error);
         // Di serverless, jangan process.exit, lempar error agar Vercel menanganinya
        throw new Error("Failed to load essential assets: " + error.message);
    }
};

/**
 * Fungsi untuk membersihkan teks.
 */
const cleanText = (text) => {
    let newText = String(text).toLowerCase();
    newText = newText.replace(/\d+/g, '');
    newText = newText.replace(/[^\w\s]/g, '');
    newText = newText.replace(/\s+/g, ' ').trim();
    return newText;
};

/**
 * Fungsi untuk menormalisasi kata slang.
 */
const normalizeSlang = (text, normalizationDict) => {
    if (!text) return '';
    const tokens = text.split(' ');
    const normalizedTokens = tokens.map(token => normalizationDict[token] || token);
    return normalizedTokens.join(' ');
};

/**
 * Melakukan transformasi TF-IDF secara manual.
 */
const transformTfidf = (texts, vocab, idfWeights) => {
    // Ukuran vocabulary menentukan jumlah fitur
    const vocabSize = Object.keys(vocab).length;
    const tfidfMatrix = [];

    for (const text of texts) {
        const featureVector = new Array(vocabSize).fill(0);
        if (!text) {
            tfidfMatrix.push(featureVector);
            continue;
        }

        const tokens = text.split(' ');
        const termCounts = {};
        let tokenCount = 0;

        for (const token of tokens) {
            if (vocab[token] !== undefined) {
                termCounts[token] = (termCounts[token] || 0) + 1;
                tokenCount++;
            }
        }

        if (tokenCount > 0) {
            for (const term in termCounts) {
                const termIndex = vocab[term];
                const tf = termCounts[term] / tokenCount;
                // Jika kata tidak ada di IDF weights, IDF-nya dianggap 1 (tidak mengubah TF)
                const idf = idfWeights[term] || 1;
                featureVector[termIndex] = tf * idf;
            }
        }
        tfidfMatrix.push(featureVector);
    }
    return tfidfMatrix;
};

/**
 * Melakukan prediksi dengan model Logistic Regression.
 */
const predict = (featuresMatrix) => {
     // Pastikan assets.model_params sudah dimuat
    const { coefficients, intercepts, classes } = assets.model_params;
    const predictions = [];

    for (const features of featuresMatrix) {
        let maxScore = -Infinity;
        let predictedClass = classes[0];

        for (let i = 0; i < classes.length; i++) {
            const coef = coefficients[i];
            const intercept = intercepts[i];

            let score = intercept;
            // Dot product
            for(let j = 0; j < features.length; j++) {
                score += features[j] * coef[j];
            }

            if (score > maxScore) {
                maxScore = score;
                predictedClass = classes[i];
            }
        }
        predictions.push(predictedClass);
    }
    return predictions;
};

/**
 * Menerapkan logika rekomendasi.
 */
const generateRecommendation = (row) => {
    if (row.legal_status === 'ilegal' || row.legal_status === 'unknown') {
        return "Tidak Direkomendasikan (Status Legalitas Tidak Pasti/Ilegal)";
    }
    if (row.legal_status === 'legal') {
        if (row.total_reviews === 0) {
            return "Pertimbangkan dengan Hati-hati (Tidak Ada Ulasan)";
        }
        if (row.perc_positif > 60 && row.perc_negatif < 25) {
            return "Direkomendasikan";
        }
        if (row.perc_negatif > 40) {
            return "Tidak Direkomendasikan (Sentimen Negatif Tinggi)";
        }
        return "Pertimbangkan dengan Hati-hati";
    }
    return "Tidak Dapat Ditentukan";
};


// Variabel untuk menyimpan instance server Hapi setelah inisialisasi pertama
let hapiServerInstance = null;

/**
 * Fungsi untuk membuat atau mendapatkan instance server Hapi.
 * Dipanggil oleh handler utama Vercel.
 */
const createServer = async () => {
    // Jika server sudah dibuat, gunakan instance yang ada (penting untuk re-use instance function)
    if (hapiServerInstance) {
        console.log("✅ Menggunakan instance server Hapi yang sudah ada.");
        return hapiServerInstance;
    }

    await loadAssets(); // Pastikan aset dimuat sebelum membuat server

    const server = Hapi.server({
        // Di Vercel, port dan host akan diatur oleh environment Vercel.
        // HAPI akan secara otomatis menggunakan port yang disediakan jika berjalan di fungsi serverless.
        port: process.env.PORT,
        host: process.env.HOST
    });

    // Route untuk root path di `/api/` (karena file ada di folder api)
    server.route({
        method: 'GET',
        path: '/',
        handler: (request, h) => {
            return {
                message: "Selamat datang di API Rekomendasi Aplikasi Pinjol (via Vercel).",
                status: "ok",
                // Path untuk route analyze akan menjadi `/api/analyze`
                docs_url: "/api/analyze?app_name=nama_aplikasi"
            };
        }
    });

    // Route untuk analyze path di `/api/analyze`
    server.route({
        method: 'GET',
        path: '/analyze',
        handler: async (request, h) => {
            const { app_name } = request.query;
            if (!app_name) {
                return h.response({ error: "Parameter \'app_name\' tidak boleh kosong." }).code(400);
            }

            try {
                // 1. Scrape Play Store
                const searchResults = await gplay.search({ term: app_name, num: 1, lang: 'id', country: 'id' });

                if (!searchResults.length) {
                    return h.response({ error: `Aplikasi \'${app_name}\' tidak ditemukan.` }).code(404);
                }

                const details = await gplay.app({ appId: searchResults[0].appId, lang: 'id', country: 'id' });

                // 2. Cek Legalitas
                const rawDeveloper = details.developer || '';
                const developer_clean = rawDeveloper
                    .toLowerCase()
                    .replace(/[.,]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();

                let legal_status = 'unknown';
                // Pastikan assets.legal_companies_set dan assets.ilegal_developers_set sudah dimuat
                if (assets.legal_companies_set.has(developer_clean)) {
                    legal_status = 'legal';
                } else if (assets.ilegal_developers_set.has(developer_clean)) {
                    legal_status = 'ilegal';
                }

                // 3. Ambil & Proses Ulasan
                let perc_pos = 0, perc_neg = 0, perc_neu = 0, total_reviews_analyzed = 0, sentiment_distribution = {};
                 // Ambil 100 ulasan terbaru
                const reviewData = await gplay.reviews({ appId: details.appId, lang: 'id', country: 'id', sort: gplay.sort.NEWEST, num: 100 });

                if (reviewData.data && reviewData.data.length > 0) {
                    const reviewTexts = reviewData.data.map(r => r.text);

                    const preprocessedTexts = reviewTexts.map(text => {
                        const cleaned = cleanText(text);
                         // Pastikan assets.normalization_dict sudah dimuat
                        return normalizeSlang(cleaned, assets.normalization_dict);
                    });

                     // Pastikan assets.tfidf_vocab dan assets.tfidf_idf_weights sudah dimuat
                    const tfidfFeatures = transformTfidf(preprocessedTexts, assets.tfidf_vocab, assets.tfidf_idf_weights);
                     // Pastikan assets.model_params sudah dimuat
                    const predictions = predict(tfidfFeatures);

                    const sentimentCounts = predictions.reduce((acc, val) => {
                        acc[val] = (acc[val] || 0) + 1;
                        return acc;
                    }, {});

                    total_reviews_analyzed = predictions.length;
                    if(total_reviews_analyzed > 0) {
                        perc_pos = ((sentimentCounts[2] || 0) / total_reviews_analyzed) * 100;
                        perc_neg = ((sentimentCounts[0] || 0) / total_reviews_analyzed) * 100;
                        perc_neu = ((sentimentCounts[1] || 0) / total_reviews_analyzed) * 100;
                    }
                    sentiment_distribution = {"Positif": sentimentCounts[2] || 0, "Negatif": sentimentCounts[0] || 0, "Netral": sentimentCounts[1] || 0};
                }

                // 4. Buat Rekomendasi
                const recommendationData = {
                    legal_status, total_reviews: total_reviews_analyzed,
                    perc_positif: parseFloat(perc_pos.toFixed(2)), // Format ke 2 desimal
                    perc_negatif: parseFloat(perc_neg.toFixed(2)), // Format ke 2 desimal
                    avg_rating: details.score
                };
                const recommendation_text = generateRecommendation(recommendationData);

                // 5. Kembalikan Hasil
                return h.response({
                    requested_app_name: app_name,
                    app_details: {
                        title: details.title, appId: details.appId, developer: details.developer,
                        score: details.score, installs: details.installs,
                        summary: details.summary, url: details.url,
                    },
                    analysis_result: {
                        legal_status, reviews_analyzed: total_reviews_analyzed,
                        sentiment_percentage: {
                            positive: parseFloat(perc_pos.toFixed(2)),
                            negative: parseFloat(perc_neg.toFixed(2)),
                            neutral: parseFloat(perc_neu.toFixed(2)),
                        },
                        sentiment_count: sentiment_distribution, recommendation: recommendation_text
                    }
                }).code(200);

            } catch (error) {
                console.error("Error in /analyze handler:", error);
                 // Tangani NotFoundError dari google-play-scraper secara spesifik
                 if (error instanceof NotFoundError || (error.message && error.message.includes('404'))) {
                     return h.response({ error: `Aplikasi atau detailnya tidak ditemukan di Google Play Store.` }).code(404);
                 }
                return h.response({ error: "Terjadi kesalahan internal saat memproses permintaan." }).code(500);
            }
        }
    });

     // Simpan instance server untuk digunakan kembali
    hapiServerInstance = server;

    // Kembalikan instance server Hapi
    return server;
};

/**
 * Fungsi handler utama untuk Vercel Serverless Function.
 * Vercel akan memanggil fungsi ini saat ada request ke /api/*
 */
module.exports = async (req, res) => {
    try {
        // Buat atau gunakan instance server Hapi
        const server = await createServer();

        // Gunakan listener server Hapi untuk menangani request
        // Hapi akan membaca request dari `req` dan menulis response ke `res`
        await server.listener(req, res);

    } catch (error) {
         console.error("Error in Vercel handler:", error);
         // Kirim response error jika ada masalah saat membuat server atau handling request
         if (!res.headersSent) {
             res.statusCode = 500;
             res.setHeader('Content-Type', 'application/json');
             res.end(JSON.stringify({ error: "Internal Server Error during request processing." }));
         }
    }
};
