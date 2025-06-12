const { SentimentPredictor } = require('../inference');
const gplay = require('google-play-scraper');
const fetch = require('node-fetch');

exports.handler = async (event) => {
    const { app_name } = event.queryStringParameters || {};
    if (!app_name || typeof app_name !== 'string') {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Query parameter "app_name" dibutuhkan.' }),
        };
    }

    try {
        console.log(`🔍 Menganalisis aplikasi: "${app_name}"`);
        const predictor = new SentimentPredictor();
        await predictor.loadModel();
        const result = await analyzeApp(app_name, predictor);
        if (result.error) {
            return {
                statusCode: 404,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: result.error }),
            };
        }
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(result),
        };
    } catch (error) {
        console.error('Error during recommendation:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Internal server error' }),
        };
    }
};

async function analyzeApp(appName, predictor) {
    let appInfo;
    try {
        const searchResults = await gplay.default.search({ term: appName, num: 1, lang: 'id', country: 'id' });
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

    const legalitasData = await (await fetch('https://raw.githubusercontent.com/username/repo/main/model_assets/legalitas_data.json')).json();
    const legalCompaniesSet = new Set(legalitasData.legal_companies);
    const ilegalDevelopersSet = new Set(legalitasData.ilegal_developers);
    const sentimentMap = { 0: 'Negatif', 1: 'Netral', 2: 'Positif' };

    let legal_status = 'unknown';
    if (legalCompaniesSet.has(developerNameClean)) {
        legal_status = 'legal';
    } else if (ilegalDevelopersSet.has(developerNameClean)) {
        legal_status = 'ilegal';
    }

    let reviewData;
    try {
        reviewData = await gplay.default.reviews({
            appId: appInfo.appId,
            sort: gplay.default.sort.NEWEST,
            num: 100,
            lang: 'id',
            country: 'id'
        });
    } catch (e) {
        reviewData = { data: [] };
    }

    const { preprocessText, vectorizeText } = require('../preprocessing'); // Impor jika diperlukan
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
}