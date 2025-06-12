'use strict';

const Hapi = require('@hapi/hapi');
const fs = require('fs').promises;
const path = require('path');
// --- PERBAIKAN IMPORT FINAL ---
// Mengakses properti 'default' dari modul yang diimpor
const gplay = require('google-play-scraper').default;
const { NotFoundError } = require('google-play-scraper').default; // Asumsi NotFoundError juga ada di dalam default


// Global object untuk menampung aset yang dimuat
const assets = {};

/**
 * Memuat semua file aset (JSON) dari folder /assets ke memori.
 */
const loadAssets = async () => {
    try {
        console.log("🚀 Memuat aset dari file JSON...");

        const assetsPath = path.join(__dirname, 'assets');

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
        console.error("❌ Gagal memuat aset penting! API tidak dapat berfungsi dengan benar.", error);
        process.exit(1);
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

/**
 * Fungsi utama server Hapi.
 */
const init = async () => {
    await loadAssets();

    const server = Hapi.server({
        port: process.env.PORT || 3000,
        host: '0.0.0.0'
    });

    server.route({
        method: 'GET',
        path: '/',
        handler: (request, h) => {
            return {
                message: "Selamat datang di API Rekomendasi Aplikasi Pinjol.",
                status: "ok",
                docs_url: "/analyze?app_name=nama_aplikasi"
            };
        }
    });

    server.route({
        method: 'GET',
        path: '/analyze',
        handler: async (request, h) => {
            const { app_name } = request.query;
            if (!app_name) {
                return h.response({ error: "Parameter 'app_name' tidak boleh kosong." }).code(400);
            }

            try {
                // 1. Scrape Play Store
                const searchResults = await gplay.search({ term: app_name, num: 1, lang: 'id', country: 'id' });
                
                if (!searchResults.length) {
                    return h.response({ error: `Aplikasi '${app_name}' tidak ditemukan.` }).code(404);
                }
                
                const details = await gplay.app({ appId: searchResults[0].appId, lang: 'id', country: 'id' });
                
                // 2. Cek Legalitas (DENGAN PERBAIKAN)
                const rawDeveloper = details.developer || '';
                
                // --- PERBAIKAN DIMULAI DI SINI ---
                // Normalisasi nama developer dengan lebih agresif agar cocok dengan data OJK
                // Menghapus tanda baca (seperti titik, koma) dan spasi berlebih
                const developer_clean = rawDeveloper
                    .toLowerCase()
                    .replace(/[.,]/g, '') // Hapus titik dan koma
                    .replace(/\s+/g, ' ')  // Ganti spasi ganda dengan spasi tunggal
                    .trim();
                // --- PERBAIKAN SELESAI ---

                let legal_status = 'unknown';
                if (assets.legal_companies_set.has(developer_clean)) {
                    legal_status = 'legal';
                } else if (assets.ilegal_developers_set.has(developer_clean)) {
                    legal_status = 'ilegal';
                }

                // 3. Ambil & Proses Ulasan
                let perc_pos = 0, perc_neg = 0, perc_neu = 0, total_reviews_analyzed = 0, sentiment_distribution = {};
                const reviewData = await gplay.reviews({ appId: details.appId, lang: 'id', country: 'id', sort: gplay.sort.NEWEST, num: 100 });
                
                if (reviewData.data && reviewData.data.length > 0) {
                    const reviewTexts = reviewData.data.map(r => r.text);
                    
                    // --- PERBAIKAN KECIL: Memanggil Stemmer dan Stopwords dari notebook ---
                    // Di JS, kita tidak punya Sastrawi, jadi kita lewati langkah-langkah itu
                    // dan hanya melakukan clean & normalize. Ini adalah kompromi yang kita buat.
                    const preprocessedTexts = reviewTexts.map(text => {
                        const cleaned = cleanText(text); // cleanText hanya hapus angka, tanda baca, spasi
                        return normalizeSlang(cleaned, assets.normalization_dict);
                    });
                    
                    const tfidfFeatures = transformTfidf(preprocessedTexts, assets.tfidf_vocab, assets.tfidf_idf_weights);
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
                    perc_positif: perc_pos, perc_negatif: perc_neg, avg_rating: details.score
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
                console.error(error);
                if (error.message && error.message.includes('404')) {
                    return h.response({ error: `Detail aplikasi tidak ditemukan di Play Store.` }).code(404);
                }
                return h.response({ error: "Terjadi kesalahan internal saat memproses permintaan." }).code(500);
            }
        }
    });

    await server.start();
    console.log('✅ Server Hapi berjalan di %s', server.info.uri);
};

process.on('unhandledRejection', (err) => {
    console.log(err);
    process.exit(1);
});

init();