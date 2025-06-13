import Hapi from '@hapi/hapi';
import Inert from '@hapi/inert';
import { preprocessText } from './preprocessing.js';
import { vectorizeText } from './tfidf.js';
import { SentimentPredictor } from './inference.js';
// --- FIX START ---
// Impor seluruh default export ke dalam satu objek bernama 'gplay'
import gplay from 'google-play-scraper';
// --- FIX END ---
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const legalitasData = JSON.parse(fs.readFileSync(path.join(__dirname, 'model_assets', 'legalitas_data.json'), 'utf8'));
const legalCompaniesSet = new Set(legalitasData.legal_companies);
const ilegalDevelopersSet = new Set(legalitasData.ilegal_developers);

const sentimentMap = { 0: 'Negatif', 1: 'Netral', 2: 'Positif' };

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

async function analyzeApp(appName, predictor) {
    let appInfo;
    try {
        // --- FIX: Gunakan prefix gplay. ---
        const searchResults = await gplay.search({ term: appName, num: 1, lang: 'id', country: 'id' });
        if (!searchResults || searchResults.length === 0) {
            return { error: `Aplikasi '${appName}' tidak ditemukan di Play Store.` };
        }
        appInfo = searchResults[0];
    } catch (e) {
        return { error: `Gagal mencari aplikasi: ${e.message}` };
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
        // --- FIX: Gunakan prefix gplay. ---
        reviewData = await gplay.reviews({
            appId: appInfo.appId,
            // --- FIX: Gunakan prefix gplay. ---
            sort: gplay.sort.NEWEST, 
            num: 100, 
            lang: 'id',
            country: 'id'
        });
    } catch (e) {
        reviewData = { data: [] };
    }

    const reviewTexts = reviewData.data.map(r => r.text);
    
    let sentimentCounts = { Negatif: 0, Netral: 0, Positif: 0 };
    let totalReviewsAnalyzed = 0;
    
    if (reviewTexts.length > 0) {
        reviewTexts.forEach(review => {
            const processedText = preprocessText(review);
            if (processedText) {
                const vector = vectorizeText(processedText);
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

// --- Inisialisasi Server Hapi ---
const init = async () => {
    const server = Hapi.server({
        port: process.env.PORT || 3000,
        host: '0.0.0.0',
        routes: { 
            cors: true,
            files: {
                relativeTo: path.join(__dirname, 'public')
            }
        }
    });

    await server.register(Inert);

    const predictor = new SentimentPredictor();
    await predictor.loadModel();

    server.route({
        method: 'GET',
        path: '/{param*}',
        handler: {
            directory: {
                path: '.',
                redirectToSlash: true,
                index: true,
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/analisis',
        handler: async (request, h) => {
            try {
                const { app_name } = request.query;

                if (!app_name || typeof app_name !== 'string') {
                    return h.response({ error: 'Query parameter "app_name" dibutuhkan.' }).code(400);
                }

                console.log(`🔍 Menganalisis aplikasi dari URL: "${app_name}"`);
                const result = await analyzeApp(app_name, predictor);

                if (result.error) {
                    return h.response({ error: result.error }).code(404);
                }
                
                return h.response(result).code(200);

            } catch (error) {
                console.error('Error during recommendation:', error);
                return h.response({ error: 'An internal server error occurred.' }).code(500);
            }
        }
    });

    await server.start();
    console.log('Server running on %s', server.info.uri);
};

process.on('unhandledRejection', (err) => {
    console.log(err);
    process.exit(1);
});

init();