import fs from 'fs';
import path from 'path';
// --- FIX START ---
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --- FIX END ---


// --- Muat Vocabulary dan Bobot IDF ---
// These lines will now work correctly
const vocabulary = JSON.parse(fs.readFileSync(path.join(__dirname, 'model_assets', 'tfidf_vocabulary.json'), 'utf8'));
const idfWeights = JSON.parse(fs.readFileSync(path.join(__dirname, 'model_assets', 'tfidf_idf_weights.json'), 'utf8'));
const vocabSize = Object.keys(vocabulary).length;

/**
 * Menghitung Term Frequency (TF) dari sebuah dokumen (teks).
 * @param {string[]} tokens - Array kata-kata dari teks yang sudah diproses.
 * @returns {Map<string, number>} Peta dari kata ke frekuensinya.
 */
function calculateTF(tokens) {
    const termFrequencies = new Map();
    tokens.forEach(token => {
        termFrequencies.set(token, (termFrequencies.get(token) || 0) + 1);
    });
    return termFrequencies;
}

/**
 * Mengubah teks yang sudah diproses menjadi vektor TF-IDF.
 * @param {string} processedText - Teks yang sudah melalui preprocessText.
 * @returns {number[]} Vektor numerik TF-IDF.
 */
export function vectorizeText(processedText) {
    const tokens = processedText.split(' ').filter(Boolean);
    const numTokens = tokens.length;
    if (numTokens === 0) {
        return new Array(vocabSize).fill(0);
    }
    
    const termFrequencies = calculateTF(tokens);
    
    // Inisialisasi vektor dengan nol
    const vector = new Array(vocabSize).fill(0);

    // Hitung skor TF-IDF untuk setiap kata dalam vocabulary
    termFrequencies.forEach((freq, term) => {
        if (Object.hasOwn(vocabulary, term)) {
            const vocabIndex = vocabulary[term];
            const tf = freq / numTokens;
            const idf = idfWeights[term] || 0; // Ambil IDF berdasarkan kata

            vector[vocabIndex] = tf * idf;
        }
    });

    // Normalisasi L2 (opsional, tapi scikit-learn melakukannya secara default)
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
        return vector.map(val => val / norm);
    }
    
    return vector;
}