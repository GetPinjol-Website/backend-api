import gplay from 'google-play-scraper';

// Cetak seluruh objek gplay untuk melihat apa isinya
console.log('--- Objek gplay yang diimpor ---');
console.log(gplay);
console.log('--------------------------------');

// Cek tipe dari gplay dan propertinya
console.log(`Tipe dari gplay: ${typeof gplay}`);
console.log(`Apakah gplay.search sebuah fungsi? ${typeof gplay.search === 'function'}`);
console.log(`Apakah gplay.app sebuah fungsi? ${typeof gplay.app === 'function'}`);
console.log(`Apakah gplay.reviews sebuah fungsi? ${typeof gplay.reviews === 'function'}`);

// Jika gplay sendiri adalah sebuah fungsi, coba panggil dengan cara lain
if (typeof gplay === 'function') {
    console.log('Tampaknya "gplay" sendiri adalah sebuah fungsi.');
}