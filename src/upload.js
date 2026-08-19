// Config de multer compartida entre /report, /rescate (src/routes/web.js) y
// las rutas de mascotas (src/routes/pets.js). Un solo lugar para el límite de
// tamaño y el filtro de tipo — dos copias del mismo filtro es el primer sitio
// donde una se actualiza y la otra no.
const multer = require('multer');

// Un navegador no etiqueta con certeza lo que sube: una foto elegida en Files,
// recibida por WhatsApp o arrastrada desde escritorio llega seguido como
// application/octet-stream. Filtrar solo por esa etiqueta la descarta SIN
// error, y quien reporta ve "sube una foto" habiendo subido una. El veredicto
// real se deja a los bytes (src/photo.js); acá el filtro es solo una primera
// pasada barata.
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '').toLowerCase();
    cb(
      null,
      type.startsWith('image/') ||
        type === 'application/octet-stream' ||
        IMAGE_EXT.test(file.originalname || '')
    );
  }
});

module.exports = { upload, IMAGE_EXT };
