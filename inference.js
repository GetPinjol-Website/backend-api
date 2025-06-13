import * as tf from '@tensorflow/tfjs';
import fs from 'fs';
import path from 'path';
// --- FIX START ---
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --- FIX END ---


export class SentimentPredictor {
    constructor() {
        this.modelParams = null;
        this.weights = null;
        this.biases = null;
    }

    /**
     * Memuat parameter model dari file JSON.
     */
    async loadModel() {
        // This line will now work correctly
        const paramsPath = path.join(__dirname, 'model_assets', 'model_params.json');
        const paramsJson = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
        this.modelParams = paramsJson;

        // Ubah bobot dan bias menjadi tensor TensorFlow.js
        // Koefisien (bobot) dari scikit-learn adalah (n_classes, n_features)
        // Kita butuh (n_features, n_classes) untuk matMul, jadi kita transpose
        this.weights = tf.tensor2d(this.modelParams.coefficients).transpose();
        this.biases = tf.tensor1d(this.modelParams.intercepts);
        
        console.log('Model parameters loaded successfully.');
    }

    /**
     * Melakukan prediksi sentimen pada vektor TF-IDF.
     * @param {number[]} vector - Vektor TF-IDF dari teks.
     * @returns {number} Indeks kelas prediksi (0: Negatif, 1: Netral, 2: Positif).
     */
    predict(vector) {
        if (!this.modelParams) {
            throw new Error('Model is not loaded. Call loadModel() first.');
        }

        // tf.tidy() untuk membersihkan memori tensor secara otomatis
        return tf.tidy(() => {
            // Ubah vektor input menjadi tensor 2D (batch size 1)
            const inputTensor = tf.tensor2d([vector]);

            // Hitung logits: z = input * weights + biases
            const logits = tf.matMul(inputTensor, this.weights).add(this.biases);
            
            // Dapatkan kelas dengan skor tertinggi (argmax)
            const prediction = tf.argMax(logits, 1);
            
            // Kembalikan hasilnya sebagai angka biasa
            return prediction.dataSync()[0];
        });
    }
}