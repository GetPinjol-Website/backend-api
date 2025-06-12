// api/index.js

'use strict';

const Hapi = require('@hapi/hapi');
const fs = require('fs').promises; // Gunakan fs.promises untuk baca file async
const path = require('path');

// --- HAPUS BARIS REQUIRE UNTUK google-play-scraper DI SINI ---
// const gplay = require('google-play-scraper').default;
// const { NotFoundError } = require('google-play-scraper').default;
// --- AKHIR BAGIAN HAPUS ---


// Global object untuk menampung aset dan prediktor yang dimuat/diinisialisasi
const assetsAndPredictor = {};

// Variabel untuk menyimpan modul google-play-scraper setelah diimport dinamis
let gplayModule = null;

// --- PERBAIKAN: DEKLARASI VARIABEL DI SINI ---
// Variabel untuk menyimpan instance server Hapi setelah inisialisasi pertama
let hapiServerInstance = null;
// --- AKHIR PERBAIKAN ---


/**
 * Memuat aset, mengimpor dependensi, dan menginisialisasi prediktor.
 */
const initialize = async () => {
    // Jika sudah terinisialisasi, gunakan cache
    if (assetsAndPredictor.legalCompaniesSet && assetsAndPredictor.predictor && gplayModule) {
        console.log("✅ Aset, dependensi, dan prediktor sudah dimuat/inisialisasi. Menggunakan cache.");
        return;
    }

    console.log("🚀 Memuat aset, mengimpor dependensi, dan menginisialisasi prediktor...");

    try {
        // Path disesuaikan jika diperlukan. Asumsi: api/index.js di folder api, model_assets di root.
        const assetsPath = path.join(__dirname, '..', 'model_assets'); // Sesuaikan path

        // Baca aset secara ASINKRON
        const legalitasDataRaw = await fs.readFile(path.join(assetsPath, 'legalitas_data.json'), 'utf8');
        const legalitasData = JSON.parse(legalitasDataRaw);
        assetsAndPredictor.legalCompaniesSet = new Set(legalitasData.legal_companies);
        assetsAndPredictor.ilegalDevelopersSet = new Set(legalitasData.ilegal_developers);
        assetsAndPredictor.sentimentMap = { 0: 'Negatif', 1: 'Netral', 2: 'Positif' }; // Dipindahkan dari global scope server.js

        console.log("✅ Aset berhasil dimuat.");

        // IMPORT DINAMIS google-play-scraper
        gplayModule = await import('google-play-scraper');
        console.log("✅ Modul google-play-scraper berhasil diimpor dinamis.");

        // Impor dan Inisialisasi Prediktor dari file lokal secara dinamis
         // Mengasumsikan SentimentPredictor di-export dari '../inference.js'
         // Karena inference.js mungkin juga CommonJS, kita require biasa.
         // Jika inference.js itu sendiri ESM, Anda butuh import() dinamis juga di sini.
        const { SentimentPredictor } = require('../inference'); // SESUAIKAN JIKA inference.js ADALAH ESM

        const predictor = new SentimentPredictor();
        await predictor.loadModel(); // Asumsikan loadModel ada di SentimentPredictor
        assetsAndPredictor.predictor = predictor;
        console.log("✅ Prediktor berhasil diinisialisasi.");

    } catch (error) {
        console.error("❌ Gagal menginisialisasi!", error);
        throw new Error("Failed to initialize essential components: " + error.message);
    }
};

// Pindahkan fungsi analyzeApp dan generateRecommendation dari server.js ke sini
function generateRecommendation(appData) {
    const { legal_status, perc_positif, perc_negatif, total_reviews } = appData;

    if (legal_status === 'ilegal') {
        return "Sangat Tidak Direkomendasikan (Terindikasi Ilegal oleh OJK)";
    }
    if (legal_status === 'unknown') {
        if (total_reviews > 0 && perc_positif > 60 && perc_negatif < 25) {
             return "Risiko Tinggi: Direkomendasikan berdasarkan sentimen, tetapi legalitas tidak terverifikasi.";
        }
        return "Risiko Tinggi (Legalitas Tidak Terverifikasi)";
    }

    if (legal_status === 'legal') {
        if (total_reviews === 0) {
            return "Pertimbangkan dengan Hati-hati (Tidak Ada Ulasan untuk Dianalisis)";
        }
        if (perc_positif > 60 && perc_negatif < 25) {
            return "Direkomendasikan";
        }
        if (perc_negatif > 40) {
            return "Tidak Direkomendasikan (Sentimen Negatif Tinggi)";
        }
        return "Pertimbangkan dengan Hati-hati";
    }

    return "Tidak Dapat Ditentukan";
}


// Fungsi analyzeApp diadaptasi
async function analyzeApp(appName, predictor, legalCompaniesSet, ilegalDevelopersSet, sentimentMap) {
    let appInfo;
    try {
        // Gunakan gplayModule yang sudah diimport dinamis
        const searchResults = await gplayModule.default.search({ term: appName, num: 1, lang: 'id', country: 'id' });
        if (!searchResults || searchResults.length === 0) {
            // Gunakan NotFoundError dari gplayModule jika perlu
            const { NotFoundError } = gplayModule.default;
             throw new NotFoundError(`Aplikasi '${appName}' tidak ditemukan di Play Store.`); // Lempar error 404
        }
        appInfo = searchResults[0];
    } catch (e) {
        // Tangani NotFoundError secara spesifik di catch handler route
        console.error(`Gagal mencari aplikasi '${appName}':`, e.message);
         // Lempar error untuk ditangani di handler route
        throw e;
    }

    const developerNameClean = appInfo.developer
        .trim()
        .toLowerCase()
        .replace(/[.,]/g, '')
        .replace(/\s\s+/g, ' ');

    let legal_status = 'unknown';
    if (legalCompaniesSet.has(developerNameClean)) {
        legal_status = 'legal';
    } else if (ilegalDevelopersSet.has(developerNameClean)) {
        legal_status = 'ilegal';
    }

    let reviewData;
    try {
        // Gunakan gplayModule
        reviewData = await gplayModule.default.reviews({
            appId: appInfo.appId,
            sort: gplayModule.default.sort.NEWEST, // Gunakan sort dari gplayModule
            num: 100,
            lang: 'id',
            country: 'id'
        });
    } catch (e) {
        console.error(`Gagal mengambil ulasan untuk ${appInfo.appId}:`, e.message);
        reviewData = { data: [] }; // Lanjutkan meskipun gagal ambil ulasan
    }

    const reviewTexts = reviewData.data.map(r => r.text);

    let sentimentCounts = { Negatif: 0, Netral: 0, Positif: 0 };
    let totalReviewsAnalyzed = 0;

    if (reviewTexts.length > 0) {
        reviewTexts.forEach(review => {
            const processedText = preprocessText(review);
            if (processedText) {
                const vector = vectorizeText(processedText);
                 // Gunakan prediktor yang sudah diinisialisasi
                const predictionIndex = predictor.predict(vector);
                const sentiment = sentimentMap[predictionIndex];
                sentimentCounts[sentiment]++;
            }
        });
        totalReviewsAnalyzed = Object.values(sentimentCounts).reduce((a, b) => a + b, 0);
    }

    const perc_positif = (sentimentCounts.Positif / totalReviewsAnalyzed) * 100 || 0;
    const perc_negatif = (sentimentCounts.Negatif / totalReviewsAnalyzed) * 100 || 0;
    const perc_netral = (sentimentCounts.Netral / totalReviewsAnalyzed) * 100 || 0;

    const recommendationData = {
        legal_status,
        perc_positif,
        perc_negatif,
        total_reviews: totalReviewsAnalyzed
    };
    const finalRecommendation = generateRecommendation(recommendationData);

    return {
        aplikasi: appInfo.title,
        developer: appInfo.developer,
        status_legalitas: legal_status,
        rating_playstore: appInfo.scoreText,
        rekomendasi: finalRecommendation,
        detail_analisis: {
            total_ulasan_dianalisis: totalReviewsAnalyzed,
            sentimen_positif: `${perc_positif.toFixed(1)}%`,
            sentimen_negatif: `${perc_negatif.toFixed(1)}%`,
            sentimen_netral: `${perc_netral.toFixed(1)}%`,
        }
    };
}


// --- Inisialisasi Server Hapi untuk Serverless ---
// Kita hanya mendefinisikan server dan routes, tidak menjalankannya dengan .start()
const createServerForVercel = async () => {
    // Jika server sudah dibuat, gunakan instance yang ada
     if (hapiServerInstance) { // Variabel ini sekarang dikenali
         console.log("✅ Menggunakan instance server Hapi yang sudah ada (untuk Vercel).");
         return hapiServerInstance;
     }

    // Panggil fungsi inisialisasi komponen
    await initialize();

    const server = Hapi.server({
        // Port dan host akan diatur oleh Vercel
        port: process.env.PORT,
        host: process.env.HOST,
        routes: {
            cors: true, // Atur CORS sesuai kebutuhan Anda
            // Tidak perlu konfigurasi files: relativeTo di sini, Vercel yang melayani statis
        }
    });

    // Tidak perlu server.register(Inert) di sini, Vercel yang melayani statis

    // Hapus route untuk melayani file statis /param*
    // server.route({ ... });

    // Route untuk analisis di `/api/analisis`
    server.route({
        method: 'GET',
        path: '/analisis', // Path relatif di dalam folder api (akan menjadi /api/analisis)
        handler: async (request, h) => {
            try {
                const { app_name } = request.query;

                if (!app_name || typeof app_name !== 'string') {
                    return h.response({ error: 'Query parameter "app_name" dibutuhkan dan harus berupa string.' }).code(400);
                }

                console.log(`🔍 Menganalisis aplikasi: "${app_name}"`);

                 // Panggil analyzeApp dengan komponen yang sudah diinisialisasi
                const result = await analyzeApp(
                    app_name,
                    assetsAndPredictor.predictor,
                    assetsAndPredictor.legalCompaniesSet,
                    assetsAndPredictor.ilegalDevelopersSet,
                    assetsAndPredictor.sentimentMap
                );

                // Tangani error 404 dari analyzeApp (jika analyzeApp mengembalikan objek { error: ... })
                 // Perlu disesuaikan jika analyzeApp melempar error NotFoundError
                // if (result.error) {
                //      return h.response({ error: result.error }).code(404);
                // }


                return h.response(result).code(200);

            } catch (error) {
                console.error('Error during analysis handler:', error);
                 // Tangani NotFoundError secara spesifik
                 const { NotFoundError } = gplayModule.default;
                 if (error instanceof NotFoundError) {
                      return h.response({ error: error.message }).code(404); // Kirim pesan error dari NotFoundError
                 }
                 // Tangani error lain
                return h.response({ error: 'An internal server error occurred.' }).code(500);
            }
        }
    });

    // Simpan instance server untuk digunakan kembali
     hapiServerInstance = server; // Variabel ini sekarang dikenali

    return server;
};

// --- Handler Utama untuk Vercel Serverless Function ---
// Vercel akan memanggil fungsi ini
module.exports = async (req, res) => {
    try {
        // Buat atau dapatkan instance server Hapi
        const server = await createServerForVercel();

        // Gunakan listener server Hapi untuk menangani request Vercel
        await server.listener(req, res);

    } catch (error) {
        console.error("Error in Vercel handler:", error);
        // Kirim response error jika ada masalah di luar handler route
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: "Internal Server Error during function execution." }));
        }
    }
};
